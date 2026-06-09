const { getOctokitForAuth } = require('./client');

/**
 * 在 GitHub 仓库上自动创建 Webhook
 * @param {string} owner 仓库所有者
 * @param {string} repo 仓库名
 * @param {string} webhookUrl 回调 URL
 * @param {string} secret 验证密钥
 * @param {object|null} authContext { authType, owner, repo }
 * @returns {Promise<{id: number, url: string}>}
 */
async function createWebhook(owner, repo, webhookUrl, secret, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  const { data } = await octokit.repos.createWebhook({
    owner,
    repo,
    url: webhookUrl,
    content_type: 'json',
    secret: secret,
    events: ['issues', 'issue_comment'],
    active: true,
  });
  return { id: data.id, url: data.url };
}

/**
 * 删除 GitHub 仓库上的 Webhook
 */
async function deleteWebhook(owner, repo, hookId, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  await octokit.repos.deleteWebhook({ owner, repo, hook_id: hookId });
}

/**
 * 列出仓库的所有 Webhooks
 */
async function listWebhooks(owner, repo, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  const { data } = await octokit.repos.listWebhooks({ owner, repo });
  return data;
}

/**
 * 测试 Webhook 连通性（触发一个 ping 事件）
 */
async function pingWebhook(owner, repo, hookId, authContext = null) {
  const octokit = await getOctokitForAuth(authContext);
  await octokit.repos.pingHook({ owner, repo, hook_id: hookId });
  return true;
}

/**
 * 验证 GitHub Webhook 签名（SHA-256 HMAC）
 * @param {string} payload 原始请求体（Buffer 或 string）
 * @param {string} signature 请求头中的 X-Hub-Signature-256
 * @param {string} secret Webhook 密钥
 * @returns {boolean}
 */
function verifyWebhookSignature(payload, signature, secret) {
  if (!signature) return false;
  const crypto = require('crypto');
  const body = typeof payload === 'string' ? payload : payload.toString('utf8');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  const computed = 'sha256=' + hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

module.exports = {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  pingWebhook,
  verifyWebhookSignature,
};
