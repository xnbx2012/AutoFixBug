const express = require('express');
const router = express.Router();
const queries = require('../db/queries');

/**
 * GET /api/repos
 * 列出所有仓库
 */
router.get('/', (req, res) => {
  try {
    const repos = queries.listRepos();
    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/repos
 * 添加仓库
 * Body: { url: "https://github.com/owner/repo" }
 */
router.post('/', (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: '缺少仓库 URL' });
    }

    // 解析 GitHub URL
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      return res.status(400).json({ error: '无效的 GitHub 仓库 URL' });
    }

    const owner = match[1];
    const name = match[2].replace(/\.git$/, ''); // 移除 .git 后缀
    const defaultBranch = req.body.default_branch || 'main';

    // 检查是否已存在
    const existing = queries.getRepoByOwnerName(owner, name);
    if (existing) {
      return res.status(400).json({ error: `仓库 ${owner}/${name} 已存在` });
    }

    // 规范化 URL：无论用户输入的是仓库根 URL、Issue URL 还是任意子路径，
    // 一律存储为 https://github.com/{owner}/{name}，防止 Issue URL 被传入 git clone
    const normalizedUrl = `https://github.com/${owner}/${name}`;
    const repo = queries.addRepo({ url: normalizedUrl, owner, name, default_branch: defaultBranch });
    res.json({ success: true, repo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/repos/:id
 * 删除仓库（同时删除关联的监控任务）
 */
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const repo = queries.getRepo(id);

    if (!repo) {
      return res.status(404).json({ error: '仓库不存在' });
    }

    queries.deleteRepo(id);
    res.json({ success: true, message: `仓库 ${repo.owner}/${repo.name} 已删除` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
