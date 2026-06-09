const queries = require('../db/queries');
const { getComments } = require('../github/issues');
const logger = require('../log/logger');

const DEFAULT_TRIGGER = '@cc';

/**
 * 获取当前配置的触发@名称
 * - 未设置：返回默认 @cc
 * - 设置为空字符串：返回 null，表示关闭@触发（所有 issue/评论均放行）
 * - 否则：返回规范化的 mention（统一加 @ 前缀、转小写）
 */
function getTriggerMention() {
  const raw = queries.getConfig('trigger_mention');
  if (raw === null || raw === undefined) return DEFAULT_TRIGGER; // 默认 @cc
  if (typeof raw === 'string' && raw.trim() === '') return null;  // 显式清空 = 关闭
  const m = raw.trim();
  return m.startsWith('@') ? m.toLowerCase() : `@${m.toLowerCase()}`;
}

/**
 * 判断 text 中是否包含指定的 mention
 *  - 大小写不敏感
 *  - 边界匹配：mention 前后必须是空白、标点、@ 或字符串起始/结束
 */
function textMentions(text, mention) {
  if (!text || !mention) return false;
  const m = mention.toLowerCase();
  const handle = m.replace(/^@/, '');
  const esc = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`@${esc}(?![a-zA-Z0-9_-])`, 'i');
  return re.test(text);
}

/**
 * 检查 issue 是否被 mention 触发
 * 检查范围：issue 标题、issue 内容、issue 全部评论
 *
 * @param {string} owner
 * @param {string} repo
 * @param {object} issue GitHub issue 对象（.number / .title / .body）
 * @param {string|null} mention 已规范化的 mention（含 @），null 表示关闭过滤
 * @param {object|null} authContext { authType, owner, repo }
 * @returns {Promise<boolean>}
 */
async function issueTriggeredByMention(owner, repo, issue, mention, authContext = null) {
  const debug = await getIssueMentionDebug(owner, repo, issue, mention, authContext);
  return debug.matched;
}

/**
 * 收集 mention 过滤的详细调试信息（命中位置、评论数、错误等）
 * 不抛错，异常均收敛到 commentFetchError 字段
 */
async function getIssueMentionDebug(owner, repo, issue, mention, authContext = null) {
  const result = {
    mention,
    titleMatched: false,
    bodyMatched: false,
    commentMatched: false,
    matchedCommentIds: [],
    commentCount: 0,
    commentFetchError: null,
    matched: !mention,
  };
  if (!mention) return result;
  result.titleMatched = textMentions(issue.title, mention);
  result.bodyMatched = textMentions(issue.body, mention);
  try {
    const comments = await getComments(owner, repo, issue.number, null, authContext);
    result.commentCount = comments.length;
    result.matchedCommentIds = comments
      .filter(c => textMentions(c.body, mention))
      .map(c => c.id);
    result.commentMatched = result.matchedCommentIds.length > 0;
  } catch (err) {
    result.commentFetchError = err.message;
    logger.warn(`[Mention] 拉取 Issue #${issue.number} 评论失败: ${err.message}`);
  }
  result.matched = result.titleMatched || result.bodyMatched || result.commentMatched;
  return result;
}

/**
 * 检查发送者是否在允许的触发人列表中
 * - allowedTriggerUsers 为 null/空字符串：不限制，返回 true
 * - 否则解析逗号分隔的用户名列表，大小写不敏感匹配
 */
function isUserAllowed(senderLogin, allowedTriggerUsers) {
  if (!allowedTriggerUsers || allowedTriggerUsers.trim() === '') return true;
  const allowed = allowedTriggerUsers.split(',').map(u => u.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(senderLogin.toLowerCase());
}

module.exports = {
  getTriggerMention,
  textMentions,
  issueTriggeredByMention,
  getIssueMentionDebug,
  isUserAllowed,
  DEFAULT_TRIGGER,
};
