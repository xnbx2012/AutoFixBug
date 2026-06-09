const jwt = require('jsonwebtoken');
const { config } = require('../config');
const logger = require('../log/logger');

const COOKIE_NAME = 'afb_token';
const TOKEN_TTL = '24h';

/**
 * 从请求中解析 Cookie（无需 cookie-parser）
 */
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v || '');
  }
  return out;
}

function signToken(username) {
  return jwt.sign({ username }, config.encryptionKey, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  return jwt.verify(token, config.encryptionKey);
}

/**
 * 默认密码守卫：默认密码未改时，仅放行 auth 相关路由
 * 需在 express.json() 之后、requireAuth 之前注册
 */
function defaultPasswordGuard(req, res, next) {
  if (!config.passwordDefault) return next();
  // 仅放行 auth 路由和静态文件（静态文件在此中间件之前已注册）
  if (req.path.startsWith('/auth')) return next();
  return res.status(503).json({ error: '请先修改默认密码', code: 'PASSWORD_DEFAULT' });
}

/**
 * JWT 认证中间件：从 Cookie 或 Authorization 头读取 token
 * 鉴权失败返回 401（浏览器请求）或交由后续路由处理（status 路由可跳过）
 */
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const payload = verifyToken(token);
    req.user = { username: payload.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

module.exports = {
  COOKIE_NAME,
  signToken,
  verifyToken,
  defaultPasswordGuard,
  requireAuth,
  parseCookies,
};
