const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../monitor/webhookHandler');
const { processIssue } = require('../agent/pipeline');

/**
 * POST /webhook/:monitorId
 * GitHub Webhook 入口
 */
router.post('/:monitorId', async (req, res) => {
  try {
    await handleWebhook(req, res, async (monitor, issue) => {
      await processIssue(monitor, issue);
    });
  } catch (err) {
    console.error(`[Webhook Route] 错误: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;
