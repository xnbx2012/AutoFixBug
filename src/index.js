const express = require('express');
const path = require('path');
const { config, ensureEncryptionKey, ensureDirs, ensureAdminPassword } = require('./config');
const { init: initDb } = require('./db/schema');
const scheduler = require('./monitor/scheduler');
const { processIssue } = require('./agent/pipeline');
const logger = require('./log/logger');

// ============ 初始化 ============
ensureEncryptionKey();
ensureDirs();
ensureAdminPassword();
initDb();

const app = express();

// ============ 中间件 ============
// Webhook 路由需要先拿到原始 body 做签名验证，所以单独挂载在 json 解析之前
app.use('/webhook', express.raw({ type: 'application/json' }), require('./routes/webhook'));

// 其余 API 路由使用 JSON 解析
app.use(express.json());

// ============ 静态文件 ============
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============ 默认密码守卫 ============
// 默认密码未修改时，仅放行 /api/auth/* 和静态资源
app.use('/api', require('./middleware/auth').defaultPasswordGuard);

// ============ 鉴权路由（无需登录） ============
app.use('/api/auth', require('./routes/auth'));

// ============ JWT 鉴权闸门 ============
app.use('/api', require('./middleware/auth').requireAuth);

// ============ 业务 API 路由 ============
app.use('/api/config', require('./routes/config'));
app.use('/api/repos', require('./routes/repos'));
app.use('/api/monitors', require('./routes/monitors'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/dashboard', require('./routes/dashboard'));

// ============ SPA Fallback ============
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ============ 错误处理 ============
app.use((err, req, res, next) => {
  logger.error(`[Server] 未捕获错误: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: '服务器内部错误' });
});

// ============ 启动服务 ============
const PORT = config.port;
app.listen(PORT, async () => {
  logger.info(`[Server] auto-fix-bug 已启动: http://localhost:${PORT}`);
  logger.info(`[Server] 数据库: ${config.paths.db}`);
  logger.info(`[Server] 日志目录: ${config.paths.logs}`);

  if (config.passwordDefault) {
    logger.warn('============================================================');
    logger.warn('[Auth] 警告：当前 ADMIN_PASSWORD 仍为默认密码 123456');
    logger.warn('[Auth] 服务将拒绝响应 API 请求（仅 /api/auth/* 可用）');
    logger.warn('[Auth] 请通过前端 /api/auth/change-password 立即修改密码');
    logger.warn('============================================================');
  }

  // 设置调度器回调并启动所有已启用的监控
  scheduler.setOnNewIssue(async (monitor, issue) => {
    await processIssue(monitor, issue);
  });

  try {
    await scheduler.startAll();
    logger.info(`[Server] 监控调度器已启动`);
  } catch (err) {
    logger.error(`[Server] 调度器启动失败: ${err.message}`);
  }
});

// ============ 优雅关闭 ============
process.on('SIGINT', async () => {
  logger.info('[Server] 收到关闭信号，正在停止...');
  await scheduler.stopAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('[Server] 收到终止信号，正在停止...');
  await scheduler.stopAll();
  process.exit(0);
});
