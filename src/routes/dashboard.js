const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');

/**
 * GET /api/dashboard
 * 返回 Dashboard 看板所需的全部聚合数据
 */
router.get('/', (req, res) => {
  try {
    const db = getDb();

    // ========== KPI 概览 ==========
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM jobs').get().cnt;

    const successRow = db.prepare(
      "SELECT COUNT(*) AS cnt FROM jobs WHERE status = 'merged'"
    ).get();
    const successRate = total > 0 ? Math.round((successRow.cnt / total) * 100) : 0;

    const tokenRow = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache
      FROM jobs
    `).get();
    const totalTokens = tokenRow.input + tokenRow.output + tokenRow.cache;

    const avgDurationRow = db.prepare(`
      SELECT AVG(duration_ms) AS avg_ms
      FROM jobs
      WHERE duration_ms IS NOT NULL AND duration_ms > 0
    `).get();

    const kpi = {
      total,
      successRate,
      totalTokens,
      avgDurationMs: Math.round(avgDurationRow.avg_ms || 0),
    };

    // ========== 热力图（最近 6 个月，每日 merged 数） ==========
    // 注意：数据库中的时间戳为 Asia/Shanghai 无时区格式，需对 'now' 加 +8 小时
    const heatmap = db.prepare(`
      SELECT DATE(updated_at) AS date, COUNT(*) AS count
      FROM jobs
      WHERE status = 'merged'
        AND updated_at >= DATETIME('now', '-6 months', '+8 hours')
      GROUP BY DATE(updated_at)
      ORDER BY date ASC
    `).all();

    // ========== Token 消耗趋势（按天，最近 30 天） ==========
    const tokenTrend = db.prepare(`
      SELECT
        DATE(created_at) AS day,
        COALESCE(SUM(input_tokens), 0)   AS input,
        COALESCE(SUM(output_tokens), 0)  AS output,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cache
      FROM jobs
      WHERE created_at >= DATE('now', '-30 days', '+8 hours')
      GROUP BY day
      ORDER BY day ASC
    `).all();

    // ========== 各仓库 Issue 数量（含 open / closed 状态分布） ==========
    const repoIssues = db.prepare(`
      SELECT
        r.owner || '/' || r.name AS repo,
        COUNT(*) AS total,
        SUM(CASE WHEN j.status IN ('merged', 'failed') THEN 1 ELSE 0 END) AS closed,
        SUM(CASE WHEN j.status NOT IN ('merged', 'failed') THEN 1 ELSE 0 END) AS open
      FROM jobs j
      JOIN monitors m ON j.monitor_id = m.id
      JOIN repos r ON m.repo_id = r.id
      GROUP BY r.id
      ORDER BY total DESC
    `).all();

    // ========== PR 状态分布 ==========
    const prStatusRows = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM jobs
      GROUP BY status
    `).all();
    const prStatus = {};
    for (const row of prStatusRows) {
      prStatus[row.status] = row.count;
    }

    // ========== 平均修复时长（最近 7 天，按天） ==========
    const durationByMonth = db.prepare(`
      SELECT
        DATE(created_at) AS day,
        AVG(duration_ms) AS avg_ms
      FROM jobs
      WHERE duration_ms IS NOT NULL AND duration_ms > 0
        AND created_at >= DATE('now', '-7 days', '+8 hours')
      GROUP BY day
      ORDER BY day ASC
    `).all();

    // ========== 最近 10 条任务 ==========
    const recentJobs = db.prepare(`
      SELECT j.id, j.issue_number, j.issue_title, j.status,
             j.input_tokens, j.output_tokens, j.duration_ms, j.created_at,
             r.owner || '/' || r.name AS repo
      FROM jobs j
      JOIN monitors m ON j.monitor_id = m.id
      JOIN repos r ON m.repo_id = r.id
      ORDER BY j.created_at DESC
      LIMIT 10
    `).all();

    res.json({
      kpi,
      heatmap,
      tokenTrend,
      repoIssues,
      prStatus,
      durationByMonth,
      recentJobs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
