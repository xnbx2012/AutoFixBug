const express = require('express');
const router = express.Router();
const queries = require('../db/queries');
const { encrypt, decrypt } = require('../crypto/secrets');
const { validateToken } = require('../github/client');
const {
  setAppId,
  setAppPrivateKey,
  setAppClientId,
  setAppClientSecret,
  validateAppConfig,
} = require('../github/app');

/**
 * POST /api/config
 * 设置配置项（GitHub Token、Reviewer 等）
 */
router.post('/', async (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key || !value) {
      return res.status(400).json({ error: '缺少 key 或 value' });
    }

    // 敏感字段加密存储
    if (key === 'github_token') {
      // 验证 Token 是否有效
      const validation = await validateToken(value);
      if (!validation.valid) {
        return res.status(400).json({
          error: `GitHub Token 无效: ${validation.error}`,
        });
      }
      queries.setConfig(key, encrypt(value));
      return res.json({
        success: true,
        message: `GitHub Token 已配置（用户: ${validation.user}）`,
      });
    }

    // GitHub App 配置
    if (key === 'github_app_id') {
      setAppId(value);
      return res.json({ success: true, message: 'GitHub App ID 已配置' });
    }

    if (key === 'github_app_private_key') {
      setAppPrivateKey(value);
      return res.json({ success: true, message: 'GitHub App Private Key 已配置' });
    }

    if (key === 'github_app_client_id') {
      setAppClientId(value);
      return res.json({ success: true, message: 'GitHub App Client ID 已配置' });
    }

    if (key === 'github_app_client_secret') {
      setAppClientSecret(value);
      return res.json({ success: true, message: 'GitHub App Client Secret 已配置' });
    }

    // merge_method 合法性校验
    if (key === 'merge_method') {
      const valid = ['merge', 'squash', 'rebase'];
      if (!valid.includes(value)) {
        return res.status(400).json({
          error: `merge_method 必须是 merge、rebase 或 squash 之一`,
        });
      }
    }

    // 普通字段明文存储
    queries.setConfig(key, value);
    res.json({ success: true, message: `配置 ${key} 已更新` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/config
 * 获取配置（敏感字段只返回是否已配置）
 */
router.get('/', (req, res) => {
  try {
    const allConfigs = queries.getAllConfigs();
    const result = {};

    for (const { key, value } of allConfigs) {
      if (key === 'github_token') {
        result[key] = { configured: true }; // 不返回密文
      } else if (key === 'github_app_private_key' || key === 'github_app_client_secret') {
        result[key] = { configured: !!value }; // 不返回密文
      } else {
        result[key] = value;
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config/validate-app
 * 验证当前 GitHub App 配置是否可用（尝试获取 installations）
 */
router.post('/validate-app', async (req, res) => {
  try {
    const result = await validateAppConfig();
    if (result.valid) {
      return res.json({ success: true, installations: result.installations });
    }
    return res.status(400).json({ error: result.error });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
