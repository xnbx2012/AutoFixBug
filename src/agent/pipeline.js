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
    // Step 1: Clone 仓库
    job = queries.updateJob(jobId, { status: 'cloning' });
    jl.info(`克隆仓库到 ${workDir}`);
    await gitClone(repoUrl, workDir, monitor.default_branch, authContext);

    // Step 2: 创建修复分支
    job = queries.updateJob(jobId, { status: 'branching' });
    jl.info(`创建分支: ${branchName}`);
    await gitCreateBranch(workDir, branchName);

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
    }, agentOpts, sessionPath);
    accumulateTokens(totalTokens, agentResult);

    job = queries.updateJob(jobId, { status: 'fixing' });

    let parsed = parseAgentResult(agentResult.result);

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

        agentResult = await runAgent(continuePrompt, workDir, null, agentOpts, sessionPath);
        accumulateTokens(totalTokens, agentResult);
        parsed = parseAgentResult(agentResult.result);
      } else {
        jl.warn('等待回复超时，标记为失败');
        throw new Error('等待用户回复超时');
      }
    }

    // Step 4: 运行测试
    job = queries.updateJob(jobId, { status: 'testing' });
    jl.info('运行测试');
    await runTests(workDir);

    // Step 5: 提交并推送
    jl.info('提交并推送修复');
    const commitResult = await gitCommitAndPush(workDir, branchName, `Fix #${issueNumber}: ${issueTitle}`, monitor.default_branch);
    if (commitResult.skipped) {
      throw new Error(`Agent 未产生任何代码变更（${commitResult.reason}），无法提交修复`);
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

        const agentResult = await runAgent(reviewPrompt, workDir, null, agentOpts, job.session_path);
        accumulateTokens(totalTokens, agentResult);
        parsed = parseAgentResult(agentResult.result);

        // 重新运行测试
        job = queries.updateJob(jobId, { status: 'testing' });
        jl.info('重新运行测试');
        await runTests(workDir);

        // 重新提交并推送
        jl.info('重新提交修复');
        await gitCommitAndPush(workDir, branchName, `Fix #${issueNumber}: 根据审核意见修改 (round ${currentRound})`, monitor.default_branch);

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

## 你的任务
1. 先阅读项目结构和 CLAUDE.md 了解项目规范
2. 分析 issue，理解问题
3. 如果 issue 信息不清楚，在 issue 下留言询问（使用 Bash + gh 命令）
4. 定位问题代码并修复
5. 运行测试确认修复无误
6. 完成后，输出结构化 JSON 结果

## 输出格式（修复完成后必须输出）
\`\`\`json
{
  "status": "fixed" | "need_info",
  "summary": "修复摘要",
  "files_changed": ["file1.js", "file2.js"],
  "tests_passed": true | false,
  "question_for_user": "如果需要信息，写在这里，否则为 null"
}
\`\`\`
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
根据用户回复继续修复问题。完成后输出结构化 JSON 结果。
`;
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
根据审核反馈修改代码。完成后输出结构化 JSON 结果。
`;
}

/**
 * 解析 Agent 返回的 JSON 结果
 */
function parseAgentResult(resultText) {
  try {
    const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
    return JSON.parse(resultText);
  } catch (err) {
    logger.warn(`[Pipeline] 无法解析 Agent 结果，使用默认值`);
    return {
      status: 'fixed',
      summary: resultText.substring(0, 500),
      files_changed: [],
      tests_passed: false,
      question_for_user: null,
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
async function gitCreateBranch(workDir, branchName) {
  const { execFileSync } = require('child_process');
  execFileSync('git', ['config', 'user.name', 'auto-fix-bug[bot]'], { cwd: workDir, stdio: 'inherit' });
  execFileSync('git', ['config', 'user.email', 'auto-fix-bug@noreply.github.com'], { cwd: workDir, stdio: 'inherit' });
  execFileSync('git', ['checkout', '-b', branchName], { cwd: workDir, stdio: 'inherit' });
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

  // 统计本地分支相对基线的领先提交数；尝试 local defaultBranch → origin/defaultBranch
  let ahead = countAhead(workDir, 'HEAD', defaultBranch);
  if (ahead <= 0 && defaultBranch) {
    const remoteAhead = countAhead(workDir, 'HEAD', `origin/${defaultBranch}`);
    if (remoteAhead > 0) ahead = remoteAhead;
  }

  if (ahead <= 0) {
    logger.warn(`[Pipeline] Agent 未产生任何代码变更，也没有可用于 PR 的本地提交`);
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
