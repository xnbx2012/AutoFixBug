const { getDb } = require('./schema');

// ============ 时区辅助 ============
/**
 * 返回 Asia/Shanghai 当前时间的 ISO-like 字符串（+08:00）
 * 用于所有写入数据库的时间戳
 */
function nowShanghai() {
  // 始终输出 Asia/Shanghai（+08:00）时间的"无时区"格式
  // 注意：不带时区偏移后缀，否则 SQLite 会将偏移量标准化回 UTC
  const d = new Date();
  const utcMs = d.getTime(); // 始终是 UTC 毫秒
  const shanghaiMs = utcMs + 8 * 60 * 60 * 1000; // +8h
  const s = new Date(shanghaiMs);
  const iso = s.toISOString(); // 格式为 YYYY-MM-DDTHH:mm:ss.sssZ
  return iso.replace('Z', '');  // 输出 2026-06-08T14:00:00.000（无时区后缀，SQLite 按字面处理）
}

// ============ Configs ============
function setConfig(key, value) {
  const stmt = getDb().prepare(
    'INSERT INTO configs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  stmt.run(key, value);
}

function getConfig(key) {
  const row = getDb().prepare('SELECT value FROM configs WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getAllConfigs() {
  return getDb().prepare('SELECT key, value FROM configs').all();
}

// ============ Repos ============
function addRepo({ url, owner, name, default_branch = 'main' }) {
  const stmt = getDb().prepare(
    'INSERT INTO repos (url, owner, name, default_branch) VALUES (?, ?, ?, ?)'
  );
  const info = stmt.run(url, owner, name, default_branch);
  return { id: info.lastInsertRowid, url, owner, name, default_branch };
}

function getRepo(id) {
  return getDb().prepare('SELECT * FROM repos WHERE id = ?').get(id);
}

function getRepoByOwnerName(owner, name) {
  return getDb().prepare('SELECT * FROM repos WHERE owner = ? AND name = ?').get(owner, name);
}

function listRepos() {
  return getDb().prepare('SELECT * FROM repos ORDER BY created_at DESC').all();
}

function deleteRepo(id) {
  return getDb().prepare('DELETE FROM repos WHERE id = ?').run(id);
}

// ============ Monitors ============
function addMonitor(data) {
  const stmt = getDb().prepare(`
    INSERT INTO monitors (repo_id, mode, auth_type, enabled, webhook_secret, webhook_url,
                          github_webhook_id, poll_interval, poll_cursor,
                          model_name, api_key, api_base_url, allowed_trigger_users)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    data.repo_id,
    data.mode,
    data.auth_type || 'user',
    data.enabled || 0,
    data.webhook_secret || null,
    data.webhook_url || null,
    data.github_webhook_id || null,
    data.poll_interval || 60,
    data.poll_cursor || null,
    data.model_name || null,
    data.api_key || null,
    data.api_base_url || null,
    data.allowed_trigger_users || null
  );
  return getMonitor(info.lastInsertRowid);
}

function getMonitor(id) {
  return getDb().prepare(`
    SELECT m.*, r.owner, r.name as repo_name, r.url as repo_url, r.default_branch
    FROM monitors m JOIN repos r ON m.repo_id = r.id
    WHERE m.id = ?
  `).get(id);
}

function listMonitors() {
  return getDb().prepare(`
    SELECT m.*, r.owner, r.name as repo_name, r.url as repo_url, r.default_branch
    FROM monitors m JOIN repos r ON m.repo_id = r.id
    ORDER BY m.created_at DESC
  `).all();
}

function listEnabledMonitors() {
  return getDb().prepare(`
    SELECT m.*, r.owner, r.name as repo_name, r.url as repo_url, r.default_branch
    FROM monitors m JOIN repos r ON m.repo_id = r.id
    WHERE m.enabled = 1
  `).all();
}

function updateMonitor(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getMonitor(id);
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(id);
  getDb().prepare(`UPDATE monitors SET ${setClause} WHERE id = ?`).run(...values);
  return getMonitor(id);
}

function setMonitorEnabled(id, enabled) {
  return getDb().prepare('UPDATE monitors SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

function deleteMonitor(id) {
  return getDb().prepare('DELETE FROM monitors WHERE id = ?').run(id);
}

// ============ Jobs ============
function addJob(data) {
  const stmt = getDb().prepare(`
    INSERT INTO jobs (monitor_id, issue_number, issue_title, issue_url, branch_name, log_path, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    data.monitor_id,
    data.issue_number,
    data.issue_title || null,
    data.issue_url || null,
    data.branch_name || null,
    data.log_path || null,
    data.status || 'pending'
  );
  return getJob(info.lastInsertRowid);
}

function getJob(id) {
  return getDb().prepare(`
    SELECT j.*, m.mode as monitor_mode, r.owner, r.name as repo_name
    FROM jobs j
    JOIN monitors m ON j.monitor_id = m.id
    JOIN repos r ON m.repo_id = r.id
    WHERE j.id = ?
  `).get(id);
}

function listJobs({ status, monitorId, repoId, limit = 100, offset = 0 } = {}) {
  let sql = `
    SELECT j.*, m.mode as monitor_mode, r.owner, r.name as repo_name
    FROM jobs j
    JOIN monitors m ON j.monitor_id = m.id
    JOIN repos r ON m.repo_id = r.id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND j.status = ?'; params.push(status); }
  if (monitorId) { sql += ' AND j.monitor_id = ?'; params.push(monitorId); }
  if (repoId) { sql += ' AND m.repo_id = ?'; params.push(repoId); }
  sql += ' ORDER BY j.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return getDb().prepare(sql).all(...params);
}

function countJobs({ status, monitorId, repoId } = {}) {
  let sql = `
    SELECT COUNT(*) as total
    FROM jobs j
    JOIN monitors m ON j.monitor_id = m.id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND j.status = ?'; params.push(status); }
  if (monitorId) { sql += ' AND j.monitor_id = ?'; params.push(monitorId); }
  if (repoId) { sql += ' AND m.repo_id = ?'; params.push(repoId); }
  return getDb().prepare(sql).get(...params).total;
}

function findActiveJobForIssue(monitorId, issueNumber) {
  return getDb().prepare(`
    SELECT * FROM jobs
    WHERE monitor_id = ? AND issue_number = ?
      AND status NOT IN ('merged', 'failed')
    ORDER BY created_at DESC LIMIT 1
  `).get(monitorId, issueNumber);
}

/**
 * 检查该 issue 是否已经被成功处理过（merged 状态）
 * 用于轮询中避免重复响应同一 issue 的评论 @mention
 */
function findMergedJobForIssue(monitorId, issueNumber) {
  return getDb().prepare(`
    SELECT * FROM jobs
    WHERE monitor_id = ? AND issue_number = ? AND status = 'merged'
    ORDER BY created_at DESC LIMIT 1
  `).get(monitorId, issueNumber);
}

/**
 * 检查该 issue 是否已经有任意 job（任意状态）
 * 用于轮询中避免对同一 issue 的 @mention 评论重复触发
 */
function findAnyJobForIssue(monitorId, issueNumber) {
  return getDb().prepare(`
    SELECT * FROM jobs
    WHERE monitor_id = ? AND issue_number = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(monitorId, issueNumber);
}

/**
 * 找出所有需要"恢复执行"的任务
 *  - pending：从未开始
 *  - cloning/branching/analyzing/fixing/testing/commenting：Phase A 中途中断，需要重跑
 *  - pr_created/awaiting_review/merging：Phase B 中途中断（已经创建 PR），重跑审核阶段
 */
function listResumableJobs() {
  return getDb().prepare(`
    SELECT * FROM jobs
    WHERE status IN (
      'pending','cloning','branching','analyzing',
      'fixing','testing','commenting',
      'pr_created','awaiting_review','merging'
    )
    ORDER BY created_at ASC
  `).all();
}

function updateJob(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getJob(id);
  fields.updated_at = nowShanghai();
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(id);
  getDb().prepare(`UPDATE jobs SET ${setClause} WHERE id = ?`).run(...values);
  return getJob(id);
}

module.exports = {
  setConfig, getConfig, getAllConfigs,
  addRepo, getRepo, getRepoByOwnerName, listRepos, deleteRepo,
  addMonitor, getMonitor, listMonitors, listEnabledMonitors,
  updateMonitor, setMonitorEnabled, deleteMonitor,
  addJob, getJob, listJobs, countJobs, findActiveJobForIssue, findMergedJobForIssue, findAnyJobForIssue, listResumableJobs, updateJob,
};
