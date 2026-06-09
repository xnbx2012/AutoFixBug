/**
 * GitHub App 认证模块
 *
 * 流程：
 *   1) App ID + Private Key (.pem) -> 用 RS256 算法签名一个 JWT（10 分钟过期）
 *   2) 用这个 JWT 调用 GitHub `/app/installations` 或 `/repos/{owner}/{repo}/installation`
 *      找到目标仓库对应的 installation ID
 *   3) 用 JWT 调 `/app/installations/{id}/access_tokens` 换取该 installation 的访问令牌（1 小时过期）
 *   4) 用该 installation 令牌作为 Octokit 的 auth 创建实例
 *
 * 注意：所有 installation token 在内存中按 (installationId) 缓存，过期前 10 分钟自动续期。
 */

const jwt = require('jsonwebtoken');
const { Octokit } = require('@octokit/rest');
const { decrypt, encrypt } = require('../crypto/secrets');
const { getConfig, setConfig } = require('../db/queries');
const logger = require('../log/logger');

const APP_JWT_TTL_SECONDS = 10 * 60;       // App JWT 10 分钟
const INSTALLATION_TOKEN_TTL_SECONDS = 60 * 60;
const INSTALLATION_TOKEN_REFRESH_BUFFER = 10 * 60; // 提前 10 分钟续期
const APP_JWT_REFRESH_BUFFER_SECONDS = 60;

// 安装令牌缓存：installationId -> { token, expiresAt, octokit, owner, repo }
const installationCache = new Map();
// App 级 Octokit（用 App JWT 认证，用来列举 installations、调管理 API）
let appOctokitInstance = null;
let cachedAppJwt = null;

function normalizePrivateKey(pem) {
  return String(pem)
    .trim()
    .split('\\r\\n').join('\n')
    .split('\\n').join('\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * 读取并返回 App ID（明文）
 */
function getAppId() {
  const enc = getConfig('github_app_id');
  if (!enc) return null;
  return enc;
}

/**
 * 读取并返回 App Private Key（明文 PEM 内容）
 */
function getAppPrivateKey() {
  const enc = getConfig('github_app_private_key');
  if (!enc) return null;
  return normalizePrivateKey(decrypt(enc));
}

/**
 * 读取并返回 App Client ID（明文）
 */
function getAppClientId() {
  return getConfig('github_app_client_id') || null;
}

/**
 * 读取并返回 App Client Secret（明文，解密）
 */
function getAppClientSecret() {
  const enc = getConfig('github_app_client_secret');
  if (!enc) return null;
  return decrypt(enc);
}

/**
 * 是否已配置 GitHub App
 */
function isAppConfigured() {
  return !!(getAppId() && getAppPrivateKey() && getAppClientId() && getAppClientSecret());
}

/**
 * 设置 App ID（明文存储）
 */
function setAppId(appId) {
  setConfig('github_app_id', String(appId).trim());
  clearCache();
}

/**
 * 设置 App Private Key（PEM 内容，加密存储）
 */
function setAppPrivateKey(pem) {
  if (!pem) {
    setConfig('github_app_private_key', '');
    clearCache();
    return;
  }
  setConfig('github_app_private_key', encrypt(normalizePrivateKey(pem)));
  clearCache();
}

/**
 * 设置 App Client ID（明文存储）
 */
function setAppClientId(clientId) {
  if (!clientId) {
    setConfig('github_app_client_id', '');
    clearCache();
    return;
  }
  setConfig('github_app_client_id', String(clientId).trim());
  clearCache();
}

/**
 * 设置 App Client Secret（加密存储）
 */
function setAppClientSecret(secret) {
  if (!secret) {
    setConfig('github_app_client_secret', '');
    clearCache();
    return;
  }
  setConfig('github_app_client_secret', encrypt(String(secret).trim()));
  clearCache();
}

/**
 * 生成 App JWT（RS256 签名，10 分钟过期）
 */
function generateAppJwt(appId, privateKeyPem) {
  if (!appId) throw new Error('GitHub App ID 未配置');
  if (!privateKeyPem) throw new Error('GitHub App Private Key 未配置');

  const privateKey = normalizePrivateKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 30, // 提前 30 秒，避免时钟漂移
    exp: now + APP_JWT_TTL_SECONDS,
    iss: appId,
  };

  return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
}

/**
 * 获取 App 级 Octokit（用 App JWT 认证）
 * 缓存 appOctokitInstance 避免重复签名
 */
function getAppOctokit() {
  const appId = getAppId();
  const privateKey = getAppPrivateKey();
  if (!appId || !privateKey) {
    throw new Error('GitHub App 未配置：请先在配置页填写 App ID 和 Private Key');
  }

  const now = Math.floor(Date.now() / 1000);
  const jwtExpired = !cachedAppJwt || cachedAppJwt.expiresAt - now <= APP_JWT_REFRESH_BUFFER_SECONDS;

  if (!appOctokitInstance || jwtExpired) {
    const appJwt = generateAppJwt(appId, privateKey);
    cachedAppJwt = { token: appJwt, expiresAt: now + APP_JWT_TTL_SECONDS };
    appOctokitInstance = new Octokit({ auth: appJwt, userAgent: 'auto-fix-bug-app' });
  }
  return appOctokitInstance;
}

/**
 * 用 App JWT 调 `GET /repos/{owner}/{repo}/installation` 找到 installation ID
 * 注意：该接口仅在 App 已安装到目标仓库时才返回 200
 */
async function findInstallationIdForRepo(owner, repo) {
  const octokit = getAppOctokit();
  const { data } = await octokit.apps.getRepoInstallation({ owner, repo });
  return data.id;
}

/**
 * 列出所有 installations（用于诊断或批量操作）
 */
async function listInstallations() {
  const octokit = getAppOctokit();
  const { data } = await octokit.apps.listInstallations();
  return data;
}

/**
 * 为指定 installation 换取 access token
 * 返回 { token, expires_at }
 */
async function createInstallationToken(installationId) {
  const octokit = getAppOctokit();
  const { data } = await octokit.apps.createInstallationAccessToken({
    installation_id: installationId,
  });
  return {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
}

/**
 * 获取某个 (owner, repo) 对应 installation 的 access token
 * - 自动发现 installationId
 * - 自动缓存 token（提前 10 分钟续期）
 * - 返回 { octokit, token, installationId }
 */
async function getInstallationOctokit(owner, repo) {
  // 1) 找 installationId
  const installationId = await findInstallationIdForRepo(owner, repo);

  // 2) 检查缓存
  const cached = installationCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > INSTALLATION_TOKEN_REFRESH_BUFFER * 1000) {
    return {
      octokit: cached.octokit,
      token: cached.token,
      installationId,
    };
  }

  // 3) 换取新 token
  const { token, expiresAt } = await createInstallationToken(installationId);
  const newOctokit = new Octokit({ auth: token, userAgent: 'auto-fix-bug-app-installation' });

  installationCache.set(installationId, {
    token,
    expiresAt,
    octokit: newOctokit,
    owner,
    repo,
  });

  logger.info(`[App] 已为 ${owner}/${repo} 获取 installation token (id=${installationId}, 过期: ${require('../utils/time').formatShanghai(expiresAt)})`);

  return { octokit: newOctokit, token, installationId };
}

/**
 * 获取指定仓库当前可用的 git push 凭据 URL
 * 即 `https://x-access-token:<installation_token>@github.com/owner/repo.git`
 */
async function getAuthenticatedRepoUrl(repoUrl) {
  // 解析 owner/repo
  const m = repoUrl.match(/github\.com[/:]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) throw new Error(`无法从 URL 解析 owner/repo: ${repoUrl}`);
  const owner = m[1];
  const repo = m[2];

  const { token } = await getInstallationOctokit(owner, repo);
  const url = new URL(repoUrl);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

/**
 * 验证 App 配置：尝试用 App JWT 列举 installations
 */
async function validateAppConfig() {
  try {
    if (!isAppConfigured()) {
      return { valid: false, error: 'App ID 或 Private Key 未配置' };
    }
    const installations = await listInstallations();
    return {
      valid: true,
      installationCount: installations.length,
      installations: installations.map(i => ({
        id: i.id,
        account: i.account?.login,
        target_type: i.target_type,
      })),
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * 清空缓存（用于测试或强制刷新）
 */
function clearCache() {
  installationCache.clear();
  appOctokitInstance = null;
  cachedAppJwt = null;
}

module.exports = {
  // 配置
  getAppId,
  getAppPrivateKey,
  getAppClientId,
  getAppClientSecret,
  isAppConfigured,
  setAppId,
  setAppPrivateKey,
  setAppClientId,
  setAppClientSecret,
  // JWT
  generateAppJwt,
  getAppOctokit,
  // Installation
  findInstallationIdForRepo,
  listInstallations,
  createInstallationToken,
  getInstallationOctokit,
  getAuthenticatedRepoUrl,
  // 验证
  validateAppConfig,
  clearCache,
};
