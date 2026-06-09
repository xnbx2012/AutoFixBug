const express = require('express');
const router = express.Router();
const { config, updateAdminPassword, DEFAULT_ADMIN_PASSWORD } = require('../config');
const { signToken, COOKIE_NAME } = require('../middleware/auth');
const logger = require('../log/logger');

const TOKEN_MAX_AGE = 24 * 60 * 60 * 1000; // 24h

/**
 * GET /api/auth/status
 * 公开路由（不经过 requireAuth），返回当前鉴权状态
 */
router.get('/status', (req, res) => {
  const { parseCookies, verifyToken } = require('../middleware/auth');
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  let authenticated = false;
  let username = null;

  if (token) {
    try {
      const payload = verifyToken(token);
      authenticated = true;
      username = payload.username;
    } catch (_) {
      // token 无效或已过期，视为未登录
    }
  }

  res.json({
    authenticated,
    username,
    passwordDefault: config.passwordDefault,
  });
});

/**
 * POST /api/auth/login
 * 校验账号密码，成功后设置 httpOnly Cookie
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: '请输入账号和密码' });
  }

  if (username !== config.adminUsername || password !== config.adminPasswordDecrypted) {
    logger.warn(`[Auth] 登录失败: username=${username}`);
    return res.status(401).json({ error: '账号或密码错误' });
  }

  const token = signToken(username);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: TOKEN_MAX_AGE,
    path: '/',
  });
  logger.info(`[Auth] 登录成功: ${username}`);
  res.json({ ok: true, username });
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

/**
 * POST /api/auth/change-password
 * 校验旧密码 → 设置新密码（≥6 字符，≠默认密码）→ 自动登录
 */
router.post('/change-password', (req, res) => {
  const { oldPassword, newPassword } = req.body || {};

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '请输入旧密码和新密码' });
  }

  if (oldPassword !== config.adminPasswordDecrypted) {
    return res.status(401).json({ error: '旧密码不正确' });
  }

  if (newPassword === DEFAULT_ADMIN_PASSWORD) {
    return res.status(400).json({ error: '新密码不能与默认密码相同' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码长度至少为 6 位' });
  }

  try {
    updateAdminPassword(newPassword);
    logger.info('[Auth] 管理员密码已修改');

    // 自动登录
    const token = signToken(config.adminUsername);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: TOKEN_MAX_AGE,
      path: '/',
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error(`[Auth] 修改密码失败: ${err.message}`);
    res.status(500).json({ error: '修改密码失败: ' + err.message });
  }
});

module.exports = router;
