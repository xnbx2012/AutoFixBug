require('dotenv').config();
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = '123456';

const config = {
  root: ROOT,
  port: parseInt(process.env.PORT || '3000', 10),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10),
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  adminUsername: process.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME,
  adminPasswordDecrypted: '',
  passwordDefault: false,
  paths: {
    data: path.join(ROOT, 'data'),
    db: path.join(ROOT, 'data', 'app.db'),
    logs: path.join(ROOT, 'logs'),
    repos: path.join(ROOT, 'data', 'repos'),
  },
};

// 首次启动：自动生成加密主密钥
function ensureEncryptionKey() {
  if (!config.encryptionKey) {
    const { randomBytes } = require('crypto');
    const key = randomBytes(32).toString('hex');
    config.encryptionKey = key;
    // 写入 .env
    const envPath = path.join(ROOT, '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
      if (envContent.match(/^ENCRYPTION_KEY=.*$/m)) {
        envContent = envContent.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${key}`);
      } else {
        envContent += `\nENCRYPTION_KEY=${key}\n`;
      }
    } else {
      envContent = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
      envContent = envContent.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${key}`);
    }
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('[Config] 自动生成 ENCRYPTION_KEY 并写入 .env');
  }
}

// 确保数据目录存在
function ensureDirs() {
  for (const dir of [config.paths.data, config.paths.logs, config.paths.repos]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * 读取 .env 中的 ADMIN_PASSWORD / ADMIN_USERNAME
 * - 如果是密文（looksEncrypted），解密放入 config.adminPasswordDecrypted
 * - 如果是明文，自动加密写回 .env（覆盖明文）
 * - 如果最终仍是默认密码 123456，将 config.passwordDefault = true
 *
 * 必须在 ensureEncryptionKey() 之后调用
 */
function ensureAdminPassword() {
  const envPath = path.join(ROOT, '.env');
  const raw = process.env.ADMIN_PASSWORD;

  // 没有 .env 也没有 env 变量：直接使用默认值，标为 default
  if (!raw) {
    config.adminPasswordDecrypted = DEFAULT_ADMIN_PASSWORD;
    config.passwordDefault = true;
    return;
  }

  const { encrypt, decrypt, looksEncrypted } = require('./crypto/secrets');
  let plain = raw;
  if (looksEncrypted(raw)) {
    try {
      plain = decrypt(raw);
    } catch (err) {
      // 解密失败（密钥变更等），降级为默认密码并强制用户重设
      console.error('[Config] ADMIN_PASSWORD 解密失败，回退为默认密码:', err.message);
      plain = DEFAULT_ADMIN_PASSWORD;
    }
  } else {
    // 明文 → 加密写回 .env
    const encrypted = encrypt(raw);
    upsertEnvVar(envPath, 'ADMIN_PASSWORD', encrypted);
    process.env.ADMIN_PASSWORD = encrypted;
    console.log('[Config] 已将明文 ADMIN_PASSWORD 加密写回 .env');
  }

  config.adminPasswordDecrypted = plain;
  config.passwordDefault = (plain === DEFAULT_ADMIN_PASSWORD);
}

/**
 * 修改管理员密码：加密写回 .env，同步 config
 * @param {string} newPassword 明文新密码
 */
function updateAdminPassword(newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length === 0) {
    throw new Error('新密码无效');
  }
  const { encrypt } = require('./crypto/secrets');
  const encrypted = encrypt(newPassword);
  const envPath = path.join(ROOT, '.env');
  upsertEnvVar(envPath, 'ADMIN_PASSWORD', encrypted);
  process.env.ADMIN_PASSWORD = encrypted;
  config.adminPasswordDecrypted = newPassword;
  config.passwordDefault = (newPassword === DEFAULT_ADMIN_PASSWORD);
}

/**
 * 工具：往 .env 文件 upsert 一个 KEY=VALUE（保留注释和顺序）
 */
function upsertEnvVar(envPath, key, value) {
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  } else {
    content = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  }
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

module.exports = {
  config,
  ensureEncryptionKey,
  ensureDirs,
  ensureAdminPassword,
  updateAdminPassword,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_PASSWORD,
};
