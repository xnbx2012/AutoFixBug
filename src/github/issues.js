const { getOctokitForAuth } = require('./client');
const logger = require('../log/logger');

/**
 * 获取仓库的 Open Issues
 * @param {string} owner 仓库所有者
 * @param {string} repo 仓库名
 * @param {string|null} since 可选：仅获取此时间之后创建的 issue（ISO 字符串，本地时区语义）
 * @param {object|null} authContext { authType, owner, repo } — 用于 App 认证
 */
async function getOpenIssues(owner, repo, since = null, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  // 不再把 since 传给 GitHub API：GitHub 的 since 按 UTC 解析，而我们的 cursor 是
  // Shanghai 无时区格式，直接传会造成 8 小时偏差，导致新 issue 被漏掉。
  // 改为拉取全部 open issues，在 JS 端用 created_at 过滤。
  const options = { owner, repo, state: 'open', per_page: 100 };

  const { data: issues } = await octokit.issues.listForRepo(options);
  const filtered = issues.filter(issue => !issue.pull_request);
  logger.debug(`[Issues] getOpenIssues ${owner}/${repo}: raw=${issues.length}, filtered=${filtered.length}${since ? `, since=${since}` : ''}`);
  return filtered;
}

/**
 * 获取单个 Issue 详情
 */
async function getIssue(owner, repo, issue_number, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  const { data } = await octokit.issues.get({ owner, repo, issue_number });
  return data;
}

/**
 * 在 Issue 下发表评论
 */
async function addComment(owner, repo, issue_number, body, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  const { data } = await octokit.issues.createComment({
    owner, repo, issue_number, body
  });
  return data;
}

/**
 * 更新 Issue 下已存在的评论（编辑评论内容）
 */
async function updateComment(owner, repo, comment_id, body, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  const { data } = await octokit.issues.updateComment({
    owner, repo, comment_id, body
  });
  return data;
}

/**
 * 关闭 Issue
 */
async function closeIssue(owner, repo, issue_number, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  const { data } = await octokit.issues.update({
    owner, repo, issue_number, state: 'closed'
  });
  return data;
}

/**
 * 给 Issue 添加标签
 */
async function addLabels(owner, repo, issue_number, labels, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  await octokit.issues.addLabels({ owner, repo, issue_number, labels });
}

/**
 * 获取 Issue 的所有评论
 */
async function getComments(owner, repo, issue_number, since = null, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  const options = { owner, repo, issue_number, per_page: 100 };
  if (since) options.since = since;
  const { data } = await octokit.issues.listComments(options);
  return data;
}

module.exports = {
  getOpenIssues,
  getIssue,
  addComment,
  updateComment,
  closeIssue,
  addLabels,
  getComments,
};
