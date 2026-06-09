const crypto = require('crypto');
const { config } = require('../config');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 推荐 12 字节

function getKey() {
  const hex = config.encryptionKey;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY 未配置或长度错误(应为 64 字符 hex)');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // 格式: iv(hex):authTag(hex):ciphertext(hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(encrypted) {
  if (encrypted == null) return null;
  const key = getKey();
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('密文格式错误');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * 检测字符串是否已经是加密格式：iv(24hex):authTag(32hex):ciphertext(hex)
 * 用于决定 .env 中的 ADMIN_PASSWORD 字段是否需要再次加密
 */
function looksEncrypted(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  return /^[0-9a-f]{24}$/i.test(parts[0])
    && /^[0-9a-f]{32}$/i.test(parts[1])
    && /^[0-9a-f]+$/i.test(parts[2]);
}

module.exports = { encrypt, decrypt, looksEncrypted };
