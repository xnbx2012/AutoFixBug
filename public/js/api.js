/**
 * API 封装 — 统一错误处理与 JSON 解析
 */
const API = {
  async request(method, url, body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  },

  // Config
  getConfig()           { return this.request('GET', '/api/config'); },
  setConfig(key, value) { return this.request('POST', '/api/config', { key, value }); },
  validateApp()         { return this.request('POST', '/api/config/validate-app'); },

  // Repos
  listRepos()           { return this.request('GET', '/api/repos'); },
  addRepo(url)          { return this.request('POST', '/api/repos', { url }); },
  deleteRepo(id)        { return this.request('DELETE', `/api/repos/${id}`); },

  // Monitors
  listMonitors()        { return this.request('GET', '/api/monitors'); },
  addMonitor(data)      { return this.request('POST', '/api/monitors', data); },
  toggleMonitor(id, enabled) { return this.request('PATCH', `/api/monitors/${id}/toggle`, { enabled }); },
  deleteMonitor(id)     { return this.request('DELETE', `/api/monitors/${id}`); },
  registerWebhook(id)   { return this.request('POST', `/api/monitors/${id}/register-webhook`); },

  // Jobs
  listJobs(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/api/jobs${qs ? '?' + qs : ''}`);
  },
  getJob(id)            { return this.request('GET', `/api/jobs/${id}`); },
  getJobLog(id, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/api/jobs/${id}/log${qs ? '?' + qs : ''}`);
  },
  getJobSession(id)     { return this.request('GET', `/api/jobs/${id}/session`); },

  // Dashboard
  getDashboard()        { return this.request('GET', '/api/dashboard'); },

  // Auth
  authStatus()          { return this.request('GET', '/api/auth/status'); },
  authLogin(username, password) {
    return this.request('POST', '/api/auth/login', { username, password });
  },
  authLogout()          { return this.request('POST', '/api/auth/logout'); },
  authChangePassword(oldPassword, newPassword) {
    return this.request('POST', '/api/auth/change-password', { oldPassword, newPassword });
  },
};
