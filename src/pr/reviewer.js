const { getOctokitForAuth } = require('../github/client');

/**
 * 轮询等待 PR 审核状态
 * - 必须配置 reviewer_username
 * - "全部通过" 判定：所有 review 处于终态，且无 CHANGES_REQUESTED，所有 required 审核人的最新 review 都是 APPROVED
 * @param {string} owner 仓库所有者
 * @param {string} repo 仓库名
 * @param {number} prNumber PR 编号
 * @param {string} reviewerUsername 指定审核人用户名
 * @param {number} timeoutMs 超时时间（默认 7 天）
 * @param {number} checkIntervalMs 检查间隔（默认 2 分钟）
 * @param {object|null} authContext { authType, owner, repo }
/**
 * @returns {Promise<{status: 'approved'|'changes_requested'|'timeout'|'user_merged', feedback: string}>}
 */
async function waitForApproval(owner, repo, prNumber, reviewerUsername, timeoutMs = 7 * 24 * 60 * 60 * 1000, checkIntervalMs = 2 * 60 * 1000, authContext = null) {
  if (!reviewerUsername) {
    throw new Error('未配置默认代码审核人（reviewer_username），无法等待审核');
  }

  const octokit = await getOctokitForAuth(authContext);
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      // 获取 PR 详情（含合并状态、是否在草稿）
      const { data: pr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });

      // 草稿 PR 不需要查 review
      if (pr.draft) {
        await sleep(checkIntervalMs);
        continue;
      }

      // 用户已手动合并 PR → 视为任务成功
      if (pr.merged) {
        console.log(`[PR] PR #${prNumber} 已被手动合并 (by ${pr.merged_by?.login || 'unknown'})`);
        return {
          status: 'user_merged',
          feedback: `PR 已被 ${pr.merged_by?.login || '用户'} 手动合并`,
        };
      }

      // 获取所有审核记录
      const { data: reviews } = await octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
      });

      // 任意一条 CHANGES_REQUESTED 立即触发
      const lastChanges = [...reviews]
        .reverse()
        .find(r => r.state === 'CHANGES_REQUESTED');
      if (lastChanges) {
        console.log(`[PR] 审核要求修改: PR #${prNumber} (by ${lastChanges.user?.login})`);
        return {
          status: 'changes_requested',
          feedback: lastChanges.body || '',
        };
      }

      // 检查指定审核人是否已 APPROVED（取该用户最新一条 review）
      const reviewerReviews = reviews.filter(r => r.user?.login === reviewerUsername);
      const latestReviewerReview = reviewerReviews.length > 0
        ? reviewerReviews[reviewerReviews.length - 1]
        : null;

      if (latestReviewerReview && latestReviewerReview.state === 'APPROVED') {
        // 再次确认：除了指定审核人以外，没有其他人的最新 review 是 CHANGES_REQUESTED
        const stillChanging = reviews.some(r =>
          r.state === 'CHANGES_REQUESTED' &&
          r.user?.login !== reviewerUsername
        );
        if (!stillChanging) {
          console.log(`[PR] 审核全部通过: PR #${prNumber} (by ${reviewerUsername})`);
          return {
            status: 'approved',
            feedback: latestReviewerReview.body || '',
          };
        }
      }

      // 等待后再次检查
      await sleep(checkIntervalMs);
    } catch (err) {
      console.warn(`[PR] 检查审核状态失败: ${err.message}`);
      await sleep(checkIntervalMs);
    }
  }

  console.warn(`[PR] 审核超时: PR #${prNumber}`);
  return {
    status: 'timeout',
    feedback: '审核超时（7天）',
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { waitForApproval };
