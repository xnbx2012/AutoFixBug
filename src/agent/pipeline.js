const path = require('path');
const fs = require('fs');
const { config } = require('../config');
const { runAgent } = require('./runner');
const { decrypt } = require('../crypto/secrets');
const { getConfig } = require('../db/queries');
const { addComment, updateComment, closeIssue, getComments, getIssue } = require('../github/issues');
const { createPullRequest } = require('../pr/creator');
const { waitForApproval } = require('../pr/reviewer');
const { mergePullRequest, resolveConflicts, checkConflicts } = require('../pr/merger');
const { getAuthenticatedRepoUrl } = require('../github/app');
const queries = require('../db/queries');
const logger = require('../log/logger');

// ============ 评论更新辅助 ============

/**
 * 安全删除目录（Windows 下 git 进程可能短暂持锁，自动重试）
 */
function rmDirSafe(dirPath, retries = 5, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i < retries - 1 && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      } else {
        throw err;
      }
    }
  }
}

/**
 * 更新 issue 上的进度评论为最终状态
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @param {number|null} commentId
 * @param {string} status 'merged' | 'failed'
 * @param {object} opts { prUrl, summary, error }
 */
async function updateProgressComment(owner, repo, issueNumber, commentId, status, opts = {}, authContext = null) {
  if (!commentId) return;
  const body = status === 'merged'
    ? `✅ **Claude Code 已处理完此 Issue**\n\n自动修复已成功合并。\n- PR: ${opts.prUrl || '(未知)'}\n- 修复摘要: ${opts.summary || '无'}`
    : `❌ **Claude Code 处理此 Issue 失败**\n\n${opts.error || '处理过程中发生错误，请人工介入检查。'}`;
  try {
    await updateComment(owner, repo, commentId, body, authContext);
  } catch (err) {
    // 编辑评论失败则回退为新增评论
    try {
      await addComment(owner, repo, issueNumber, body, authContext);
    } catch (_) { /* 忽略 */ }
  }
}

// ============ 结构化输出 JSON Schema ============

/**
 * Agent 修复结果的 JSON Schema，通过 SDK outputFormat 强制 Agent 返回结构化数据
 * 避免自由文本解析失败导致的 "nothing_to_commit" 误判
 */
const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['in_progress', 'completed', 'need_info', 'no_code_change_needed', 'cannot_fix'],
    },
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests_passed: { type: 'boolean' },
    committed: { type: 'boolean' },
    pushed: { type: 'boolean' },
    pr_created: { type: 'boolean' },
    pr_number: { type: ['number', 'null'] },
    branch_name: { type: 'string' },
    issue_number: { type: 'number' },
    question_for_user: { type: ['string', 'null'] },
  },
  required: ['status', 'summary', 'files_changed', 'tests_passed', 'committed', 'pushed', 'pr_created', 'branch_name', 'issue_number'],
};

const OUTPUT_FORMAT = { type: 'json_schema', schema: FIX_RESULT_SCHEMA };

// ============ 并发控制 ============
let activeJobs = 0;
const jobQueue = [];

function resolveQueue() {
  while (jobQueue.length > 0 && activeJobs < config.maxConcurrentJobs) {
    const next = jobQueue.shift();
    next();
  }
}

function acquireSlot() {
  return new Promise((resolve) => {
    if (activeJobs < config.maxConcurrentJobs) {
      activeJobs++;
      resolve();
    } else {
      jobQueue.push(() => { activeJobs++; resolve(); });
    }
  });
}

function releaseSlot() {
  activeJobs--;
  resolveQueue();
}

// 处于"等待审核"阶段（已释放槽位）的前台监视器
const awaitingReviewLoops = new Map(); // jobId -> AbortSignal-like flag

/**
 * 主入口：分两阶段
 *  1) Phase A（占槽位）：clone → branch → analyze → fix → test → commit → push → create PR
 *  2) Phase B（释放槽位，异步执行）：等待审核 → 必要时按反馈再改 → 合并 → 关闭 issue
 *
 * Phase A 一旦提交 PR、状态变为 awaiting_review 就立即 releaseSlot，
 * 监视器即可在收到新 issue 时立刻开始处理下一个任务。
 */
async function processIssue(monitor, issue) {
  const issueNumber = issue.number;
  const issueTitle = issue.title;
  const issueBody = issue.body || '';
  const issueUrl = issue.html_url;
  const repoUrl = monitor.repo_url;
  const owner = monitor.owner;
  const repoName = monitor.repo_name;

  const branchName = `fix/issue-${issueNumber}`;
  const workDir = path.join(config.paths.repos, owner, repoName, String(issueNumber));

  // 构建 authContext：根据 monitor 的 auth_type 决定使用 PAT 还是 App 认证
  const authContext = monitor.auth_type === 'app'
    ? { authType: 'app', owner, repo: repoName }
    : { authType: 'user', owner, repo: repoName };

  // 从 monitor 提取自定义模型 / API Key / API 地址
  const agentOpts = buildAgentOpts(monitor);
  if (Object.keys(agentOpts).length > 0) {
    logger.info(`[Pipeline] Monitor#${monitor.id} 使用自定义 Agent 配置: model=${agentOpts.model || 'sonnet'}, baseURL=${agentOpts.apiBaseUrl || '(default)'}`);
  }

  // 先创建 job 拿到 id，再决定 log 路径（包含 id 便于排查）
  let job = queries.addJob({
    monitor_id: monitor.id,
    issue_number: issueNumber,
    issue_title: issueTitle,
    issue_url: issueUrl,
    branch_name: branchName,
    log_path: '', // 占位，下方更新
    status: 'pending',
  });

  const jobId = job.id;
  const jobDir = path.join(config.paths.logs, owner, repoName, String(jobId));
  const logPath = path.join(jobDir, `job-${jobId}.log`);
  const sessionPath = path.join(jobDir, `session-${jobId}.txt`);

  // 确保日志目录和文件存在，避免首次查看时报"日志文件不存在"
  try {
    fs.mkdirSync(jobDir, { recursive: true });
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');
  } catch (err) {
    logger.warn(`[Pipeline] Job#${jobId} 创建日志文件失败: ${err.message}`);
  }

  // 回写绝对路径到 db
  job = queries.updateJob(jobId, { log_path: logPath, session_path: sessionPath });

  // 创建任务级 logger：所有调用同时写入主日志和该 job 日志文件
  const jl = logger.forJob(logPath, `[Pipeline Job#${jobId}]`);

  // 等待并发槽位
  jl.info('等待执行槽位...');
  await acquireSlot();
  jl.info(`获取槽位，开始处理: Issue #${issueNumber} - ${issueTitle}`);

  const jobStartTime = Date.now();
  const totalTokens = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };

  // 在 issue 下发表"开始处理"评论，并保存 comment_id 以便后续编辑更新
  try {
    const startComment = await addComment(
      owner,
      repoName,
      issueNumber,
      `🤖 **Claude Code 正在处理此 Issue**\n\nAgent 已开始分析问题并尝试自动修复，完成后将在此评论更新结果。`,
      authContext
    );
    job = queries.updateJob(jobId, { issue_comment_id: startComment.id });
    jl.info(`已发表开始评论: comment_id=${startComment.id}`);
  } catch (commentErr) {
    // 评论失败不应阻止修复流程
    jl.warn(`发表开始评论失败（忽略）: ${commentErr.message}`);
  }

  try {
    // ====================== Phase A：占槽位阶段 ======================
    // Step 1: gh issue develop → clone issue 分支
    job = queries.updateJob(jobId, { status: 'cloning' });
    jl.info(`创建 Issue 分支并克隆: ${branchName}`);
    await gitCloneIssueBranch(repoUrl, issueNumber, branchName, workDir, authContext, monitor.default_branch);

    // Step 3: 调用 Agent 修复
    job = queries.updateJob(jobId, { status: 'analyzing' });
    jl.info('启动 Claude Code Agent 修复');

    const prompt = buildFixPrompt({
      issueNumber,
      issueTitle,
      issueBody,
      issueUrl,
      repoUrl,
      branchName,
    });

    let agentResult = await runAgent(prompt, workDir, (msg) => {
      if (msg.type === 'assistant' || msg.type === 'result') {
        jl.debug(`[Agent] ${JSON.stringify(msg).substring(0, 500)}`);
      }
    }, agentOpts, sessionPath, OUTPUT_FORMAT);
    accumulateTokens(totalTokens, agentResult);

    job = queries.updateJob(jobId, { status: 'fixing' });

    // 使用统一的结果解析入口（优先结构化输出，回退到文本解析）
    let parsed = processAgentResult(agentResult);

    // 处理 Agent 明确声明的非修复状态（不再走 git commit 验证，直接报错）
    if (parsed.status === 'no_code_change_needed' || parsed.status === 'cannot_fix') {
      const msg = `[${parsed.status}] ${parsed.summary || '(无摘要)'}`;
      jl.warn(`Agent 明确声明无需/无法修复: ${msg}`);
      throw new Error(msg);
    }

    // 处理 parse_failed：Agent 输出异常，首先检查是否有结构化输出失败回退，再进入诊断重试流程
    let agentOutputIsAmbiguous = (parsed.status === 'parse_failed');

    // 处理 Agent 修改了代码但没 commit 的情况（in_progress）
    // 通过同一会话发送"继续"推动 Agent 完成提交，避免误判为 nothing_to_commit
    if (parsed._source === 'structured_output' && !parsed.committed && parsed.files_changed.length > 0) {
      jl.info(`[Pipeline] Agent 已修改 ${parsed.files_changed.length} 个文件但未提交 (committed=false)，发送"继续"推动提交`);
      agentResult = await handleAgentNotCommitted(agentResult, workDir, agentOpts, sessionPath, jl, OUTPUT_FORMAT);
      accumulateTokens(totalTokens, agentResult);
      parsed = processAgentResult(agentResult);
    } else if (parsed.status === 'in_progress') {
      jl.info('[Pipeline] Agent 返回 in_progress（已修改未提交），发送"继续"推动提交');
      agentResult = await handleAgentNotCommitted(agentResult, workDir, agentOpts, sessionPath, jl, OUTPUT_FORMAT);
      accumulateTokens(totalTokens, agentResult);
      parsed = processAgentResult(agentResult);
    }

    // 如果 Agent 需要更多信息
    if (parsed.status === 'need_info' && parsed.question_for_user) {
      jl.info('Agent 需要更多信息，在 issue 下留言询问');
      job = queries.updateJob(jobId, { status: 'commenting' });

      const commentBody = `🤖 **自动修复助手** 需要更多信息\n\n${parsed.question_for_user}`;
      await addComment(owner, repoName, issueNumber, commentBody, authContext);

      // 等待回复（最多 24 小时，每 5 分钟检查一次）
      const reply = await waitForReply(owner, repoName, issueNumber, 24 * 60 * 60, 5 * 60, authContext);

      if (reply) {
        jl.info('收到新回复，重新启动 Agent');
        job = queries.updateJob(jobId, { status: 'fixing' });

        const continuePrompt = buildContinuePrompt({
          originalIssue: issueBody,
          agentQuestion: parsed.question_for_user,
          userReply: reply,
        });

        agentResult = await runAgent(continuePrompt, workDir, null, agentOpts, sessionPath, OUTPUT_FORMAT);
        accumulateTokens(totalTokens, agentResult);
        parsed = processAgentResult(agentResult);
        agentOutputIsAmbiguous = (parsed.status === 'parse_failed');
      } else {
        jl.warn('等待回复超时，标记为失败');
        throw new Error('等待用户回复超时');
      }
    }

    // Step 4（提前）: 对输出异常的 Agent，先用文件系统验证是否有实际改动再跑测试
    // 避免"Agent 没改任何文件但声称成功 → 白跑一遍测试 → 在 git commit 阶段才失败"
    if (agentOutputIsAmbiguous) {
      jl.warn(`Agent 输出无法解析（status=parse_failed），先检查是否有实际文件变更再决定是否继续`);
      job = queries.updateJob(jobId, { status: 'fixing' });

      const verification = await verifyAgentChanges(workDir, branchName, monitor.default_branch, agentResult.result, jl);
      if (!verification.hasChanges) {
        // 首次无变更，发起诊断重试
        jl.warn(`首轮 Agent 未产生任何代码变更，发起重试...`);
        const retryPrompt = buildRetryPrompt({
          issueTitle,
          lastAgentOutput: agentResult.result,
          uncommittedStatus: verification.uncommittedStatus,
          modifiedFiles: verification.modifiedFiles,
          commitCount: verification.commitCount,
        });

        const retryResult = await runAgent(retryPrompt, workDir, null, agentOpts, sessionPath, OUTPUT_FORMAT);
        accumulateTokens(totalTokens, retryResult);
        parsed = processAgentResult(retryResult);

        const retryVerification = await verifyAgentChanges(workDir, branchName, monitor.default_branch, retryResult.result, jl);
        if (!retryVerification.hasChanges) {
          // 重试仍无变更：把全部诊断信息 dump 到 job 日志，然后报错
          jl.error(`Agent 重试后仍未产生任何代码变更`);
          if (retryResult.result) {
            jl.error(`Agent 重试输出 (前 1000 字符): ${retryResult.result.substring(0, 1000)}`);
          }
          throw new Error(`Agent 未产生任何代码变更（重试后仍为空），请查看 job-${jobId}.log 中的 [verifyAgentChanges] 日志了解详情`);
        }
        agentOutputIsAmbiguous = false;
      } else {
        // 首次就有变更（Agent 改了文件但没输出合规 JSON）— 正常继续
        jl.info(`Agent 已有 ${verification.modifiedFiles.length} 个文件变更（尽管输出格式异常），继续流程`);
        agentOutputIsAmbiguous = false;
      }
    }

    // Step 4: 运行测试
    job = queries.updateJob(jobId, { status: 'testing' });
    jl.info('运行测试');
    await runTests(workDir);

    // Step 4.5: 验证代码变更
    // 如果 Agent 的结构化输出明确声明 committed=true，说明代码已提交。
    // 此时工作区干净是正常现象，严禁再执行 git add / git commit，也不应因 nothing_to_commit 失败。
    const agentCommitted = !!parsed.committed;
    if (agentCommitted) {
      jl.info(`Agent 已提交代码（committed=true, pushed=${parsed.pushed}, branch=${parsed.branch_name || branchName}），跳过文件系统变更验证`);
    } else {
      jl.info('验证代码变更...');
      const finalVerification = await verifyAgentChanges(workDir, branchName, monitor.default_branch, agentResult.result, jl);
      if (!finalVerification.hasChanges) {
        jl.error(`测试通过后检测到无任何代码变更，任务失败`);
        throw new Error(`Agent 未产生任何代码变更（nothing_to_commit）: 测试后验证失败，modified=${finalVerification.modifiedFiles.length}, commits=${finalVerification.commitCount}`);
      }
      jl.info(`验证通过: ${finalVerification.modifiedFiles.length} 个文件变更, ${finalVerification.commitCount} 个新增提交`);
    }

    // Step 5: 推送修复
    // Agent 已 commit 时只能直接 push，严禁再次 git add / git commit。
    if (agentCommitted && !parsed.pushed) {
      const pushBranch = parsed.branch_name || branchName;
      jl.info(`Agent 已 commit 但未 push，直接执行 git push: ${pushBranch}`);
      await gitPushOnly(workDir, pushBranch);
      jl.info('git push 完成');
    } else if (agentCommitted && parsed.pushed) {
      jl.info('Agent 已 commit 且已 push，跳过 push 步骤');
    } else {
      jl.info('提交并推送修复');
      const commitResult = await gitCommitAndPush(workDir, branchName, `Fix #${issueNumber}: ${issueTitle}`, monitor.default_branch);
      if (commitResult.skipped) {
        throw new Error(`Agent 未产生任何代码变更（${commitResult.reason}），无法提交修复`);
      }
    }

    // Step 6: 创建 PR
    job = queries.updateJob(jobId, { status: 'pr_created' });
    jl.info('创建 Pull Request');
    const pr = await createPullRequest({
      owner,
      repo: repoName,
      title: `fix: #${issueNumber} ${issueTitle}`,
      head: branchName,
      base: monitor.default_branch,
      body: buildPRDescription(issue, parsed),
      issueNumber,
      authContext,
    });

    job = queries.updateJob(jobId, {
      pr_number: pr.number,
      pr_url: pr.html_url,
      status: 'awaiting_review',
    });
    jl.info(`PR 已创建: ${pr.html_url}，进入异步审核阶段`);

    // ====================== 释放槽位 ======================
    // PR 已创建，不再占用并发槽位。监视器可以立即处理下一个 issue。
    releaseSlot();
    jl.info('释放执行槽位，可继续处理下一个 issue');

    // ====================== Phase B：异步审核/合并 ======================
    await runReviewAndMergePhase(jobId, job, monitor, issue, parsed, workDir, branchName, jl, authContext, jobStartTime, totalTokens, agentOpts);

  } catch (err) {
    jl.error(`失败: ${err.message}`);
    const failedJob = queries.updateJob(jobId, {
      status: 'failed',
      error_message: err.message,
      duration_ms: Date.now() - jobStartTime,
      input_tokens: totalTokens.inputTokens,
      output_tokens: totalTokens.outputTokens,
      cache_read_input_tokens: totalTokens.cacheReadInputTokens,
    });
    // Phase A 失败：更新 issue 进度评论
    if (failedJob && failedJob.issue_comment_id) {
      try {
        await updateProgressComment(
          owner,
          repoName,
          issueNumber,
          failedJob.issue_comment_id,
          'failed',
          { error: err.message },
          authContext
        );
      } catch (cErr) {
        jl.warn(`更新进度评论失败: ${cErr.message}`);
      }
    }
    releaseSlot();
  } finally {
    // 清理 Phase A 阶段的工作目录（如果 Phase B 还在跑，不能直接删；这里
    // 只针对已失败的早期阶段做清理。成功路径下的清理在 Phase B 内做）
    if (fs.existsSync(workDir)) {
      const freshJob = queries.getJob(jobId);
      if (freshJob && (freshJob.status === 'failed' || freshJob.status === 'merged')) {
        jl.info(`清理工作目录: ${workDir}`);
        try {
          rmDirSafe(workDir);
        } catch (err) {
          jl.warn(`清理失败: ${err.message}`);
        }
      }
    }
  }
}

/**
 * Phase B：等待审核 → 修改循环 → 合并 → 关闭 issue
 * 此阶段不占用并发槽位。
 */
async function runReviewAndMergePhase(jobId, job, monitor, issue, parsed, workDir, branchName, jl, authContext, jobStartTime, totalTokens, agentOpts = {}) {
  const issueNumber = issue.number;
  const issueTitle = issue.title;
  const owner = monitor.owner;
  const repoName = monitor.repo_name;

  // 回退：如果没传 jl，使用默认 logger（配合旧接口 / resumeJobPhaseB 场景）
  if (!jl) jl = logger.forJob(
    path.join(config.paths.logs, `job-${jobId}.log`),
    `[Pipeline Job#${jobId}]`
  );

  awaitingReviewLoops.set(jobId, { stopped: false });
  const loopState = awaitingReviewLoops.get(jobId);

  try {
    const MAX_REVIEW_ROUNDS = 3;
    let currentRound = 0;
    let merged = false;

    while (currentRound < MAX_REVIEW_ROUNDS && !merged && !loopState.stopped) {
      currentRound++;
      jl.info(`等待代码审核 (第 ${currentRound} 轮)`);

      const reviewerUsername = queries.getConfig('reviewer_username');
      const approval = await waitForApproval(owner, repoName, job.pr_number, reviewerUsername, undefined, undefined, authContext);

      // 中途被中断（例如服务关闭并完成清理）
      if (loopState.stopped) break;

      if (approval.status === 'approved') {
        job = queries.updateJob(jobId, { status: 'merging' });
        jl.info('审核通过，准备合并 PR');

        // 读取配置的合并方式（默认普通 merge）
        const mergeMethod = queries.getConfig('merge_method') || 'merge';
        jl.info(`合并方式: ${mergeMethod}`);

        // 合并前检查冲突，如有冲突且工作目录可用则尝试自动解决
        const hasConflict = await checkConflicts(owner, repoName, job.pr_number, authContext);
        if (hasConflict) {
          jl.warn('检测到 PR 存在冲突');
          if (workDir && fs.existsSync(workDir)) {
            jl.info('尝试自动解决冲突...');
            const resolved = await resolveConflicts(workDir, monitor.default_branch, branchName);
            if (!resolved) {
              jl.error('自动解决冲突失败，跳过合并，等待人工处理');
              job = queries.updateJob(jobId, {
                status: 'failed',
                error_message: 'PR 存在冲突且自动解决失败，需人工处理',
                duration_ms: Date.now() - jobStartTime,
                input_tokens: totalTokens.inputTokens,
                output_tokens: totalTokens.outputTokens,
                cache_read_input_tokens: totalTokens.cacheReadInputTokens,
              });
              await addComment(owner, repoName, job.pr_number,
                '⚠️ **自动合并失败：PR 存在冲突且自动解决失败**\n\n请人工处理冲突后重新触发合并。', authContext);
              break;
            }
            jl.info('冲突已自动解决，重新检查 PR 状态...');
            // 等待 GitHub 重新计算 mergeable 状态
            await new Promise(r => setTimeout(r, 5000));
            const stillConflict = await checkConflicts(owner, repoName, job.pr_number, authContext);
            if (stillConflict) {
              jl.error('推送后仍存在冲突，跳过合并');
              job = queries.updateJob(jobId, {
                status: 'failed',
                error_message: '推送后仍存在冲突',
                duration_ms: Date.now() - jobStartTime,
                input_tokens: totalTokens.inputTokens,
                output_tokens: totalTokens.outputTokens,
                cache_read_input_tokens: totalTokens.cacheReadInputTokens,
              });
              break;
            }
          } else {
            jl.error('工作目录不可用，无法自动解决冲突');
            job = queries.updateJob(jobId, {
              status: 'failed',
              error_message: 'PR 存在冲突且工作目录不可用',
              duration_ms: Date.now() - jobStartTime,
              input_tokens: totalTokens.inputTokens,
              output_tokens: totalTokens.outputTokens,
              cache_read_input_tokens: totalTokens.cacheReadInputTokens,
            });
            break;
          }
        }

        jl.info(`开始合并 PR #${job.pr_number}`);
        await mergePullRequest(owner, repoName, job.pr_number, mergeMethod, authContext);

        job = queries.updateJob(jobId, {
          status: 'merged',
          duration_ms: Date.now() - jobStartTime,
          input_tokens: totalTokens.inputTokens,
          output_tokens: totalTokens.outputTokens,
          cache_read_input_tokens: totalTokens.cacheReadInputTokens,
        });
        jl.info(`关闭 Issue #${issueNumber}`);
        await addComment(owner, repoName, issueNumber, `✅ **已自动修复**\n\nPR: ${job.pr_url}\n\nAgent 修复摘要: ${parsed.summary || '无'}`, authContext);
        await closeIssue(owner, repoName, issueNumber, authContext);

        jl.info(`完成: Issue #${issueNumber} 已修复并合并`);
        merged = true;

      } else if (approval.status === 'user_merged') {
        // PR 已被用户手动合并，跳过自动合并，直接标记成功
        jl.info('PR 已被用户手动合并，标记任务完成');
        job = queries.updateJob(jobId, {
          status: 'merged',
          duration_ms: Date.now() - jobStartTime,
          input_tokens: totalTokens.inputTokens,
          output_tokens: totalTokens.outputTokens,
          cache_read_input_tokens: totalTokens.cacheReadInputTokens,
        });
        jl.info(`关闭 Issue #${issueNumber}`);
        await addComment(owner, repoName, issueNumber, `✅ **PR 已被手动合并，任务完成**\n\nPR: ${job.pr_url}`, authContext);
        await closeIssue(owner, repoName, issueNumber, authContext);
        jl.info(`完成: Issue #${issueNumber} PR 已手动合并`);
        merged = true;

      } else if (approval.status === 'changes_requested') {
        if (currentRound >= MAX_REVIEW_ROUNDS) {
          jl.warn(`已达最大修改轮次 (${MAX_REVIEW_ROUNDS})，停止自动修复`);
          await addComment(owner, repoName, issueNumber, `⚠️ 自动修复已达最大修改轮次 (${MAX_REVIEW_ROUNDS})，请人工介入处理审核意见。\n\n审核反馈: ${approval.feedback}`, authContext);
          job = queries.updateJob(jobId, { status: 'failed', error_message: `达到最大修改轮次，需人工介入`, duration_ms: Date.now() - jobStartTime, input_tokens: totalTokens.inputTokens, output_tokens: totalTokens.outputTokens, cache_read_input_tokens: totalTokens.cacheReadInputTokens });
          break;
        }

        // 服务恢复模式下没有本地工作目录，无法执行代码修改循环。
        // 提示用户人工处理，然后停止等待。
        if (!workDir) {
          jl.warn('恢复模式下无工作目录，跳过自动修改。请人工处理审核反馈。');
          await addComment(owner, repoName, issueNumber, `⚠️ 服务在审核阶段被重启，自动修改循环不可用。请人工按以下反馈修改后重新触发。\n\n审核反馈: ${approval.feedback}`, authContext);
          job = queries.updateJob(jobId, { status: 'failed', error_message: '恢复模式下无工作目录，需人工处理审核反馈', duration_ms: Date.now() - jobStartTime, input_tokens: totalTokens.inputTokens, output_tokens: totalTokens.outputTokens, cache_read_input_tokens: totalTokens.cacheReadInputTokens });
          break;
        }

        jl.info(`审核要求修改 (第 ${currentRound} 轮)，重新启动 Agent`);
        job = queries.updateJob(jobId, { status: 'fixing' });

        const reviewPrompt = buildReviewPrompt({
          originalIssue: issue.body || '',
          reviewerFeedback: approval.feedback,
        });

        const agentResult = await runAgent(reviewPrompt, workDir, null, agentOpts, job.session_path, OUTPUT_FORMAT);
        accumulateTokens(totalTokens, agentResult);
        parsed = processAgentResult(agentResult);

        // 推动 Agent 提交审核修改（如返回 in_progress 或未 commit）
        if (parsed._source === 'structured_output' && !parsed.committed && parsed.files_changed.length > 0) {
          const continuedResult = await handleAgentNotCommitted(agentResult, workDir, agentOpts, job.session_path, jl, OUTPUT_FORMAT);
          accumulateTokens(totalTokens, continuedResult);
          parsed = processAgentResult(continuedResult);
        } else if (parsed.status === 'in_progress') {
          const continuedResult = await handleAgentNotCommitted(agentResult, workDir, agentOpts, job.session_path, jl, OUTPUT_FORMAT);
          accumulateTokens(totalTokens, continuedResult);
          parsed = processAgentResult(continuedResult);
        }

        // 重新运行测试
        job = queries.updateJob(jobId, { status: 'testing' });
        jl.info('重新运行测试');
        await runTests(workDir);

        // 重新推送修复
        const reviewAgentCommitted = !!parsed.committed;
        if (reviewAgentCommitted && !parsed.pushed) {
          const pushBranch = parsed.branch_name || branchName;
          jl.info(`审核修改后 Agent 已 commit 但未 push，直接执行 git push: ${pushBranch}`);
          await gitPushOnly(workDir, pushBranch);
        } else if (reviewAgentCommitted && parsed.pushed) {
          jl.info('审核修改后 Agent 已 commit 且已 push，跳过 push 步骤');
        } else {
          jl.info('重新提交修复');
          const reCommitResult = await gitCommitAndPush(workDir, branchName, `Fix #${issueNumber}: 根据审核意见修改 (round ${currentRound})`, monitor.default_branch);
          if (reCommitResult.skipped) {
            throw new Error(`审核修改后 Agent 未产生任何代码变更（${reCommitResult.reason}），无法重新提交`);
          }
        }

        // 通知审核人重新审核
        await addComment(owner, repoName, job.pr_number, `🤖 **已根据审核意见自动修改** (第 ${currentRound} 轮)\n\n请重新审核。`, authContext);
        job = queries.updateJob(jobId, { status: 'awaiting_review' });

      } else {
        jl.warn(`审核超时或状态异常: ${approval.status}`);
        await addComment(owner, repoName, issueNumber, `⚠️ 自动修复审核超时，请人工介入。`, authContext);
        job = queries.updateJob(jobId, { status: 'failed', error_message: `审核超时: ${approval.feedback}`, duration_ms: Date.now() - jobStartTime, input_tokens: totalTokens.inputTokens, output_tokens: totalTokens.outputTokens, cache_read_input_tokens: totalTokens.cacheReadInputTokens });
        break;
      }
    }
  } catch (err) {
    jl.error(`审核阶段失败: ${err.message}`);
    queries.updateJob(jobId, {
      status: 'failed',
      error_message: err.message,
      duration_ms: Date.now() - jobStartTime,
      input_tokens: totalTokens.inputTokens,
      output_tokens: totalTokens.outputTokens,
      cache_read_input_tokens: totalTokens.cacheReadInputTokens,
    });
  } finally {
    awaitingReviewLoops.delete(jobId);
    // 收尾清理工作目录
    if (fs.existsSync(workDir)) {
      jl.info(`清理工作目录: ${workDir}`);
      try {
        rmDirSafe(workDir);
      } catch (err) {
        jl.warn(`清理失败: ${err.message}`);
      }
    }

    // 更新 issue 上的进度评论为最终状态
    const finalJob = queries.getJob(jobId);
    if (finalJob && finalJob.issue_comment_id) {
      try {
        await updateProgressComment(
          owner,
          repoName,
          issueNumber,
          finalJob.issue_comment_id,
          finalJob.status === 'merged' ? 'merged' : 'failed',
          {
            prUrl: finalJob.pr_url,
            summary: parsed && parsed.summary,
            error: finalJob.error_message,
          },
          authContext
        );
      } catch (err) {
        jl.warn(`更新进度评论失败: ${err.message}`);
      }
    }
  }
}

/**
 * 仅根据已有 job 记录，从 awaiting_review 状态继续 Phase B（用于服务重启后的恢复）
 */
async function resumeJobPhaseB(job) {
  const monitor = queries.getMonitor(job.monitor_id);
  if (!monitor) {
    logger.warn(`[Pipeline Job#${job.id}] 监控不存在，跳过恢复`);
    return;
  }
  if (!job.pr_number) {
    logger.warn(`[Pipeline Job#${job.id}] 缺少 PR 信息，跳过恢复`);
    return;
  }

  // 构建 authContext
  const authContext = monitor.auth_type === 'app'
    ? { authType: 'app', owner: monitor.owner, repo: monitor.repo_name }
    : { authType: 'user', owner: monitor.owner, repo: monitor.repo_name };

  // 恢复时 job.log_path 已是绝对路径，直接使用
  const logPath = job.log_path || path.join(config.paths.logs, `job-${job.id}.log`);
  const jl = logger.forJob(logPath, `[Pipeline Job#${job.id}]`);

  // 不需要再 clone / 重新工作目录（重启时工作目录已清理），直接走 review loop
  jl.info(`恢复审核阶段: Issue #${job.issue_number} PR #${job.pr_number}`);

  // 伪造一份 issue 对象（足够 Phase B 内部使用）
  const issue = {
    number: job.issue_number,
    title: job.issue_title || '',
    body: '',
    html_url: job.issue_url || '',
  };

  const parsed = { summary: '', files_changed: [], tests_passed: true };

  // 通知 awaitApproval：实际实现可能需要从 GitHub 重新拉取最新评论。
  // Phase B 不依赖 workDir 中的代码（修改循环需要 workDir，但服务重启后已清空，
  // 因此此路径下只能监控审核状态而不能进入修改循环）。
  // 通过 workDir 设为 null 让 Phase B 跳过修改循环。
  const workDir = null;

  await runReviewAndMergePhase(job.id, job, monitor, issue, parsed, workDir, job.branch_name, jl, authContext, Date.now(), { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }, buildAgentOpts(monitor));
}

/**
 * 构建 PR 描述
 */
function buildPRDescription(issue, parsed) {
  return `## 🤖 自动修复

### 关联 Issue
Closes #${issue.number}

### 修复摘要
${parsed.summary || '详见代码变更'}

### 修改文件
${(parsed.files_changed || []).map(f => `- \`${f}\``).join('\n') || '详见 diff'}

### 测试结果
${parsed.tests_passed ? '✅ 测试通过' : '⚠️ 测试未通过，请人工验证'}

---
> 🤖 由 auto-fix-bug 自动修复`;
}

/**
 * 构建修复 prompt
 */
function buildFixPrompt(ctx) {
  return `## Issue 信息
- 编号: #${ctx.issueNumber}
- 标题: ${ctx.issueTitle}
- 内容:
${ctx.issueBody}
- 仓库: ${ctx.repoUrl}
- 分支: ${ctx.branchName}

## 成功标准（缺一不可）
1. 必须使用 Edit / Write / MultiEdit 工具实际修改至少一个源代码文件
2. 修改完成后必须运行项目测试（如 npm test）
3. **修改完成后必须执行 git add -A && git commit 提交代码**（不要 push，由外部流水线处理）

## 硬性约束
- **仅"阅读并解释问题"不算完成 —— 你必须修改代码**
- **修改代码后必须 git commit，这是硬性要求**。如果系统检测到你没有提交，会自动发送"继续"让你完成提交
- 不要 git push，push 由外部流水线处理
- 不要创建 PR，PR 由外部流水线处理
- 如果 issue 是纯文档/讨论且不需要改代码，将 status 设为 "no_code_change_needed"，并在 summary 中说明原因
- 如果 issue 信息不清晰无法动手修复，请将 status 设为 "need_info"，并在 question_for_user 中提问
- 如果 issue 需要修改但修改量太大或风险太高，请将 status 设为 "cannot_fix"，并在 summary 中说明原因

## 关于结构化输出
系统会要求你以 JSON 格式返回结果。请如实填写每个字段：
- status: 修改了代码但尚未 git commit 时为 "in_progress"；修改并已 commit 后为 "completed"
- committed: 如果你执行了 git commit 设为 true，否则设为 false
- pushed: 始终设为 false（不要 push）
- pr_created: 始终设为 false（不要创建 PR）
- branch_name: 填写 "${ctx.branchName}"
- issue_number: 填写 ${ctx.issueNumber}
- files_changed: 列出你实际修改的文件路径

## 你的任务
1. 先阅读项目结构和 CLAUDE.md 了解项目规范
2. 分析 issue，理解问题，定位涉及的代码文件
3. 使用 Edit / Write / MultiEdit 工具修复代码
4. 运行测试确认修复无误
5. **git add -A && git commit** 提交代码
6. 如实填写结构化输出 JSON
`;
}

/**
 * 构建继续修复 prompt（收到用户回复后）
 */
function buildContinuePrompt(ctx) {
  return `## 原始 Issue
${ctx.originalIssue}

## 你之前的问题
${ctx.agentQuestion}

## 用户回复
${ctx.userReply}

## 你的任务
根据用户回复继续修复问题。完成后如实填写结构化输出 JSON，记得执行 git add -A && git commit 提交代码。
`;
}

/**
 * 构建重试 prompt（Agent 未产生代码变更时，给一次自我修正的机会）
 */
function buildRetryPrompt(ctx) {
  return `## 系统检测
你刚刚声称已完成修复，但系统检测到当前分支上没有任何代码变更。

## 原始 Issue（摘要）
${ctx.issueTitle}

## 你上一次的输出
${ctx.lastAgentOutput ? ctx.lastAgentOutput.substring(0, 2000) : '(无)'}

## 检测事实
- 未提交变更: ${ctx.uncommittedStatus || '无'}
- 已提交但未 push 的文件: ${(ctx.modifiedFiles || []).join(', ') || '无'}
- 分支上的新增提交数: ${ctx.commitCount || 0}

## 你必须立即执行
1. 重新分析 issue，找到真正需要修改的代码位置
2. **使用 Edit / Write / MultiEdit 工具修改至少一个源代码文件**
3. 运行测试确认修复无误
4. 将修改提交到当前分支（git add -A && git commit）
5. 如实填写结构化输出 JSON

## 硬性约束（违反会导致任务失败）
- 仅"解释问题"不算完成，必须实际修改代码
- 修改后必须 commit，不要 push
`;
}

/**
 * 验证 Agent 实际产生的代码变更（用文件系统独立验证，不依赖 Agent 自报）
 * @returns {Promise<{hasChanges: boolean, modifiedFiles: string[], commitCount: number, uncommittedStatus: string, uncommittedLines: number}>}
 */
async function verifyAgentChanges(workDir, branchName, baseBranch, agentResultText, jl) {
  const { execFileSync } = require('child_process');

  // 确保在修复分支上
  let currentBranch = '';
  try {
    currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: workDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
    }).trim();
  } catch (_) { /* 忽略 */ }

  if (currentBranch !== branchName) {
    try {
      gitExec(workDir, ['checkout', branchName]);
    } catch (err) {
      jl.warn(`verifyAgentChanges: 切换分支失败: ${err.message}`);
    }
  }

  // 1. 未提交变更（git status --porcelain）
  let uncommittedStatus = '';
  let uncommittedLines = 0;
  try {
    uncommittedStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: workDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
    });
    uncommittedLines = uncommittedStatus.trim().split('\n').filter(Boolean).length;
  } catch (_) { /* 忽略 */ }

  // 2. 已提交但未 push 的提交数（相对 baseBranch）
  let commitCount = countAhead(workDir, 'HEAD', baseBranch);
  if (commitCount <= 0 && baseBranch) {
    const remoteCount = countAhead(workDir, 'HEAD', `origin/${baseBranch}`);
    if (remoteCount > 0) commitCount = remoteCount;
  }

  // 3. 本次新增/修改的文件清单（git diff baseBranch..HEAD --name-only）
  let modifiedFiles = [];
  try {
    const diffOut = execFileSync('git', ['diff', '--name-only', `${baseBranch}..HEAD`], {
      cwd: workDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
    });
    modifiedFiles = diffOut.trim().split('\n').filter(Boolean);
  } catch (_) { /* 忽略 */ }

  // 如果 diff --name-only 为空但 commitCount > 0，可能是新增的空提交；
  // 此时退而使用 git log --name-only 提取文件
  if (modifiedFiles.length === 0 && commitCount > 0) {
    try {
      const logOut = execFileSync('git', ['log', `${baseBranch}..HEAD`, '--name-only', '--pretty=format:'], {
        cwd: workDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
      });
      modifiedFiles = [...new Set(logOut.trim().split('\n').filter(Boolean))];
    } catch (_) { /* 忽略 */ }
  }

  // 4. 写入 job 日志（无论成功失败，都留下诊断信息）
  jl.info(`[verifyAgentChanges] 未提交变更行数: ${uncommittedLines}`);
  jl.info(`[verifyAgentChanges] 本地领先提交数: ${commitCount}`);
  jl.info(`[verifyAgentChanges] 修改文件清单: ${modifiedFiles.join(', ') || '(无)'}`);
  if (agentResultText) {
    jl.info(`[verifyAgentChanges] Agent 输出前 500 字符: ${agentResultText.substring(0, 500)}`);
  }

  const hasChanges = uncommittedLines > 0 || commitCount > 0 || modifiedFiles.length > 0;

  return {
    hasChanges,
    modifiedFiles,
    commitCount,
    uncommittedStatus: uncommittedStatus.trim(),
    uncommittedLines,
  };
}

/**
 * 构建审核修改 prompt
 */
function buildReviewPrompt(ctx) {
  return `## 原始 Issue
${ctx.originalIssue}

## 审核反馈
${ctx.reviewerFeedback}

## 你的任务
根据审核反馈修改代码。完成后如实填写结构化输出 JSON，记得执行 git add -A && git commit 提交代码。
`;
}

/**
 * 解析 Agent 结果：优先使用结构化输出，回退到文本解析
 * 这是 pipeline 中统一的结果处理入口，确保不会出现"Agent 已提交代码但被误判为空"的低级错误
 *
 * @param {object} agentResult runAgent 返回对象
 * @returns {object} 标准化的解析结果（包含 status, committed, pushed, pr_created 等字段）
 */
function processAgentResult(agentResult) {
  // 路径 1：SDK 结构化输出（最可靠）
  if (agentResult.structuredOutput) {
    const so = agentResult.structuredOutput;
    logger.info(`[Pipeline] 使用结构化输出 (status=${so.status}, committed=${so.committed}, pushed=${so.pushed})`);
    return {
      status: so.status || 'parse_failed',
      summary: so.summary || '',
      files_changed: so.files_changed || [],
      tests_passed: !!so.tests_passed,
      committed: !!so.committed,
      pushed: !!so.pushed,
      pr_created: !!so.pr_created,
      pr_number: so.pr_number ?? null,
      branch_name: so.branch_name || '',
      issue_number: so.issue_number || 0,
      question_for_user: so.question_for_user ?? null,
      _source: 'structured_output',
    };
  }

  // 路径 2：结构化输出验证失败，回退到文本解析
  if (agentResult.structuredOutputError === 'error_max_structured_output_retries') {
    logger.warn('[Pipeline] 结构化输出验证失败（达到最大重试次数），回退到文本解析');
    const fallback = parseAgentResult(agentResult.result);
    fallback._source = 'fallback_text_parse';
    fallback._structuredOutputFailed = true;
    fallback.committed = !!fallback.committed;
    fallback.pushed = !!fallback.pushed;
    fallback.pr_created = !!fallback.pr_created;
    fallback.pr_number = fallback.pr_number ?? null;
    fallback.branch_name = fallback.branch_name || '';
    fallback.issue_number = fallback.issue_number || 0;
    return fallback;
  }

  // 路径 3：无结构化输出（SDK 未返回或异常），回退到文本解析
  const fallback = parseAgentResult(agentResult.result);
  fallback._source = 'text_parse';
  fallback.committed = !!fallback.committed;
  fallback.pushed = !!fallback.pushed;
  fallback.pr_created = !!fallback.pr_created;
  fallback.pr_number = fallback.pr_number ?? null;
  fallback.branch_name = fallback.branch_name || '';
  fallback.issue_number = fallback.issue_number || 0;
  return fallback;
}

/**
 * 当 Agent 返回 in_progress（改了文件但未 commit）时，在同一会话中发送"继续"推动 Agent 提交
 * 通过 _resumeSessionId 实现 resume，避免开启新会话丢失上下文
 *
 * @param {object} lastResult 上一次 runAgent 返回对象（包含 sessionId）
 * @param {string} workDir   工作目录
 * @param {object} agentOpts Agent 配置
 * @param {string} sessionPath 会话记录路径
 * @param {object} jl        job logger
 * @param {object} outputFormat 结构化输出配置
 * @returns {Promise<object>} 最终的 agentResult
 */
async function handleAgentNotCommitted(lastResult, workDir, agentOpts, sessionPath, jl, outputFormat) {
  const MAX_CONTINUE_ATTEMPTS = 5;
  let currentResult = lastResult;

  for (let i = 0; i < MAX_CONTINUE_ATTEMPTS; i++) {
    if (!currentResult.sessionId) {
      jl.warn('[Pipeline] 无 sessionId，无法在同一会话发送"继续"，跳过');
      break;
    }

    jl.info(`[Pipeline] Agent 状态 in_progress，发送"继续" (${i + 1}/${MAX_CONTINUE_ATTEMPTS}), sessionId=${currentResult.sessionId}`);

    const continueResult = await runAgent(
      '继续',
      workDir,
      null,
      { ...agentOpts, _resumeSessionId: currentResult.sessionId },
      sessionPath,
      outputFormat,
    );
    accumulateTokens({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }, continueResult); // 仅用于累积 token
    currentResult = continueResult;

    const parsed = processAgentResult(continueResult);
    jl.info(`[Pipeline] "继续"后 Agent 返回: status=${parsed.status}, committed=${parsed.committed}, files=${parsed.files_changed.length}`);

    // Agent 已 commit，或者状态不再是 in_progress → 结束循环
    if (parsed.committed || parsed.status === 'completed') {
      jl.info('[Pipeline] "继续"后 Agent 已提交代码');
      return continueResult;
    }
    if (parsed.status !== 'in_progress') {
      jl.info(`[Pipeline] "继续"后 Agent 返回终态: ${parsed.status}`);
      return continueResult;
    }
  }

  jl.warn(`[Pipeline] "继续"重试 ${MAX_CONTINUE_ATTEMPTS} 次后 Agent 仍未提交，回退到文件系统检查`);
  return currentResult;
}

/**
 * 解析 Agent 返回的 JSON 结果
 * 注意：解析失败时不应默认 status=fixed —— 这会把所有"Agent 输出异常"伪装成"修复成功"
 *       进而导致 nothing_to_commit 这种延迟到 git 阶段才暴露的失败。
 *       兜底使用 status=parse_failed，由 verifyAgentChanges 进一步用文件系统独立验证。
 */
function parseAgentResult(resultText) {
  if (!resultText || !resultText.trim()) {
    return {
      status: 'parse_failed',
      summary: 'Agent 未返回任何文本结果',
      files_changed: [],
      tests_passed: false,
      question_for_user: null,
      _raw_output: resultText || '',
    };
  }
  try {
    const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
    return JSON.parse(resultText);
  } catch (err) {
    logger.warn(`[Pipeline] 无法解析 Agent 结果为 JSON（${err.message}），status 置为 parse_failed`);
    return {
      status: 'parse_failed',
      summary: `Agent 输出无法解析为 JSON。前 200 字符: ${resultText.substring(0, 200)}`,
      files_changed: [],
      tests_passed: false,
      question_for_user: null,
      _raw_output: resultText,
    };
  }
}

/**
 * Git Clone（使用 Token 认证，支持私有仓库）
 * 如果指定的 defaultBranch 不存在，自动 fallback 尝试 master/main
 */
async function gitClone(repoUrl, workDir, defaultBranch, authContext = null) {
  if (fs.existsSync(workDir)) {
    rmDirSafe(workDir);
  }
  fs.mkdirSync(workDir, { recursive: true });

  const authenticatedUrl = await getAuthenticatedUrl(repoUrl, authContext);

  const { execFileSync } = require('child_process');

  // 尝试 clone，失败时自动 fallback 到 master/main
  const branchesToTry = [defaultBranch];
  if (defaultBranch === 'main') branchesToTry.push('master');
  else if (defaultBranch === 'master') branchesToTry.push('main');

  // 网络相关错误的 stderr 特征（用于触发重试）
  const NETWORK_ERR_PATTERNS = [
    'Connection was reset',
    'Connection reset',
    'Connection timed out',
    'Could not resolve host',
    'Failed to connect',
    'empty response',
    'RPC failed',
    'The requested URL returned error',
    'SSL',
    'schannel',
    'OpenSSL',
  ];
  const isNetworkError = (stderr) =>
    NETWORK_ERR_PATTERNS.some((p) => stderr.includes(p));

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 5000;

  let lastErr;
  for (const branch of branchesToTry) {
    let attempts = 0;
    let success = false;
    while (attempts < MAX_RETRIES && !success) {
      try {
        execFileSync('git', ['clone', '--depth=1', `--branch=${branch}`, authenticatedUrl, workDir], {
          stdio: ['inherit', 'pipe', 'pipe'],
        });
        success = true;
        return; // 成功
      } catch (err) {
        lastErr = err;
        const stderr = (err.stderr || '').toString().trim();
        const isBranchErr =
          stderr.includes('not found') ||
          stderr.includes('not exist') ||
          stderr.includes('does not exist') ||
          stderr.includes('invalid');
        const isNetErr = isNetworkError(stderr) || isNetworkError(err.message || '');

        if (isBranchErr) {
          // 分支错误：跳出重试循环，尝试下一个分支
          break;
        }
        if (isNetErr && attempts < MAX_RETRIES - 1) {
          attempts++;
          logger.warn(
            `[Pipeline] git clone 网络错误，第 ${attempts}/${MAX_RETRIES - 1} 次重试 (branch=${branch}): ${stderr || err.message}`
          );
          if (fs.existsSync(workDir)) rmDirSafe(workDir);
          fs.mkdirSync(workDir, { recursive: true });
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempts));
          continue;
        }
        // 非网络错误或重试耗尽：抛出
        throw new Error(`git clone 失败 (exit ${err.status}): ${stderr || err.message}`);
      }
    }
    if (success) return;
    // 当前分支失败（分支错误导致），清理目录进入下一次循环
    if (fs.existsSync(workDir)) rmDirSafe(workDir);
    fs.mkdirSync(workDir, { recursive: true });
  }
  const stderr = (lastErr.stderr || '').toString().trim();
  throw new Error(`git clone 失败 (exit ${lastErr.status}): ${stderr || lastErr.message}`);
}

/**
 * 将 https://github.com/owner/repo 转换为带 Token 认证的 URL
 * @param {string} repoUrl 原始仓库 URL
 * @param {object|null} authContext { authType, owner, repo } authType='app' 时使用 GitHub App
 */
async function getAuthenticatedUrl(repoUrl, authContext = null) {
  try {
    if (authContext && authContext.authType === 'app') {
      // GitHub App：使用 installation token（由 getAuthenticatedRepoUrl 处理缓存与续期）
      return await getAuthenticatedRepoUrl(authContext.owner, authContext.repo);
    }
    const encrypted = getConfig('github_token');
    if (!encrypted) return repoUrl;
    const token = decrypt(encrypted);
    const url = new URL(repoUrl);
    url.username = 'x-access-token';
    url.password = token;
    return url.toString();
  } catch (err) {
    logger.warn(`[Pipeline] 无法获取认证 Token: ${err.message}`);
    return repoUrl;
  }
}

/**
 * 创建分支
 */
/**
 * 用 GitHub Token 认证 gh CLI，使其能执行 gh issue develop 等命令
 * @param {object|null} authContext { authType, owner, repo }
 */
async function authenticateGhCli(authContext) {
  const { execFileSync } = require('child_process');
  let token = null;

  if (authContext && authContext.authType === 'app') {
    const repoUrl = `https://github.com/${authContext.owner}/${authContext.repo}`;
    const authenticatedUrl = await getAuthenticatedRepoUrl(repoUrl);
    // 从 URL 中提取 token: https://x-access-token:<token>@github.com/owner/repo.git
    const parsedUrl = new URL(authenticatedUrl);
    token = parsedUrl.password;
  } else {
    const encrypted = getConfig('github_token');
    if (encrypted) token = decrypt(encrypted);
  }

  if (!token) throw new Error('无法获取 GitHub Token 用于 gh CLI 认证');

  // pipe token 到 stdin 完成 gh auth login
  execFileSync('gh', ['auth', 'login', '--with-token'], {
    input: token,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  logger.info('[Pipeline] gh CLI 认证成功');
}

/**
 * gh issue develop → git clone issue-specific branch
 *
 * 流程：
 * 1. 认证 gh CLI
 * 2. 用 gh issue develop 在远程创建关联 Issue 的分支
 * 3. git clone --depth=1 --single-branch 该分支
 */
async function gitCloneIssueBranch(repoUrl, issueNumber, branchName, workDir, authContext, defaultBranch = 'main') {
  const { execFileSync } = require('child_process');

  if (fs.existsSync(workDir)) {
    rmDirSafe(workDir);
  }
  fs.mkdirSync(workDir, { recursive: true });

  await authenticateGhCli(authContext);

  // Step 1: gh issue develop — 远程创建关联 Issue 的分支
  // 使用 -R 指定 repo（避免依赖 gh 的默认 repo 上下文）
  const repoFlag = `${authContext.owner}/${authContext.repo}`;
  logger.info(`[Pipeline] 执行 gh issue develop ${issueNumber} -R ${repoFlag} --name ${branchName}`);
  try {
    execFileSync('gh', ['issue', 'develop', String(issueNumber), '-R', repoFlag, '--name', branchName], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    // 分支已存在是正常情况（重试或恢复），不视为错误
    if (stderr && !stderr.toLowerCase().includes('already exists') && !stderr.toLowerCase().includes('already linked')) {
      throw new Error(`gh issue develop 失败: ${stderr || err.message}`);
    }
    logger.warn(`[Pipeline] gh issue develop 分支已存在（忽略）: ${stderr}`);
  }

  // Step 2: git clone — 克隆该特定分支（使用 token 认证）
  const authenticatedUrl = await getAuthenticatedUrl(repoUrl, authContext);
  execFileSync('git', ['clone', '--depth=1', '--single-branch', `--branch=${branchName}`, authenticatedUrl, workDir], {
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  // 设置 git user 配置
  execFileSync('git', ['config', 'user.name', 'auto-fix-bug[bot]'], { cwd: workDir, stdio: 'inherit', encoding: 'utf8' });
  execFileSync('git', ['config', 'user.email', 'auto-fix-bug@noreply.github.com'], { cwd: workDir, stdio: 'inherit', encoding: 'utf8' });

  // 额外拉取默认分支引用（用于 verifyAgentChanges 等 git diff 操作）
  try {
    execFileSync('git', ['fetch', 'origin', defaultBranch, '--depth=1'], {
      cwd: workDir, stdio: ['inherit', 'pipe', 'pipe'],
    });
    logger.info(`[Pipeline] 已拉取默认分支 ${defaultBranch} 引用`);
  } catch (_) {
    logger.warn(`[Pipeline] 拉取默认分支 ${defaultBranch} 引用失败（可能分支不存在或网络问题），继续`);
  }
}

/**
 * 执行 git 命令，捕获 stderr（stdio: inherit 只能看到 exitCode，看不到报错内容）
 */
function gitExec(workDir, args) {
  const { execFileSync } = require('child_process');
  try {
    return execFileSync('git', args, { cwd: workDir, stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (err) {
    // execFileSync 在 stdio pipe 模式下会把 stderr 放进 err.stderr
    const stderr = (err.stderr || '').toString().trim();
    err.gitStderr = stderr;
    throw err;
  }
}

/**
 * 计算左侧 ref（本地）领先于右侧 ref（基线）的提交数。
 * 若比较失败返回 -1。
 */
function countAhead(workDir, headRef, baseRef) {
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync(
      'git', ['rev-list', '--count', `${baseRef}..${headRef}`],
      { cwd: workDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }
    ).trim();
    return parseInt(out, 10) || 0;
  } catch (_) {
    return -1;
  }
}

/**
 * 直接推送已由 Agent 提交的分支。
 * 重要：此函数严禁执行 git add / git commit；Agent 已提交时只能 checkout + push。
 */
async function gitPushOnly(workDir, branchName) {
  const { execFileSync } = require('child_process');

  let currentBranch = '';
  try {
    currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: workDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
    }).trim();
  } catch (_) { /* 忽略，下面 checkout 会暴露真实问题 */ }

  if (currentBranch !== branchName) {
    try {
      gitExec(workDir, ['checkout', branchName]);
    } catch (err) {
      const stderr = err.gitStderr || err.message;
      throw new Error(`切换 Agent 返回分支失败 (branch=${branchName}, exit ${err.status}): ${stderr}`);
    }
  }

  try {
    gitExec(workDir, ['push', '-u', 'origin', branchName]);
    logger.info(`[Pipeline] 已直接推送 Agent 提交: origin/${branchName}`);
  } catch (err) {
    const stderr = err.gitStderr || err.message;
    throw new Error(`git push 失败 (branch=${branchName}, exit ${err.status}): ${stderr}`);
  }
}

/**
 * 提交并推送 — 适配 Agent 的多种完成状态：
 *  1) 工作区有未提交/未 push 改动
 *  2) Agent 已 git add 但未 commit
 *  3) Agent 已本地 commit 但未 push
 *  4) Agent 已 push（但本地 clone 仍可创建 PR）
 *  5) Agent 没有任何改动/提交 — 视为失败
 */
async function gitCommitAndPush(workDir, branchName, commitMessage, defaultBranch) {
  const { execFileSync } = require('child_process');

  // 确保在修复分支上（Agent 可能切换到默认分支或别的分支继续操作）
  let currentBranch = '';
  try {
    currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: workDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
    }).trim();
  } catch (_) { /* 忽略 */ }

  if (currentBranch !== branchName) {
    try {
      gitExec(workDir, ['checkout', branchName]);
    } catch (err) {
      const stderr = err.gitStderr || err.message;
      throw new Error(`切换修复分支失败 (exit ${err.status}): ${stderr}`);
    }
  }

  // git add -A：把工作区与暂存区都纳入提交
  execFileSync('git', ['add', '-A'], { cwd: workDir, stdio: 'inherit' });

  // 统计工作区中已暂存但未提交的内容；若已暂存，commit 也会包含进来
  let stagedOrModified = '';
  try {
    stagedOrModified = execFileSync('git', ['status', '--porcelain'], {
      cwd: workDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
    });
  } catch (_) { /* 忽略 */ }

  if (stagedOrModified && stagedOrModified.trim()) {
    try {
      gitExec(workDir, ['commit', '--cleanup=verbatim', '-m', commitMessage]);
    } catch (err) {
      // 可能是"nothing to commit"（极端竞态），落到下面的本地提交检查
      const stderr = (err.gitStderr || err.message || '').toString();
      logger.warn(`[Pipeline] git commit 未产生新提交（已忽略: ${stderr.split('\n')[0]}），将依赖已有本地提交`);
    }
  } else {
    logger.warn(`[Pipeline] 工作区干净：未发现未提交变更，可能 Agent 已自行 add/commit`);
  }

  // 重新拉取远端引用，避免之前一次跑留下的 origin/* 缓存误导 ahead/behind 判断
  if (defaultBranch) {
    try {
      execFileSync('git', ['fetch', 'origin', defaultBranch], {
        cwd: workDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
      });
    } catch (_) { /* 离线/无远端时允许失败 */ }
  }

  // 统计本地分支相对基线的领先提交数
  // 新工作流：从 origin/${branchName} clone，优先对比 origin/${branchName}
  const remoteBranch = `origin/${branchName}`;
  let ahead = countAhead(workDir, 'HEAD', remoteBranch);
  if (ahead <= 0) {
    ahead = countAhead(workDir, 'HEAD', defaultBranch);
  }
  if (ahead <= 0 && defaultBranch) {
    const remoteAhead = countAhead(workDir, 'HEAD', `origin/${defaultBranch}`);
    if (remoteAhead > 0) ahead = remoteAhead;
  }

  if (ahead <= 0) {
    // 补充诊断信息：即便 ahead=0，也检查一下是否有未暂存的变更（可能是 git add 失败）
    let diagnosticStatus = '';
    try {
      diagnosticStatus = execFileSync('git', ['status', '--porcelain'], {
        cwd: workDir, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
      }).trim();
    } catch (_) { /* 忽略 */ }
    const diagnosticHint = diagnosticStatus
      ? `（提示: 工作区有 ${diagnosticStatus.split('\n').filter(Boolean).length} 个未跟踪/未暂存文件，可能是 git add 失败）`
      : '（工作区干净，未找到任何待提交内容）';
    logger.warn(`[Pipeline] Agent 未产生任何代码变更，也没有可用于 PR 的本地提交。${diagnosticHint}`);
    logger.warn(`[Pipeline] git status --porcelain:\n${diagnosticStatus || '(空)'}`);
    return { skipped: true, reason: 'nothing_to_commit' };
  }

  // 远端分支是否存在
  const remoteRef = `refs/remotes/origin/${branchName}`;
  let hasRemoteBranch = false;
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', remoteRef], { cwd: workDir, stdio: 'ignore' });
    hasRemoteBranch = true;
  } catch (_) { /* 没有则视为 false */ }

  // 判断本地是否还需要 push：本地领先远端分支才需要 push
  let localAheadOfRemote = ahead;
  if (hasRemoteBranch) {
    const aheadOfRemote = countAhead(workDir, 'HEAD', `origin/${branchName}`);
    if (aheadOfRemote >= 0) localAheadOfRemote = aheadOfRemote;
  }

  if (localAheadOfRemote > 0) {
    try {
      gitExec(workDir, ['push', '-u', 'origin', branchName]);
      logger.info(`[Pipeline] 已推送 ${localAheadOfRemote} 个新提交到 origin/${branchName}`);
    } catch (err) {
      const stderr = err.gitStderr || err.message;
      throw new Error(`git push 失败 (exit ${err.status}): ${stderr}`);
    }
  } else {
    logger.info(`[Pipeline] 远端分支 origin/${branchName} 已包含本地提交，跳过 push`);
  }

  // 任务结束后回到默认分支，方便人工复盘/再触发
  if (defaultBranch) {
    try {
      execFileSync('git', ['checkout', defaultBranch], { cwd: workDir, stdio: 'inherit' });
    } catch (err) {
      logger.warn(`[Pipeline] 切回默认分支 ${defaultBranch} 失败: ${err.message}`);
    }
  }

  return { skipped: false, ahead };
}

/**
 * 运行测试
 */
async function runTests(workDir) {
  if (!workDir) {
    logger.warn(`[Pipeline] 工作目录为空，跳过测试（恢复模式）`);
    return;
  }
  try {
    const { execFileSync } = require('child_process');

    // 检查 package.json 是否存在 test 脚本
    const pkgPath = path.join(workDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts && pkg.scripts.test) {
          execFileSync('npm', ['test'], { cwd: workDir, stdio: 'inherit', timeout: 300000 });
          logger.info(`[Pipeline] 测试通过: npm test`);
          return;
        }
      } catch (err) {
        if (err.status) {
          throw new Error(`测试失败: npm test 退出码 ${err.status}`);
        }
      }
    }

    // 尝试其他语言的测试命令
    const testCommands = [
      { cmd: 'pytest', args: [], desc: 'Python pytest' },
      { cmd: 'go', args: ['test', './...'], desc: 'Go test' },
      { cmd: 'cargo', args: ['test'], desc: 'Rust cargo test' },
    ];

    for (const { cmd, args, desc } of testCommands) {
      try {
        execFileSync(cmd, args, { cwd: workDir, stdio: 'inherit', timeout: 300000 });
        logger.info(`[Pipeline] 测试通过: ${desc}`);
        return;
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        if (err.status) throw new Error(`测试失败: ${desc} 退出码 ${err.status}`);
      }
    }

    logger.warn(`[Pipeline] 未找到可运行的测试命令，跳过测试步骤`);
  } catch (err) {
    logger.error(`[Pipeline] 测试失败: ${err.message}`);
    throw new Error(`测试失败: ${err.message}`);
  }
}

/**
 * 等待 Issue 回复
 * @returns {string|null} 回复内容或 null（超时）
 */
async function waitForReply(owner, repo, issueNumber, timeoutMs, checkIntervalMs, authContext = null) {
  const startTime = Date.now();
  const initialComments = await getComments(owner, repo, issueNumber, null, authContext);
  const lastCommentTime = initialComments.length > 0
    ? new Date(initialComments[initialComments.length - 1].created_at).getTime()
    : startTime;

  while (Date.now() - startTime < timeoutMs) {
    await sleep(checkIntervalMs * 1000);

    const comments = await getComments(owner, repo, issueNumber, null, authContext);
    const newComments = comments.filter(c =>
      new Date(c.created_at).getTime() > lastCommentTime
    );

    if (newComments.length > 0) {
      logger.info(`[Pipeline] 发现 ${newComments.length} 条新回复`);
      return newComments[newComments.length - 1].body;
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 从 monitor 对象提取自定义 Agent 配置（模型名、API Key、Base URL）
 * api_key 需要解密
 */
function buildAgentOpts(monitor) {
  const opts = {};
  if (monitor.model_name) opts.model = monitor.model_name;
  if (monitor.api_key)     opts.apiKey = decrypt(monitor.api_key);
  if (monitor.api_base_url) opts.apiBaseUrl = monitor.api_base_url;
  return opts;
}

/**
 * 累加一次 runAgent 调用产生的 token 用量到总计数器
 */
function accumulateTokens(total, agentResult) {
  if (!agentResult) return;
  total.inputTokens += agentResult.inputTokens || 0;
  total.outputTokens += agentResult.outputTokens || 0;
  total.cacheReadInputTokens += agentResult.cacheReadInputTokens || 0;
}

module.exports = { processIssue, resumeJobPhaseB };
