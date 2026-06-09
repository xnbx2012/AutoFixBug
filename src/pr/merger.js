const { getOctokitForAuth } = require('../github/client');
const queries = require('../db/queries');
const logger = require('../log/logger');

/**
 * 合并 Pull Request
 * @param {string} owner 仓库所有者
 * @param {string} repo 仓库名
 * @param {number} prNumber PR 编号
 * @param {string} mergeMethod 合并方式 ('merge' | 'squash' | 'rebase')
 * @param {object|null} authContext { authType, owner, repo }
 * @returns {Promise<object>} 合并结果
 */
async function mergePullRequest(owner, repo, prNumber, mergeMethod = 'merge', authContext = null) {
  const octokit = await getOctokitForAuth(authContext);

  try {
    // 先检查是否有冲突
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    if (pr.mergeable === false) {
      throw new Error('PR 存在冲突，无法自动合并');
    }

    // 执行合并
    const { data: mergeResult } = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: mergeMethod,
      commit_title: `Merge PR #${prNumber} (auto-fix)`,
      commit_message: `Automatically merged by auto-fix-bug`,
    });

    if (!mergeResult.merged) {
      throw new Error(`合并失败: ${mergeResult.message}`);
    }

    console.log(`[PR] 合并成功: PR #${prNumber}, SHA: ${mergeResult.sha}`);
    return mergeResult;
  } catch (err) {
    console.error(`[PR] 合并失败: PR #${prNumber}, ${err.message}`);
    throw err;
  }
}

/**
 * 检测并尝试自动解决冲突
 * - 先 fetch origin
 * - 然后 merge origin/<base> 到当前分支（保留当前分支的变更）
 * - 自动 commit 并 push
 * @param {string} workDir 本地工作目录
 * @param {string} baseBranch 目标分支名（如 main）
 * @param {string} headBranch 当前分支名
 * @returns {Promise<boolean>} true=已解决并推送, false=仍有冲突需人工处理
 */
async function resolveConflicts(workDir, baseBranch, headBranch) {
  const { execFileSync } = require('child_process');

  try {
    // 获取最新远程分支
    execFileSync('git', ['fetch', 'origin', baseBranch], { cwd: workDir, stdio: 'inherit' });

    // 尝试 merge origin/baseBranch 到当前分支（保留 ours）
    try {
      execFileSync('git', ['merge', `origin/${baseBranch}`, '-X', 'ours', '--no-edit'], {
        cwd: workDir,
        stdio: 'inherit',
      });
    } catch (mergeErr) {
      // merge 有冲突，尝试自动保留当前分支内容
      logger.warn(`[PR] 自动 merge 遇到冲突，尝试自动解决（保留当前分支内容）`);

      // 获取冲突文件列表
      const conflicts = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
        cwd: workDir,
        encoding: 'utf8',
      }).trim().split('\n').filter(Boolean);

      if (conflicts.length === 0) {
        logger.warn(`[PR] 未检测到冲突文件，可能 merge 因其他原因失败`);
        return false;
      }

      for (const file of conflicts) {
        // 使用 --ours 保留当前分支（headBranch）的内容
        execFileSync('git', ['checkout', '--ours', file], { cwd: workDir, stdio: 'inherit' });
        execFileSync('git', ['add', file], { cwd: workDir, stdio: 'inherit' });
      }

      // 提交 merge
      execFileSync('git', ['commit', '-m', `Merge ${baseBranch} into ${headBranch} (auto-resolve conflicts)`], {
        cwd: workDir,
        stdio: 'inherit',
      });
    }

    // 推送
    execFileSync('git', ['push', 'origin', headBranch], { cwd: workDir, stdio: 'inherit' });
    logger.info(`[PR] 冲突已自动解决并推送: ${headBranch}`);
    return true;
  } catch (err) {
    logger.error(`[PR] 自动解决冲突失败: ${err.message}`);
    return false;
  }
}

/**
 * 检测 PR 是否有冲突（不解决）
 */
async function checkConflicts(owner, repo, prNumber, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);

  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return pr.mergeable === false;
}

module.exports = { mergePullRequest, resolveConflicts, checkConflicts };
