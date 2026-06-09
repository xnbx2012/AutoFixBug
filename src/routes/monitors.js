const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const queries = require('../db/queries');
const { createWebhook, deleteWebhook } = require('../github/webhook');
const { config } = require('../config');
const scheduler = require('../monitor/scheduler');
const { isAppConfigured } = require('../github/app');
const { encrypt } = require('../crypto/secrets');

/**
 * GET /api/monitors
 * 列出所有监控任务
 */
router.get('/', (req, res) => {
  try {
    const monitors = queries.listMonitors();
    // 附加运行状态；api_key 已加密存储，但前端无需看到密文，直接抹掉
    const result = monitors.map(m => ({
      ...m,
      api_key: m.api_key ? '********' : null,  // 有值时显示掩码，无值时显示 null
      active: scheduler.isActive(m.id),
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/monitors
 * 创建监控任务
 * Body: { repo_id, mode: 'webhook'|'poll'|'app_poll', auth_type?: 'user'|'app', poll_interval?, webhook_secret? }
 */
router.post('/', (req, res) => {
  try {
    const { repo_id, mode, auth_type, poll_interval, webhook_secret,
            model_name, api_key, api_base_url, allowed_trigger_users } = req.body;

    if (!repo_id || !mode) {
      return res.status(400).json({ error: '缺少 repo_id 或 mode' });
    }

    // 校验 mode
    const validModes = ['webhook', 'poll', 'app_poll'];
    if (!validModes.includes(mode)) {
      return res.status(400).json({ error: `mode 必须是 ${validModes.join('|')} 之一` });
    }

    // 校验 auth_type
    const finalAuthType = auth_type || 'user';
    if (!['user', 'app'].includes(finalAuthType)) {
      return res.status(400).json({ error: 'auth_type 必须是 user 或 app' });
    }

    // App 模式必须先配置好 App 凭据
    if (finalAuthType === 'app' && !isAppConfigured()) {
      return res.status(400).json({ error: 'App 模式要求先在配置页填写 GitHub App 凭据' });
    }

    // app_poll 模式仅在 auth_type='app' 时有意义
    if (mode === 'app_poll' && finalAuthType !== 'app') {
      return res.status(400).json({ error: 'app_poll 模式必须配合 auth_type=app' });
    }

    const repo = queries.getRepo(repo_id);
    if (!repo) {
      return res.status(404).json({ error: '仓库不存在' });
    }

    const monitorData = {
      repo_id,
      mode,
      auth_type: finalAuthType,
      enabled: 0, // 创建时默认关闭
      poll_interval: poll_interval || 60,
    };

    if (mode === 'webhook') {
      // 自动生成 webhook URL 和 secret
      const secret = webhook_secret || crypto.randomBytes(32).toString('hex');
      const webhookUrl = `${config.publicBaseUrl}/webhook/${Date.now()}`; // 临时 URL，创建后更新

      monitorData.webhook_secret = secret;
      monitorData.webhook_url = webhookUrl;
    }

    // 自定义 Agent 配置（可选）。model_name / api_base_url 明文存储；api_key 加密存储
    if (model_name && String(model_name).trim()) {
      monitorData.model_name = String(model_name).trim();
    }
    if (api_base_url && String(api_base_url).trim()) {
      monitorData.api_base_url = String(api_base_url).trim();
    }
    if (api_key && String(api_key).trim()) {
      const encrypted = encrypt(String(api_key).trim());
      if (encrypted) monitorData.api_key = encrypted;
    }

    // 允许的触发人列表（逗号分隔的 GitHub 用户名；空表示不限制）
    if (allowed_trigger_users && String(allowed_trigger_users).trim()) {
      monitorData.allowed_trigger_users = String(allowed_trigger_users).trim();
    }

    const monitor = queries.addMonitor(monitorData);

    // 更新 webhook URL 为实际 ID
    if (mode === 'webhook') {
      const finalUrl = `${config.publicBaseUrl}/webhook/${monitor.id}`;
      queries.updateMonitor(monitor.id, { webhook_url: finalUrl });
      monitor.webhook_url = finalUrl;
    }

    // 返回前把 api_key 抹掉，避免泄露到前端
    if (monitor.api_key) monitor.api_key = null;

    res.json({ success: true, monitor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/monitors/:id
 * 编辑监控任务（目前只支持修改 allowed_trigger_users）
 * Body: { allowed_trigger_users?: string|null }
 */
router.patch('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const monitor = queries.getMonitor(id);
    if (!monitor) {
      return res.status(404).json({ error: '监控任务不存在' });
    }

    const fields = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'allowed_trigger_users')) {
      const raw = req.body.allowed_trigger_users;
      if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
        fields.allowed_trigger_users = null;
      } else {
        // 规范化：去除多余空白、去重、保留原顺序
        const users = String(raw)
          .split(',')
          .map(u => u.trim())
          .filter(Boolean);
        const unique = [...new Set(users)];
        fields.allowed_trigger_users = unique.length > 0 ? unique.join(',') : null;
      }
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: '没有可更新的字段' });
    }

    queries.updateMonitor(id, fields);
    res.json({ success: true, monitor: queries.getMonitor(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/monitors/:id/toggle
 * 开关监控
 * Body: { enabled: true|false }
 */
router.patch('/:id/toggle', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { enabled } = req.body;

    const monitor = queries.getMonitor(id);
    if (!monitor) {
      return res.status(404).json({ error: '监控任务不存在' });
    }

    queries.setMonitorEnabled(id, enabled);

    if (enabled) {
      await scheduler.start(monitor);
    } else {
      await scheduler.stop(monitor);
    }

    res.json({
      success: true,
      message: `监控 ${enabled ? '已启动' : '已停止'}`,
      enabled: !!enabled,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/monitors/:id/register-webhook
 * 自动注册 Webhook 到 GitHub
 */
router.post('/:id/register-webhook', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const monitor = queries.getMonitor(id);

    if (!monitor) {
      return res.status(404).json({ error: '监控任务不存在' });
    }

    if (monitor.mode !== 'webhook') {
      return res.status(400).json({ error: '仅 webhook 模式支持自动注册' });
    }

    const repo = queries.getRepo(monitor.repo_id);
    if (!repo) {
      return res.status(404).json({ error: '关联仓库不存在' });
    }

    const webhookUrl = `${config.publicBaseUrl}/webhook/${monitor.id}`;
    const authContext = monitor.auth_type === 'app'
      ? { authType: 'app', owner: repo.owner, repo: repo.name }
      : { authType: 'user', owner: repo.owner, repo: repo.name };
    const result = await createWebhook(
      repo.owner,
      repo.name,
      webhookUrl,
      monitor.webhook_secret,
      authContext
    );

    queries.updateMonitor(id, {
      github_webhook_id: result.id,
      webhook_url: webhookUrl,
    });

    res.json({
      success: true,
      message: `Webhook 已注册到 GitHub`,
      hookId: result.id,
      url: webhookUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/monitors/:id
 * 删除监控任务
 */
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const monitor = queries.getMonitor(id);

    if (!monitor) {
      return res.status(404).json({ error: '监控任务不存在' });
    }

    // 先停止
    await scheduler.stop(monitor);

    // 如果是 webhook 模式且已注册到 GitHub，尝试删除
    if (monitor.mode === 'webhook' && monitor.github_webhook_id) {
      try {
        const repo = queries.getRepo(monitor.repo_id);
        if (repo) {
          const authContext = monitor.auth_type === 'app'
            ? { authType: 'app', owner: repo.owner, repo: repo.name }
            : { authType: 'user', owner: repo.owner, repo: repo.name };
          await deleteWebhook(repo.owner, repo.name, monitor.github_webhook_id, authContext);
        }
      } catch (err) {
        console.warn(`[Monitor] 删除 GitHub Webhook 失败: ${err.message}`);
      }
    }

    queries.deleteMonitor(id);
    res.json({ success: true, message: '监控任务已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
