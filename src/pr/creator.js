const { getOctokitForAuth } = require('../github/client');
const queries = require('../db/queries');

/**
 * 创建 Pull Request
 * @param {object} opts { owner, repo, title, head, base, body, issueNumber, authContext }
 * @returns {Promise<object>} PR 对象
 */
async function createPullRequest({ owner, repo, title, head, base, body, issueNumber, authContext }) {
  const octokit = await getOctokitForAuth(authContext);

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    head,
    base,
    body: body,
    draft: false,
  });

  // 指派代码审核人（必须设置）
  const reviewerUsername = queries.getConfig('reviewer_username');
  if (!reviewerUsername) {
    throw new Error('未配置默认代码审核人（reviewer_username），无法创建 PR');
  }
  try {
    await octokit.pulls.requestReviewers({
      owner,
      repo,
      pull_number: pr.number,
      reviewers: [reviewerUsername],
    });
  } catch (err) {
    throw new Error(`指派审核人失败: ${err.message}`);
  }

  // 添加标签（忽略错误，标签不存在时会 404）
  if (issueNumber) {
    try {
      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: pr.number,
        labels: ['auto-fix'],
      });
    } catch (err) {
      console.warn(`[PR] 添加标签失败（忽略）: ${err.message}`);
    }
  }

  // 生成并添加 Review 报告
  const reviewReport = generateReviewReport({ pr, issueNumber });
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: reviewReport,
  });

  return pr;
}

/**
 * 生成 Review 报告
 */
function generateReviewReport({ pr, issueNumber }) {
  return `## 🤖 自动修复报告

### 关联 Issue
- Issue #${issueNumber || 'N/A'}

### PR 信息
- 标题: ${pr.title}
- 分支: \`${pr.head.ref}\` → \`${pr.base.ref}\`
- 修改文件数: ${pr.changed_files}
- 新增行数: +${pr.additions}
- 删除行数: -${pr.deletions}

### 审核要点
请重点检查以下内容：
1. 代码逻辑是否正确解决了 Issue 描述的问题
2. 是否引入了新的 bug 或副作用
3. 测试覆盖率是否充分
4. 代码风格是否符合项目规范

### 下一步
- ✅ 审核通过后，PR 将自动合并
- ❌ 如需修改，请在评论中说明具体修改意见

---
> 🤖 由 auto-fix-bug 自动生成`;
}

module.exports = { createPullRequest, generateReviewReport };
