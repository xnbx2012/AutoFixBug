const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const queries = require('../db/queries');
const { config } = require('../config');
const { dateOnlyShanghai } = require('../utils/time');

/**
 * GET /api/jobs
 * 列出所有任务（支持筛选）
 * Query: ?status=&monitorId=&repoId=&page=&pageSize=&limit=
 */
router.get('/', (req, res) => {
  try {
    const { status, monitorId, repoId, limit, page, pageSize } = req.query;
    const requestedPage = Math.max(parseInt(page || '1', 10) || 1, 1);
    const requestedPageSize = Math.min(Math.max(parseInt(pageSize || limit || '20', 10) || 20, 1), 100);
    const filters = {
      status: status || undefined,
      monitorId: monitorId ? parseInt(monitorId, 10) : undefined,
      repoId: repoId ? parseInt(repoId, 10) : undefined,
    };
    const total = queries.countJobs(filters);
    const totalPages = Math.max(Math.ceil(total / requestedPageSize), 1);
    const currentPage = Math.min(requestedPage, totalPages);
    const jobs = queries.listJobs({
      ...filters,
      limit: requestedPageSize,
      offset: (currentPage - 1) * requestedPageSize,
    });
    res.json({
      items: jobs,
      total,
      page: currentPage,
      pageSize: requestedPageSize,
      totalPages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jobs/:id
 * 获取单个任务详情
 */
router.get('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const job = queries.getJob(id);

    if (!job) {
      return res.status(404).json({ error: '任务不存在' });
    }

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jobs/:id/log
 * 获取任务日志内容
 * - 优先读取 job.log_path（绝对路径，由 pipeline 创建）
 * - 兼容旧数据：log_path 为相对路径或文件不存在时，回退到主日志按 jobId 过滤
 */
router.get('/:id/log', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const job = queries.getJob(id);

    if (!job) {
      return res.status(404).json({ error: '任务不存在' });
    }

    if (!job.log_path) {
      return res.json({ log: '(无日志文件)' });
    }

    // 兼容旧数据：相对路径转为绝对路径
    let logFile = job.log_path;
    if (!path.isAbsolute(logFile)) {
      logFile = path.join(config.paths.logs, logFile);
    }

    // 优先读取任务专属日志文件
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8');
      return res.json({ log: content || '(日志文件为空)' });
    }

    // 回退：从主日志中过滤包含该 jobId 的行
    const today = dateOnlyShanghai();
    const mainLog = path.join(config.paths.logs, `${today}.log`);
    if (fs.existsSync(mainLog)) {
      const lines = fs.readFileSync(mainLog, 'utf8').split('\n');
      const filtered = lines.filter(line => line.includes(`[Pipeline Job#${id}]`));
      if (filtered.length > 0) {
        return res.json({ log: filtered.join('\n') });
      }
    }

    res.json({ log: '(日志文件不存在)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jobs/:id/session
 * 获取任务会话记录内容
 * - 优先读取 job.session_path（绝对路径，由 pipeline 创建）
 */
router.get('/:id/session', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const job = queries.getJob(id);

    if (!job) {
      return res.status(404).json({ error: '任务不存在' });
    }

    const sessionFiles = [];

    if (job.session_path) {
      sessionFiles.push(path.isAbsolute(job.session_path)
        ? job.session_path
        : path.join(config.paths.logs, job.session_path));
    }

    if (job.log_path) {
      const logFile = path.isAbsolute(job.log_path)
        ? job.log_path
        : path.join(config.paths.logs, job.log_path);
      sessionFiles.push(path.join(path.dirname(logFile), `session-${id}.txt`));
    }

    if (job.owner && job.repo_name) {
      sessionFiles.push(path.join(config.paths.logs, job.owner, job.repo_name, String(id), `session-${id}.txt`));
    }

    for (const sessionFile of sessionFiles) {
      if (fs.existsSync(sessionFile)) {
        const content = fs.readFileSync(sessionFile, 'utf8');
        return res.json({ session: content || '(会话记录为空)' });
      }
    }

    res.json({ session: '(会话记录不存在)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
