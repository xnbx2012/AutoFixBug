const { Octokit } = require('@octokit/rest');
const { decrypt } = require('../crypto/secrets');
const { getConfig } = require('../db/queries');
const { getInstallationOctokit } = require('./app');

let octokitInstance = null;
let cachedToken = null;

/**
 * 获取 Octokit 实例（自动解密并使用已保存的 GitHub Token）
 * 缓存实例避免重复解密
 *
 * 注意：此函数仅返回 PAT 认证的 Octokit（向后兼容）。
 * 新代码请使用 getOctokitForAuth() 以支持 App 模式。
 */
function getOctokit(tokenOverride = null) {
  if (tokenOverride) {
    return new Octokit({ auth: tokenOverride });
  }

  const encrypted = getConfig('github_token');
  if (!encrypted) throw new Error('GitHub Token 未配置，请先在系统中配置 Token');

  // 如果 token 未变化，复用缓存实例
  if (octokitInstance && cachedToken === encrypted) {
    return octokitInstance;
  }

  const token = decrypt(encrypted);
  octokitInstance = new Octokit({ auth: token });
  cachedToken = encrypted;
  return octokitInstance;
}

/**
 * 根据 auth_type 返回对应的 Octokit 实例
 *  - 'user'：使用全局 PAT（getOctokit）
 *  - 'app'：为指定 owner/repo 换取 installation token 并返回该 installation 的 Octokit
 *
 * @param {object} authContext { authType: 'user'|'app', owner: string, repo: string }
 * @returns {Promise<Octokit>}
 */
async function getOctokitForAuth(authContext) {
  if (!authContext) {
    // 默认行为：使用 PAT
    return getOctokit();
  }
  const { authType, owner, repo } = authContext;

  if (authType === 'app') {
    if (!owner || !repo) {
      throw new Error('App 认证模式需要提供 owner 和 repo');
    }
    const { octokit } = await getInstallationOctokit(owner, repo);
    return octokit;
  }

  // 默认 user 模式
  return getOctokit();
}

/**
 * 验证 Token 是否有效
 */
async function validateToken(token) {
  try {
    const octokit = new Octokit({ auth: token });
    const { data: user } = await octokit.users.getAuthenticated();
    return { valid: true, user: user.login };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = { getOctokit, getOctokitForAuth, validateToken };
