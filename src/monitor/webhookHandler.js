const { verifyWebhookSignature } = require('../github/webhook');
const queries = require('../db/queries');
const logger = require('../log/logger');
const { getTriggerMention, getIssueMentionDebug, isUserAllowed } = require('../github/mention');

/**
 * 处理 GitHub Webhook 请求
 * @param {object} req Express 请求对象
 * @param {object} res Express 响应对象
 * @param {function} onNewIssue 新 issue 回调
 */
async function handleWebhook(req, res, onNewIssue) {
  const monitorId = parseInt(req.params.monitorId, 10);
  const monitor = queries.getMonitor(monitorId);

  if (!monitor) {
    return res.status(404).json({ error: 'Monitor not found' });
  }

  // 签名验证使用原始 Buffer（express.raw 中间件让 req.body 为 Buffer）
  const signature = req.headers['x-hub-signature-256'];
  const rawBody = req.body;

  if (!monitor.webhook_secret) {
    logger.warn(`[Webhook #${monitorId}] 未配置 webhook_secret，跳过签名验证`);
  } else if (!verifyWebhookSignature(rawBody, signature, monitor.webhook_secret)) {
    logger.error(`[Webhook #${monitorId}] 签名验证失败`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 解析 JSON payload（签名验证用原始 Buffer，业务逻辑用解析后的对象）
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.error(`[Webhook #${monitorId}] JSON 解析失败: ${err.message}`);
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  // 仅处理 issues 和 issue_comment 事件
  const event = req.headers['x-github-event'];

  logger.debug(`[Webhook #${monitorId}] Received webhook: event=${event || 'unknown'}, action=${payload.action || 'unknown'}, sender=${payload.sender && payload.sender.login ? payload.sender.login : 'unknown'}, repo=${payload.repository && payload.repository.full_name ? payload.repository.full_name : `${monitor.owner}/${monitor.repo_name}`}`);

  let issue;

  if (event === 'issues') {
    const action = payload.action;
    if (action !== 'opened') {
      logger.debug(`[Webhook #${monitorId}] 忽略非 opened 动作: ${action}`);
      return res.status(200).json({ message: 'Ignored' });
    }
    issue = payload.issue;
    logger.info(`[Webhook #${monitorId}] 收到新 issue: #${issue.number} - ${issue.title}`);
  } else if (event === 'issue_comment') {
    // 评论事件：用户在 issue/PR 下评论时触发，仅处理 created 动作
    const action = payload.action;
    if (action !== 'created') {
      logger.debug(`[Webhook #${monitorId}] 忽略 issue_comment 非 created 动作: ${action}`);
      return res.status(200).json({ message: 'Ignored' });
    }
    issue = payload.issue;
    logger.info(`[Webhook #${monitorId}] 收到评论事件: Issue #${issue.number}`);
  } else {
    logger.debug(`[Webhook #${monitorId}] 忽略事件: ${event}`);
    return res.status(200).json({ message: 'Ignored' });
  }

  // @mention 过滤：检查 issue 标题/内容/评论是否包含触发名称
  const mention = getTriggerMention();
  const authContext = monitor.auth_type === 'app'
    ? { authType: 'app', owner: monitor.owner, repo: monitor.repo_name }
    : { authType: 'user', owner: monitor.owner, repo: monitor.repo_name };
  const mentionDebug = await getIssueMentionDebug(monitor.owner, monitor.repo_name, issue, mention, authContext);
  logger.debug(`[Webhook #${monitorId}] Mention check issue #${issue.number}: trigger=${mention || '(disabled)'}, matched=${mentionDebug.matched}, titleMatched=${mentionDebug.titleMatched}, bodyMatched=${mentionDebug.bodyMatched}, commentMatched=${mentionDebug.commentMatched}, comments=${mentionDebug.commentCount}, matchedCommentIds=${mentionDebug.matchedCommentIds.join(',') || 'none'}, commentFetchError=${mentionDebug.commentFetchError || 'none'}`);
  if (mention && !mentionDebug.matched) {
    logger.debug(`[Webhook #${monitorId}] Issue #${issue.number} 未包含 ${mention}，跳过`);
    return res.status(200).json({ message: 'No mention found' });
  }

  // 允许的触发人过滤：检查 sender 是否在白名单中
  const sender = payload.sender && payload.sender.login;
  const senderAllowed = !sender || isUserAllowed(sender, monitor.allowed_trigger_users);
  logger.debug(`[Webhook #${monitorId}] Allowed user check issue #${issue.number}: sender=${sender || 'unknown'}, allowedUsers=${monitor.allowed_trigger_users || '(all)'}, allowed=${senderAllowed}`);
  if (sender && !senderAllowed) {
    logger.info(`[Webhook #${monitorId}] 发送者 ${sender} 不在允许列表中，跳过`);
    return res.status(200).json({ message: 'User not in allowed trigger list' });
  }

  // 去重检查
  const existingJob = queries.findActiveJobForIssue(monitorId, issue.number);
  if (existingJob) {
    logger.info(`[Webhook #${monitorId}] Issue #${issue.number} 已在处理中`);
    return res.status(200).json({ message: 'Already processing' });
  }

  // 异步触发处理（不阻塞 webhook 响应）
  setImmediate(async () => {
    try {
      await onNewIssue(monitor, issue);
    } catch (err) {
      logger.error(`[Webhook #${monitorId}] 处理失败: ${err.message}`);
    }
  });

  res.status(200).json({ message: 'Accepted' });
}

module.exports = { handleWebhook };
