/**
 * Auto-Fix-Bug SPA — 主应用逻辑
 */
(function () {
  'use strict';

  // ============ 工具函数 ============
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }
  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') e.className = v;
      else if (k === 'innerHTML') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' && (tag === 'input' || tag === 'select' || tag === 'textarea')) e.value = v;
      else e.setAttribute(k, v);
    }
    for (const c of (Array.isArray(children) ? children : [children])) {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    }
    return e;
  }

  function toast(msg, type = 'info') {
    const t = el('div', { className: `toast toast-${type}` }, [msg]);
    $('#toast-container').appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '-';
    // DB 存储 Shanghai 无时区字符串（如 "2026-06-08T14:00:00.000"），补 +08:00 让 JS Date 按上海时区解析
    const s = /[Zz]|[+-]\d{2}:?\d{2}$/.test(dateStr) ? dateStr : dateStr + '+08:00';
    const diff = (Date.now() - new Date(s).getTime()) / 1000;
    if (diff < 60) return `${Math.floor(diff)}秒前`;
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    return `${Math.floor(diff / 86400)}天前`;
  }

  function formatDuration(ms) {
    if (ms == null || ms === 0) return '-';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}秒`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return `${min}分${remSec}秒`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}小时${remMin}分`;
  }

  function formatTokenCount(n) {
    if (n == null || n === 0) return '0';
    if (n < 1000) return String(n);
    if (n < 10000) return `${(n / 1000).toFixed(2)}K`;
    if (n < 1000000) return `${Math.round(n / 1000)}K`;
    return `${(n / 1000000).toFixed(2)}M`;
  }

  // ============ 鉴权流程 ============
  let currentUser = null;

  async function checkAuth() {
    const overlay = document.getElementById('auth-overlay');
    const box = document.getElementById('auth-box');
    if (!overlay || !box) return false;

    try {
      const status = await API.authStatus();

      if (status.passwordDefault) {
        overlay.style.display = 'flex';
        renderChangePasswordPage(box);
        return false;
      }

      if (status.authenticated) {
        overlay.style.display = 'none';
        currentUser = status.username;
        return true;
      }

      overlay.style.display = 'flex';
      renderLoginPage(box);
      return false;
    } catch (_) {
      overlay.style.display = 'flex';
      renderLoginPage(box);
      return false;
    }
  }

  function renderLoginPage(box) {
    box.innerHTML = `
      <h2 style="margin:0 0 4px;font-size:20px;color:var(--ink);">Auto-Fix-Bug</h2>
      <p style="margin:0 0 20px;font-size:13px;color:var(--muted);">请登录以继续操作</p>
      <div id="auth-error" style="display:none;margin-bottom:12px;padding:8px 12px;border-radius:8px;background:rgba(220,38,38,0.12);color:#dc2626;font-size:13px;"></div>
      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px;">账号</label>
        <input type="text" id="auth-username" style="width:100%;padding:10px 12px;border:1px solid var(--hairline);border-radius:8px;font-size:14px;background:var(--canvas);color:var(--ink);" placeholder="admin" autofocus>
      </div>
      <div style="margin-bottom:20px;">
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px;">密码</label>
        <input type="password" id="auth-password" style="width:100%;padding:10px 12px;border:1px solid var(--hairline);border-radius:8px;font-size:14px;background:var(--canvas);color:var(--ink);" placeholder="请输入密码">
      </div>
      <button id="auth-login-btn" class="btn btn-primary" style="width:100%;padding:10px;font-size:14px;">登录</button>
    `;

    box.querySelector('#auth-login-btn').addEventListener('click', async () => {
      const errBox = box.querySelector('#auth-error');
      errBox.style.display = 'none';
      try {
        await API.authLogin(
          box.querySelector('#auth-username').value.trim(),
          box.querySelector('#auth-password').value
        );
        if (await checkAuth()) { currentUser = await API.authStatus().then(s => s.username); render(); }
      } catch (e) {
        errBox.textContent = e.message;
        errBox.style.display = 'block';
      }
    });

    box.querySelector('#auth-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') box.querySelector('#auth-login-btn').click();
    });
  }

  function renderChangePasswordPage(box) {
    box.innerHTML = `
      <div style="margin-bottom:16px;padding:12px 14px;border-radius:10px;background:rgba(217,119,6,0.12);border:1px solid rgba(217,119,6,0.3);">
        <p style="margin:0;font-size:13px;font-weight:600;color:#b45309;">安全警告</p>
        <p style="margin:4px 0 0;font-size:12px;color:#92400e;">当前 ADMIN_PASSWORD 仍为默认密码 123456，必须立即修改后才能使用本系统。</p>
      </div>
      <h2 style="margin:0 0 16px;font-size:18px;color:var(--ink);">修改管理员密码</h2>
      <div id="auth-error" style="display:none;margin-bottom:12px;padding:8px 12px;border-radius:8px;background:rgba(220,38,38,0.12);color:#dc2626;font-size:13px;"></div>
      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px;">旧密码（默认：123456）</label>
        <input type="password" id="old-pw" style="width:100%;padding:10px 12px;border:1px solid var(--hairline);border-radius:8px;font-size:14px;background:var(--canvas);color:var(--ink);" autofocus>
      </div>
      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px;">新密码（至少 6 位）</label>
        <input type="password" id="new-pw" style="width:100%;padding:10px 12px;border:1px solid var(--hairline);border-radius:8px;font-size:14px;background:var(--canvas);color:var(--ink);">
      </div>
      <div style="margin-bottom:20px;">
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px;">确认新密码</label>
        <input type="password" id="confirm-pw" style="width:100%;padding:10px 12px;border:1px solid var(--hairline);border-radius:8px;font-size:14px;background:var(--canvas);color:var(--ink);">
      </div>
      <button id="auth-change-btn" class="btn btn-primary" style="width:100%;padding:10px;font-size:14px;">修改密码并登录</button>
    `;

    box.querySelector('#auth-change-btn').addEventListener('click', async () => {
      const errBox = box.querySelector('#auth-error');
      errBox.style.display = 'none';
      const oldPw = box.querySelector('#old-pw').value;
      const newPw = box.querySelector('#new-pw').value;
      const confirmPw = box.querySelector('#confirm-pw').value;
      if (!oldPw || !newPw) { errBox.textContent = '请填写所有字段'; errBox.style.display = 'block'; return; }
      if (newPw !== confirmPw) { errBox.textContent = '两次输入的新密码不一致'; errBox.style.display = 'block'; return; }
      if (newPw.length < 6) { errBox.textContent = '新密码长度至少为 6 位'; errBox.style.display = 'block'; return; }
      try {
        await API.authChangePassword(oldPw, newPw);
        if (await checkAuth()) render();
      } catch (e) {
        errBox.textContent = e.message;
        errBox.style.display = 'block';
      }
    });

    box.querySelector('#confirm-pw').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') box.querySelector('#auth-change-btn').click();
    });
  }

  function renderHeaderUser() {
    const hr = $('.header-right');
    if (!hr || !currentUser) return;
    const userDiv = el('div', { style: 'display:flex;align-items:center;gap:10px;' }, [
      el('span', { style: 'font-size:13px;color:var(--muted);' }, [currentUser]),
      el('button', {
        className: 'btn btn-ghost btn-sm',
        style: 'font-size:12px;padding:4px 10px;',
        onClick: doLogout
      }, ['退出']),
    ]);
    hr.prepend(userDiv);
  }

  async function doLogout() {
    try { await API.authLogout(); } catch (_) {}
    location.reload();
  }

  // ============ Tab 切换 ============
  let currentTab = 'dashboard';

  function switchTab(tab) {
    currentTab = tab;
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    render();
  }

  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // ============ 页面渲染 ============
  async function render() {
    const content = $('#content');
    content.innerHTML = '';
    try {
      switch (currentTab) {
        case 'dashboard': return await renderDashboard(content);
        case 'config':   return await renderConfig(content);
        case 'repos':    return await renderRepos(content);
        case 'monitors': return await renderMonitors(content);
        case 'jobs':     return await renderJobs(content);
      }
    } catch (err) {
      content.appendChild(el('div', { className: 'card' }, [
        el('div', { className: 'empty' }, [
          el('div', { className: 'empty-icon' }, ['!']),
          el('div', { className: 'empty-text' }, [`加载失败: ${err.message}`]),
        ])
      ]));
    }
  }

  // ============ Tab 1: 配置 ============
  async function renderConfig(container) {
    const cfg = await API.getConfig();

    // 页面标题
    container.appendChild(el('h1', { className: 'section-title' }, ['系统配置']));
    container.appendChild(el('p', { className: 'section-subtitle' }, ['管理 GitHub 连接与审核设置']));

    // Token 卡片
    const card = el('div', { className: 'card' });
    card.appendChild(el('h2', {}, ['GitHub Token']));

    const tokenStatus = cfg.github_token?.configured
      ? el('span', { className: 'badge badge-active' }, ['已配置'])
      : el('span', { className: 'badge badge-inactive' }, ['未配置']);

    card.appendChild(el('div', { className: 'info-box' }, [
      'GitHub Personal Access Token 用于访问 GitHub API。需要 ',
      el('code', {}, ['repo']),
      '、',
      el('code', {}, ['admin:repo_hook']),
      ' 权限。Token 以 AES-256-GCM 加密存储。',
    ]));

    const tokenGroup = el('div', { className: 'form-group' });
    tokenGroup.appendChild(el('label', {}, ['GitHub Token ', tokenStatus]));
    tokenGroup.appendChild(el('input', { type: 'password', placeholder: 'ghp_xxxxxxxxxxxx', id: 'github-token' }));
    card.appendChild(tokenGroup);

    const tokenBtn = el('button', { className: 'btn btn-primary', onClick: async () => {
      const val = $('#github-token').value.trim();
      if (!val) return toast('请输入 Token', 'error');
      try {
        tokenBtn.disabled = true;
        const res = await API.setConfig('github_token', val);
        toast(res.message, 'success');
        $('#github-token').value = '';
        render();
      } catch (err) { toast(err.message, 'error'); }
      finally { tokenBtn.disabled = false; }
    }}, ['保存 Token']);
    card.appendChild(tokenBtn);
    container.appendChild(card);

    // ============ GitHub App 卡片 ============
    const appCard = el('div', { className: 'card' });
    appCard.appendChild(el('h2', {}, ['GitHub App']));

    const appConfigured = !!cfg.github_app_id && !!cfg.github_app_private_key?.configured
      && !!cfg.github_app_client_id && !!cfg.github_app_client_secret?.configured;
    const appBadge = appConfigured
      ? el('span', { className: 'badge badge-active' }, ['已配置'])
      : el('span', { className: 'badge badge-inactive' }, ['未配置']);

    appCard.appendChild(el('div', { className: 'info-box' }, [
      'GitHub App 是推荐的身份认证方式。配置后，所有评论、PR、合并等操作将以 App 身份执行。',
      el('br'),
      el('br'),
      '需要填写: App ID、App Private Key (.pem)、App Client ID、App Client Secret。',
      el('br'),
      '前两个用于服务端调用 API；后两个用于 OAuth 流程（可选）。',
    ]));

    const appHeaderRow = el('div', { className: 'card-header' });
    appHeaderRow.appendChild(appBadge);
    appCard.appendChild(appHeaderRow);

    // App ID
    const appIdGroup = el('div', { className: 'form-group' });
    appIdGroup.appendChild(el('label', {}, ['App ID']));
    appIdGroup.appendChild(el('input', {
      type: 'text',
      placeholder: '123456',
      id: 'app-id',
      value: cfg.github_app_id || '',
    }));
    appCard.appendChild(appIdGroup);

    // Private Key
    const appKeyGroup = el('div', { className: 'form-group' });
    const keyStatus = cfg.github_app_private_key?.configured
      ? el('span', { className: 'badge badge-active' }, ['已配置'])
      : el('span', { className: 'badge badge-inactive' }, ['未配置']);
    appKeyGroup.appendChild(el('label', {}, ['App Private Key (.pem) ', keyStatus]));
    appKeyGroup.appendChild(el('textarea', {
      placeholder: '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----',
      id: 'app-private-key',
      rows: 4,
      style: 'font-family:monospace;font-size:12px;',
    }));
    appCard.appendChild(appKeyGroup);

    // Client ID
    const clientIdGroup = el('div', { className: 'form-group' });
    clientIdGroup.appendChild(el('label', {}, ['App Client ID']));
    clientIdGroup.appendChild(el('input', {
      type: 'text',
      placeholder: 'Iv1.xxxxxxxxx',
      id: 'app-client-id',
      value: cfg.github_app_client_id || '',
    }));
    appCard.appendChild(clientIdGroup);

    // Client Secret
    const clientSecretGroup = el('div', { className: 'form-group' });
    const secretStatus = cfg.github_app_client_secret?.configured
      ? el('span', { className: 'badge badge-active' }, ['已配置'])
      : el('span', { className: 'badge badge-inactive' }, ['未配置']);
    clientSecretGroup.appendChild(el('label', {}, ['App Client Secret ', secretStatus]));
    clientSecretGroup.appendChild(el('input', {
      type: 'password',
      placeholder: cfg.github_app_client_secret?.configured ? '（已配置，留空保留原值）' : 'App Client Secret',
      id: 'app-client-secret',
    }));
    appCard.appendChild(clientSecretGroup);

    const appBtn = el('button', { className: 'btn btn-primary', onClick: async () => {
      try {
        appBtn.disabled = true;
        const appId = $('#app-id').value.trim();
        const privateKey = $('#app-private-key').value.trim();
        const clientId = $('#app-client-id').value.trim();
        const clientSecret = $('#app-client-secret').value.trim();

        if (appId) await API.setConfig('github_app_id', appId);
        if (privateKey) await API.setConfig('github_app_private_key', privateKey);
        if (clientId) await API.setConfig('github_app_client_id', clientId);
        if (clientSecret) await API.setConfig('github_app_client_secret', clientSecret);

        toast('GitHub App 配置已保存', 'success');
        $('#app-private-key').value = '';
        $('#app-client-secret').value = '';
        render();
      } catch (err) { toast(err.message, 'error'); }
      finally { appBtn.disabled = false; }
    }}, ['保存 GitHub App 配置']);
    appCard.appendChild(appBtn);

    // Validate 按钮
    const validateAppBtn = el('button', { className: 'btn btn-secondary', style: 'margin-left:8px;', onClick: async () => {
      try {
        validateAppBtn.disabled = true;
        const res = await API.validateApp();
        toast(`App 验证成功，已安装 ${res.installations?.length || 0} 个仓库`, 'success');
      } catch (err) { toast(`App 验证失败: ${err.message}`, 'error'); }
      finally { validateAppBtn.disabled = false; }
    }}, ['验证 App 配置']);
    appCard.appendChild(validateAppBtn);

    container.appendChild(appCard);

    // Reviewer 卡片
    const card2 = el('div', { className: 'card' });
    card2.appendChild(el('h2', {}, ['默认代码审核人 & 合并方式']));
    card2.appendChild(el('div', { className: 'info-box' }, [
      '指定 GitHub 用户名作为 PR 的默认审核人。PR 必须配置审核人才能创建。',
      el('br'),
      el('br'),
      '审核通过后，PR 将自动合并。合并前会自动解决冲突（保留当前分支内容）。',
    ]));

    const reviewerGroup = el('div', { className: 'form-group' });
    reviewerGroup.appendChild(el('label', {}, ['审核人 GitHub 用户名（必填）']));
    reviewerGroup.appendChild(el('input', {
      type: 'text',
      placeholder: 'username',
      id: 'reviewer-input',
      value: cfg.reviewer_username || '',
    }));
    card2.appendChild(reviewerGroup);

    const mergeMethodGroup = el('div', { className: 'form-group' });
    mergeMethodGroup.appendChild(el('label', {}, ['自动合并方式']));
    const mergeMethodSelect = el('select', { id: 'merge-method-select' });
    ['merge', 'rebase', 'squash'].forEach(m => {
      const opt = el('option', { value: m }, [
        m === 'merge' ? '普通 Merge（保留所有提交历史）'
        : m === 'rebase' ? 'Rebase（线性历史，无 merge commit）'
        : 'Squash（合并为单个 commit）',
      ]);
      if ((cfg.merge_method || 'merge') === m) opt.selected = true;
      mergeMethodSelect.appendChild(opt);
    });
    mergeMethodGroup.appendChild(mergeMethodSelect);
    card2.appendChild(mergeMethodGroup);

    const reviewerBtn = el('button', { className: 'btn btn-primary', onClick: async () => {
      try {
        reviewerBtn.disabled = true;
        const reviewerVal = $('#reviewer-input').value.trim();
        if (!reviewerVal) {
          toast('请填写审核人用户名', 'error');
          return;
        }
        const mergeMethodVal = $('#merge-method-select').value;
        const res1 = await API.setConfig('reviewer_username', reviewerVal);
        toast(res1.message, 'success');
        const res2 = await API.setConfig('merge_method', mergeMethodVal);
        toast(res2.message, 'success');
      } catch (err) { toast(err.message, 'error'); }
      finally { reviewerBtn.disabled = false; }
    }}, ['保存审核人 & 合并方式']);
    card2.appendChild(reviewerBtn);
    container.appendChild(card2);

    // Trigger Mention 卡片
    const card3 = el('div', { className: 'card' });
    card3.appendChild(el('h2', {}, ['触发@提及名称']));
    card3.appendChild(el('div', { className: 'info-box' }, [
      '设置后，仅当用户在 Issue 标题/内容/评论或 PR 内容/评论中 @ 此名称时才触发自动修复。',
      el('br'),
      el('br'),
      '留空 = 禁用此过滤（处理所有 Issue/评论事件）。默认为 ',
      el('code', {}, ['@cc']),
      '。',
    ]));

    const mentionGroup = el('div', { className: 'form-group' });
    mentionGroup.appendChild(el('label', {}, ['触发名称（含或不含 @ 均可）']));
    mentionGroup.appendChild(el('input', {
      type: 'text',
      placeholder: '@cc',
      id: 'trigger-mention-input',
      value: cfg.trigger_mention || '@cc',
    }));
    card3.appendChild(mentionGroup);

    const mentionBtn = el('button', { className: 'btn btn-primary', onClick: async () => {
      try {
        mentionBtn.disabled = true;
        const val = $('#trigger-mention-input').value.trim();
        const res = await API.setConfig('trigger_mention', val);
        toast(res.message, 'success');
      } catch (err) { toast(err.message, 'error'); }
      finally { mentionBtn.disabled = false; }
    }}, ['保存']);
    card3.appendChild(mentionBtn);
    container.appendChild(card3);
  }

  // ============ Tab 2: 仓库 ============
  async function renderRepos(container) {
    const repos = await API.listRepos();

    container.appendChild(el('h1', { className: 'section-title' }, ['仓库管理']));
    container.appendChild(el('p', { className: 'section-subtitle' }, ['添加和管理需要自动修复的 GitHub 仓库']));

    // 添加表单
    const addCard = el('div', { className: 'card' });
    addCard.appendChild(el('h2', {}, ['添加仓库']));
    const addRow = el('div', { className: 'form-row' });
    const urlGroup = el('div', { className: 'form-group' });
    urlGroup.appendChild(el('label', {}, ['仓库 URL']));
    urlGroup.appendChild(el('input', { type: 'text', placeholder: 'https://github.com/owner/repo', id: 'repo-url' }));
    addRow.appendChild(urlGroup);

    const addBtn = el('button', { className: 'btn btn-primary', onClick: async () => {
      const url = $('#repo-url').value.trim();
      if (!url) return toast('请输入仓库 URL', 'error');
      try {
        addBtn.disabled = true;
        const res = await API.addRepo(url);
        toast(res.message || '仓库已添加', 'success');
        $('#repo-url').value = '';
        render();
      } catch (err) { toast(err.message, 'error'); }
      finally { addBtn.disabled = false; }
    }}, ['添加']);
    addRow.appendChild(el('div', { className: 'form-group' }, [addBtn]));
    addCard.appendChild(addRow);
    container.appendChild(addCard);

    // 仓库列表
    const listCard = el('div', { className: 'card' });
    const headerRow = el('div', { className: 'card-header' });
    headerRow.appendChild(el('h2', {}, [`仓库列表`]));
    headerRow.appendChild(el('span', { className: 'badge badge-active' }, [`${repos.length} 个`]));
    listCard.appendChild(headerRow);

    if (repos.length === 0) {
      listCard.appendChild(el('div', { className: 'empty' }, [
        el('div', { className: 'empty-text' }, ['暂无仓库，请先添加']),
      ]));
    } else {
      const table = el('table');
      table.innerHTML = `<thead><tr><th>仓库</th><th>Owner</th><th>默认分支</th><th>添加时间</th><th>操作</th></tr></thead>`;
      const tbody = el('tbody');
      repos.forEach(r => {
        const tr = el('tr');
        tr.innerHTML = `
          <td><strong style="color:var(--ink)">${r.name}</strong></td>
          <td>${r.owner}</td>
          <td><code>${r.default_branch}</code></td>
          <td style="color:var(--muted);font-size:13px;">${timeAgo(r.created_at)}</td>
          <td></td>
        `;
        const actionTd = tr.querySelector('td:last-child');
        const delBtn = el('button', { className: 'btn btn-danger btn-sm', onClick: async () => {
          if (!confirm(`确定删除仓库 ${r.owner}/${r.name}？关联的监控任务也会一并删除。`)) return;
          try {
            await API.deleteRepo(r.id);
            toast('仓库已删除', 'success');
            render();
          } catch (err) { toast(err.message, 'error'); }
        }}, ['删除']);
        actionTd.appendChild(delBtn);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      const wrap = el('div', { className: 'table-wrap' });
      wrap.appendChild(table);
      listCard.appendChild(wrap);
    }
    container.appendChild(listCard);
  }

  // ============ Tab 3: 监控 ============
  async function renderMonitors(container) {
    const [monitors, repos, cfg] = await Promise.all([API.listMonitors(), API.listRepos(), API.getConfig()]);

    container.appendChild(el('h1', { className: 'section-title' }, ['监控任务']));
    container.appendChild(el('p', { className: 'section-subtitle' }, ['配置 Issue 自动修复的监控策略']));

    // 添加表单
    const addCard = el('div', { className: 'card' });
    addCard.appendChild(el('h2', {}, ['新建监控任务']));

    if (repos.length === 0) {
      addCard.appendChild(el('div', { className: 'info-box' }, ['请先在"仓库"标签页添加仓库']));
    } else {
      const form = el('div');

      // 选择仓库
      const repoGroup = el('div', { className: 'form-group' });
      repoGroup.appendChild(el('label', {}, ['选择仓库']));
      const repoSelect = el('select', { id: 'monitor-repo' });
      repos.forEach(r => {
        repoSelect.appendChild(el('option', { value: String(r.id) }, [`${r.owner}/${r.name}`]));
      });
      repoGroup.appendChild(repoSelect);
      form.appendChild(repoGroup);

      // 认证方式选择
      const authTypeGroup = el('div', { className: 'form-group' });
      authTypeGroup.appendChild(el('label', {}, ['认证方式']));
      const authTypeSelect = el('select', { id: 'monitor-auth-type' });
      authTypeSelect.appendChild(el('option', { value: 'user' }, ['Personal Access Token (PAT)']));
      const appConfigured = !!cfg.github_app_id && !!cfg.github_app_private_key?.configured
        && !!cfg.github_app_client_id && !!cfg.github_app_client_secret?.configured;
      const appOpt = el('option', { value: 'app' }, ['GitHub App（推荐）']);
      if (!appConfigured) appOpt.disabled = true;
      authTypeSelect.appendChild(appOpt);
      if (!appConfigured) {
        authTypeGroup.appendChild(el('div', { className: 'info-box', style: 'margin-top:8px;' }, [
          'GitHub App 模式需要在配置页先填写 App 凭据。',
        ]));
      }
      authTypeGroup.appendChild(authTypeSelect);
      form.appendChild(authTypeGroup);

      // 选择模式
      const modeGroup = el('div', { className: 'form-group' });
      modeGroup.appendChild(el('label', {}, ['监控模式']));
      const modeSelect = el('select', { id: 'monitor-mode' });
      modeSelect.appendChild(el('option', { value: 'webhook' }, ['Webhook（推荐 - 实时推送）']));
      modeSelect.appendChild(el('option', { value: 'poll', className: 'opt-user' }, ['REST API 轮询 (PAT)']));
      modeSelect.appendChild(el('option', { value: 'app_poll', className: 'opt-app' }, ['GitHub App 轮询']));
      modeGroup.appendChild(modeSelect);
      form.appendChild(modeGroup);

      // 轮询间隔
      const intervalGroup = el('div', { className: 'form-group', id: 'interval-group', style: 'display:none' });
      intervalGroup.appendChild(el('label', {}, ['轮询间隔（秒）']));
      intervalGroup.appendChild(el('input', { type: 'number', id: 'poll-interval', value: '60', min: '10', max: '3600' }));
      form.appendChild(intervalGroup);

      // Webhook Secret
      const secretGroup = el('div', { className: 'form-group', id: 'secret-group' });
      secretGroup.appendChild(el('label', {}, ['Webhook Secret（留空自动生成）']));
      secretGroup.appendChild(el('input', { type: 'text', id: 'webhook-secret', placeholder: '自定义密钥（可选）' }));
      form.appendChild(secretGroup);

      // 自定义 Agent 配置（可选）
      const agentConfigCard = el('div', { className: 'card', style: 'margin-top:16px;' });
      agentConfigCard.appendChild(el('h3', {}, ['自定义 Agent 配置（可选）']));

      const modelGroup = el('div', { className: 'form-group' });
      modelGroup.appendChild(el('label', {}, ['模型名称']));
      modelGroup.appendChild(el('input', { type: 'text', id: 'monitor-model', placeholder: '如 sonnet / opus / haiku（留空使用默认 sonnet）' }));
      agentConfigCard.appendChild(modelGroup);

      const apiKeyGroup = el('div', { className: 'form-group' });
      apiKeyGroup.appendChild(el('label', {}, ['API Key']));
      apiKeyGroup.appendChild(el('input', { type: 'password', id: 'monitor-api-key', placeholder: '自定义 Anthropic API Key（留空使用全局配置）' }));
      agentConfigCard.appendChild(apiKeyGroup);

      const apiBaseGroup = el('div', { className: 'form-group' });
      apiBaseGroup.appendChild(el('label', {}, ['API Base URL']));
      apiBaseGroup.appendChild(el('input', { type: 'text', id: 'monitor-api-base', placeholder: '自定义 API 地址（留空使用默认）' }));
      agentConfigCard.appendChild(apiBaseGroup);

      // 允许的触发人列表（可选）
      const allowedUsersGroup = el('div', { className: 'form-group' });
      allowedUsersGroup.appendChild(el('label', {}, ['允许的触发人（逗号分隔，留空则不限制）']));
      allowedUsersGroup.appendChild(el('input', { type: 'text', id: 'monitor-allowed-users', placeholder: '如 alice, bob, charlie' }));
      agentConfigCard.appendChild(allowedUsersGroup);

      form.appendChild(agentConfigCard);

      const updateModeOptions = () => {
        const auth = authTypeSelect.value;
        // 根据 auth_type 过滤可用的 mode 选项
        const userOpts = modeSelect.querySelectorAll('option.opt-user');
        const appOpts = modeSelect.querySelectorAll('option.opt-app');
        userOpts.forEach(o => o.style.display = auth === 'user' ? '' : 'none');
        appOpts.forEach(o => o.style.display = auth === 'app' ? '' : 'none');

        // 若当前选中项对当前 auth_type 无效，切回 webhook
        const cur = modeSelect.querySelector(`option[value="${modeSelect.value}"]`);
        if (cur && (cur.classList.contains('opt-user') && auth !== 'user' ||
                    cur.classList.contains('opt-app') && auth !== 'app')) {
          modeSelect.value = 'webhook';
          updateModeFields();
        }
      };

      const updateModeFields = () => {
        const isPoll = modeSelect.value === 'poll' || modeSelect.value === 'app_poll';
        intervalGroup.style.display = isPoll ? '' : 'none';
        secretGroup.style.display = isPoll ? 'none' : '';
      };

      authTypeSelect.addEventListener('change', updateModeOptions);
      modeSelect.addEventListener('change', updateModeFields);
      updateModeOptions();
      updateModeFields();

      const addBtn = el('button', { className: 'btn btn-primary', onClick: async () => {
        try {
          addBtn.disabled = true;
          const data = {
            repo_id: parseInt(repoSelect.value, 10),
            mode: modeSelect.value,
            auth_type: authTypeSelect.value,
          };
          if (data.mode === 'poll' || data.mode === 'app_poll') {
            data.poll_interval = parseInt($('#poll-interval').value, 10) || 60;
          } else {
            const secret = $('#webhook-secret').value.trim();
            if (secret) data.webhook_secret = secret;
          }
          // 自定义 Agent 配置（可选，仅在填写时传递）
          const modelName = $('#monitor-model').value.trim();
          const apiKey    = $('#monitor-api-key').value.trim();
          const apiBase   = $('#monitor-api-base').value.trim();
          if (modelName) data.model_name   = modelName;
          if (apiKey)    data.api_key       = apiKey;
          if (apiBase)   data.api_base_url  = apiBase;
          // 允许的触发人列表（可选，留空则不限制）
          const allowedUsers = $('#monitor-allowed-users').value.trim();
          if (allowedUsers) data.allowed_trigger_users = allowedUsers;
          await API.addMonitor(data);
          toast('监控任务已创建', 'success');
          render();
        } catch (err) { toast(err.message, 'error'); }
        finally { addBtn.disabled = false; }
      }}, ['创建监控']);
      form.appendChild(addBtn);
      addCard.appendChild(form);
    }
    container.appendChild(addCard);

    // 监控列表
    const listCard = el('div', { className: 'card' });
    const headerRow = el('div', { className: 'card-header' });
    headerRow.appendChild(el('h2', {}, ['监控列表']));
    headerRow.appendChild(el('span', { className: 'badge badge-active' }, [`${monitors.length} 个`]));
    listCard.appendChild(headerRow);

    if (monitors.length === 0) {
      listCard.appendChild(el('div', { className: 'empty' }, [
        el('div', { className: 'empty-text' }, ['暂无监控任务']),
      ]));
    } else {
      const table = el('table');
      table.innerHTML = `<thead><tr><th>仓库</th><th>模式</th><th>认证</th><th>状态</th><th>详情</th><th>操作</th></tr></thead>`;
      const tbody = el('tbody');

      const modeText = (mode) => {
        if (mode === 'webhook') return 'Webhook';
        if (mode === 'poll') return 'PAT 轮询';
        if (mode === 'app_poll') return 'App 轮询';
        return mode;
      };

      for (const m of monitors) {
        const tr = el('tr');

        // Toggle 开关
        const toggleLabel = el('label', { className: 'toggle' });
        const toggleInput = el('input', { type: 'checkbox' });
        if (m.enabled) toggleInput.checked = true;
        toggleInput.addEventListener('change', async () => {
          try {
            await API.toggleMonitor(m.id, toggleInput.checked);
            toast(`监控已${toggleInput.checked ? '启动' : '停止'}`, 'success');
          } catch (err) {
            toggleInput.checked = !toggleInput.checked;
            toast(err.message, 'error');
          }
        });
        toggleLabel.appendChild(toggleInput);
        toggleLabel.appendChild(el('span', { className: 'slider' }));

        // 详情信息
        let detail = '-';
        if (m.mode === 'webhook') {
          detail = m.webhook_url
            ? `URL: ${m.webhook_url}${m.github_webhook_id ? ' (已注册)' : ' (未注册)'}`
            : '-';
        } else {
          detail = `间隔: ${m.poll_interval}秒`;
        }
        // 自定义 Agent 配置提示
        const customTags = [];
        if (m.model_name)   customTags.push(`模型:${m.model_name}`);
        if (m.api_key)      customTags.push('API Key ✓');
        if (m.api_base_url) customTags.push(`URL:${m.api_base_url}`);
        if (m.allowed_trigger_users) customTags.push(`仅: ${m.allowed_trigger_users}`);

        // 操作按钮
        const actionsTd = el('td');
        const actionsDiv = el('div', { className: 'actions' });

        if (m.mode === 'webhook' && !m.github_webhook_id) {
          const regBtn = el('button', { className: 'btn btn-secondary btn-sm', onClick: async () => {
            try {
              regBtn.disabled = true;
              const res = await API.registerWebhook(m.id);
              toast(res.message, 'success');
              render();
            } catch (err) { toast(err.message, 'error'); }
            finally { regBtn.disabled = false; }
          }}, ['注册 Webhook']);
          actionsDiv.appendChild(regBtn);
        }

        if (m.mode === 'webhook' && m.webhook_url) {
          const copyBtn = el('button', { className: 'btn btn-secondary btn-sm', onClick: () => {
            navigator.clipboard.writeText(m.webhook_url).then(
              () => toast('Webhook URL 已复制', 'success'),
              () => toast('复制失败', 'error')
            );
          }}, ['复制 URL']);
          actionsDiv.appendChild(copyBtn);
        }

        const delBtn = el('button', { className: 'btn btn-danger btn-sm', onClick: async () => {
          if (!confirm('确定删除此监控任务？')) return;
          try {
            await API.deleteMonitor(m.id);
            toast('监控已删除', 'success');
            render();
          } catch (err) { toast(err.message, 'error'); }
        }}, ['删除']);
        actionsDiv.appendChild(delBtn);
        actionsTd.appendChild(actionsDiv);

        const modeBadge = m.mode === 'webhook'
          ? 'badge-active'
          : (m.mode === 'app_poll' ? 'badge-info' : 'badge-pending');
        const authBadge = (m.auth_type || 'user') === 'app'
          ? 'badge-info'
          : 'badge-pending';
        const authText = (m.auth_type || 'user') === 'app' ? 'GitHub App' : 'PAT';

        tr.innerHTML = `
          <td><strong style="color:var(--ink)">${m.owner}/${m.repo_name}</strong></td>
          <td><span class="badge ${modeBadge}">${modeText(m.mode)}</span></td>
          <td><span class="badge ${authBadge}">${authText}</span></td>
          <td></td>
          <td style="font-size:13px;color:var(--muted);word-break:break-all;">${detail}${customTags.length ? '<div style="margin-top:4px;">' + customTags.map(t => `<span class="badge badge-info" style="margin-right:4px;font-size:11px;">${t}</span>`).join('') + '</div>' : ''}</td>
        `;
        tr.children[2].appendChild(toggleLabel);
        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
      }

      table.appendChild(tbody);
      const wrap = el('div', { className: 'table-wrap' });
      wrap.appendChild(table);
      listCard.appendChild(wrap);
    }
    container.appendChild(listCard);
  }

  // ============ Tab 4: 任务日志 ============
  async function renderJobs(container) {
    const pageSize = 20;
    let currentPage = 1;
    let currentRepoId = '';
    const [jobsData, repos] = await Promise.all([API.listJobs({ page: currentPage, pageSize }), API.listRepos()]);
    let pagination = jobsData;

    container.appendChild(el('h1', { className: 'section-title' }, ['任务日志']));
    container.appendChild(el('p', { className: 'section-subtitle' }, ['查看自动修复任务的执行记录与状态']));

    const card = el('div', { className: 'card' });
    const headerRow = el('div', { className: 'card-header' });
    headerRow.appendChild(el('h2', {}, ['任务列表']));
    const headerRight = el('div', { style: 'display:flex;align-items:center;gap:12px;' });
    const countBadge = el('span', { className: 'badge badge-active' }, [`${pagination.total} 条`]);
    headerRight.appendChild(countBadge);
    const refreshBtn = el('button', { className: 'btn btn-secondary btn-sm', onClick: () => render() }, ['刷新']);
    headerRight.appendChild(refreshBtn);
    headerRow.appendChild(headerRight);
    card.appendChild(headerRow);

    const filterRow = el('div', { style: 'display:flex;align-items:center;gap:12px;padding:0 0 16px;' });
    filterRow.appendChild(el('label', { style: 'color:var(--muted);font-size:13px;' }, ['所属仓库:']));
    const repoFilter = el('select', { id: 'jobs-repo-filter', style: 'min-width:240px;' });
    repoFilter.appendChild(el('option', { value: '' }, ['全部仓库']));
    repos.forEach(r => {
      repoFilter.appendChild(el('option', { value: String(r.id) }, [`${r.owner}/${r.name}`]));
    });
    filterRow.appendChild(repoFilter);
    card.appendChild(filterRow);

    const table = el('table');
    table.innerHTML = `<thead><tr><th>#</th><th>Issue</th><th>仓库</th><th>分支</th><th>状态</th><th>耗时</th><th>输入Token</th><th>输出Token</th><th>缓存命中</th><th>创建时间</th><th>操作</th></tr></thead>`;
    const tbody = el('tbody');
    const emptyRow = () => {
      const tr = el('tr');
      tr.innerHTML = `<td colspan="11" style="text-align:center;color:var(--muted);padding:24px;">暂无任务记录</td>`;
      tbody.replaceChildren(tr);
    };

    const pager = el('div', { style: 'display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px;' });
    const pageInfo = el('span', { style: 'color:var(--muted);font-size:13px;' }, ['']);
    const prevBtn = el('button', { className: 'btn btn-secondary btn-sm' }, ['上一页']);
    const nextBtn = el('button', { className: 'btn btn-secondary btn-sm' }, ['下一页']);
    pager.appendChild(pageInfo);
    pager.appendChild(prevBtn);
    pager.appendChild(nextBtn);

    const renderRow = (j) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td style="color:var(--muted);font-size:13px;">${j.id}</td>
        <td><a class="link" href="${j.issue_url}" target="_blank">#${j.issue_number}</a> <span style="color:var(--muted);font-size:13px;">${j.issue_title || ''}</span></td>
        <td style="color:var(--body-strong);">${j.owner}/${j.repo_name}</td>
        <td><code>${j.branch_name || '-'}</code></td>
        <td><span class="badge badge-${j.status}">${j.status}</span></td>
        <td style="color:var(--body-strong);font-variant-numeric:tabular-nums;">${formatDuration(j.duration_ms)}</td>
        <td style="color:var(--body-strong);font-variant-numeric:tabular-nums;" title="${j.input_tokens || 0}">${formatTokenCount(j.input_tokens)}</td>
        <td style="color:var(--body-strong);font-variant-numeric:tabular-nums;" title="${j.output_tokens || 0}">${formatTokenCount(j.output_tokens)}</td>
        <td style="color:var(--body-strong);font-variant-numeric:tabular-nums;" title="${j.cache_read_input_tokens || 0}">${formatTokenCount(j.cache_read_input_tokens)}</td>
        <td style="color:var(--muted);font-size:13px;">${timeAgo(j.created_at)}</td>
        <td></td>
      `;
      const actionsTd = tr.querySelector('td:last-child');
      const logBtn = el('button', { className: 'btn btn-secondary btn-sm', onClick: async () => {
        try {
          const { log } = await API.getJobLog(j.id);
          showLogModal(j, log);
        } catch (err) { toast(err.message, 'error'); }
      }}, ['查看日志']);
      const sessionBtn = el('button', { className: 'btn btn-secondary btn-sm', style: 'margin-left:4px;', onClick: async () => {
        try {
          const { session } = await API.getJobSession(j.id);
          showSessionModal(j, session);
        } catch (err) { toast(err.message, 'error'); }
      }}, ['查看会话']);
      actionsTd.appendChild(logBtn);
      actionsTd.appendChild(sessionBtn);
      if (j.pr_url) {
        const prBtn = el('button', { className: 'btn btn-secondary btn-sm', style: 'margin-left:4px;', onClick: () => {
          window.open(j.pr_url, '_blank');
        }}, ['查看 PR']);
        actionsTd.appendChild(prBtn);
      }
      return tr;
    };

    const updatePager = () => {
      countBadge.textContent = `${pagination.total} 条`;
      pageInfo.textContent = `第 ${pagination.page} / ${pagination.totalPages} 页，每页 ${pagination.pageSize} 条`;
      if (pagination.page <= 1) prevBtn.setAttribute('disabled', 'disabled');
      else prevBtn.removeAttribute('disabled');
      if (pagination.page >= pagination.totalPages) nextBtn.setAttribute('disabled', 'disabled');
      else nextBtn.removeAttribute('disabled');
    };

    const renderRows = (rows) => {
      tbody.replaceChildren();
      if (rows.length === 0) emptyRow();
      else rows.forEach(j => tbody.appendChild(renderRow(j)));
      updatePager();
    };

    const loadPage = async (page) => {
      const params = { page, pageSize };
      if (currentRepoId) params.repoId = currentRepoId;
      pagination = await API.listJobs(params);
      currentPage = pagination.page;
      renderRows(pagination.items);
    };

    repoFilter.addEventListener('change', async () => {
      currentRepoId = repoFilter.value;
      await loadPage(1);
    });
    prevBtn.addEventListener('click', () => loadPage(currentPage - 1));
    nextBtn.addEventListener('click', () => loadPage(currentPage + 1));

    renderRows(pagination.items);
    table.appendChild(tbody);
    const wrap = el('div', { className: 'table-wrap' });
    wrap.appendChild(table);
    card.appendChild(wrap);
    card.appendChild(pager);

    container.appendChild(card);
  }

  // ============ Tab 1: Dashboard ============
  const STATUS_LABELS = {
    merged: '已合并', pr_created: 'PR 已创建', awaiting_review: '等待审核',
    failed: '失败', pending: '等待中', cloning: '克隆中', branching: '创建分支',
    analyzing: '分析中', fixing: '修复中', testing: '测试中', commenting: '评论中', merging: '合并中',
  };
  const STATUS_COLORS = {
    merged: '#5db872', pr_created: '#e8a55a', awaiting_review: '#d4a017',
    failed: '#c64545', pending: '#8e8b82', cloning: '#cc785c', branching: '#cc785c',
    analyzing: '#cc785c', fixing: '#cc785c', testing: '#cc785c', commenting: '#8e8b82', merging: '#d4a017',
  };
  // 热力图色阶
  const HEATMAP_COLORS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];

  // ============ ECharts 实例管理 ============
  // 维护当前页面上的 echarts 实例，用于：重渲染前销毁旧实例、窗口尺寸变化时自适应
  const echartsInstances = {};

  // 获取或创建指定容器上的 echarts 实例（先销毁旧实例，避免重复绑定）
  function getChart(domId) {
    const dom = document.getElementById(domId);
    if (!dom || !window.echarts) return null;
    if (echartsInstances[domId]) {
      echartsInstances[domId].dispose();
    }
    const inst = echarts.init(dom);
    echartsInstances[domId] = inst;
    return inst;
  }

  // 销毁所有现存 echarts 实例（Dashboard 重渲染前调用）
  function disposeAllCharts() {
    for (const id of Object.keys(echartsInstances)) {
      try { echartsInstances[id].dispose(); } catch (_) {}
      delete echartsInstances[id];
    }
  }

  // 窗口尺寸变化时让所有图表自适应容器宽度
  window.addEventListener('resize', () => {
    for (const id of Object.keys(echartsInstances)) {
      try { echartsInstances[id].resize(); } catch (_) {}
    }
  });

  async function renderDashboard(container) {
    // 销毁上一轮的 echarts 实例，防止内存泄漏与重复绑定
    disposeAllCharts();
    container.appendChild(el('h1', { className: 'section-title' }, ['Dashboard']));
    container.appendChild(el('p', { className: 'section-subtitle' }, ['Issue 修复全局概览与数据洞察']));

    const data = await API.getDashboard();
    const { kpi, heatmap, tokenTrend, repoIssues, prStatus, durationByMonth, recentJobs } = data;

    // ---- KPI 卡片 ----
    const kpiRow = el('div', { className: 'dash-kpi-row' });
    kpiRow.appendChild(makeKpiCard('总任务数', kpi.total, ''));
    kpiRow.appendChild(makeKpiCard('成功率', kpi.successRate, '%'));
    kpiRow.appendChild(makeKpiCard('总 Token', formatTokenCount(kpi.totalTokens), ''));
    kpiRow.appendChild(makeKpiCard('平均耗时', formatDuration(kpi.avgDurationMs), ''));
    container.appendChild(kpiRow);

    // ---- 图表 Grid ----
    const grid = el('div', { className: 'dash-grid' });

    // 1. 热力图（占满一行）
    const heatCard = el('div', { className: 'card dash-card-wide' });
    heatCard.appendChild(el('h2', {}, ['修复热力图（近 6 个月）']));
    const heatBox = el('div', { id: 'dash-heatmap', className: 'echarts-chart echarts-heatmap' });
    heatCard.appendChild(heatBox);
    grid.appendChild(heatCard);

    // 2. Token 趋势
    const tokenCard = el('div', { className: 'card' });
    tokenCard.appendChild(el('h2', {}, ['Token 消耗趋势']));
    const tokenBox = el('div', { id: 'dash-token-trend', className: 'echarts-chart' });
    tokenCard.appendChild(tokenBox);
    grid.appendChild(tokenCard);

    // 3. PR 状态分布
    const prCard = el('div', { className: 'card' });
    prCard.appendChild(el('h2', {}, ['任务状态分布']));
    const prBox = el('div', { id: 'dash-pr-status', className: 'echarts-chart' });
    prCard.appendChild(prBox);
    grid.appendChild(prCard);

    // 4. 各仓库 Issue 数量
    const repoCard = el('div', { className: 'card' });
    repoCard.appendChild(el('h2', {}, ['各仓库 Issue 数量']));
    const repoBox = el('div', { id: 'dash-repo-issues', className: 'echarts-chart' });
    repoCard.appendChild(repoBox);
    grid.appendChild(repoCard);

    // 5. 平均修复时长
    const durCard = el('div', { className: 'card' });
    durCard.appendChild(el('h2', {}, ['平均修复时长（近 7 天）']));
    const durBox = el('div', { id: 'dash-duration', className: 'echarts-chart' });
    durCard.appendChild(durBox);
    grid.appendChild(durCard);

    container.appendChild(grid);

    // ---- 最近任务表格 ----
    const recentCard = el('div', { className: 'card' });
    recentCard.appendChild(el('h2', {}, ['最近任务']));
    if (recentJobs.length === 0) {
      recentCard.appendChild(el('div', { className: 'empty' }, [el('div', { className: 'empty-text' }, ['暂无任务记录'])]));
    } else {
      const table = el('table');
      table.innerHTML = `<thead><tr><th>#</th><th>Issue</th><th>仓库</th><th>状态</th><th>耗时</th><th>Token</th><th>时间</th></tr></thead>`;
      const tbody = el('tbody');
      for (const j of recentJobs) {
        const tr = el('tr');
        tr.innerHTML = `
          <td style="color:var(--muted);font-size:13px;">${j.id}</td>
          <td><strong style="color:var(--ink)">#${j.issue_number}</strong> <span style="font-size:13px;color:var(--muted)">${j.issue_title || ''}</span></td>
          <td style="color:var(--body-strong);">${j.repo}</td>
          <td><span class="badge badge-${j.status}">${STATUS_LABELS[j.status] || j.status}</span></td>
          <td style="font-variant-numeric:tabular-nums;">${formatDuration(j.duration_ms)}</td>
          <td style="font-variant-numeric:tabular-nums;" title="in:${j.input_tokens||0} out:${j.output_tokens||0}">${formatTokenCount((j.input_tokens||0)+(j.output_tokens||0))}</td>
          <td style="color:var(--muted);font-size:13px;">${timeAgo(j.created_at)}</td>
        `;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      const wrap = el('div', { className: 'table-wrap' });
      wrap.appendChild(table);
      recentCard.appendChild(wrap);
    }
    container.appendChild(recentCard);

    // ---- 渲染图表（延迟渲染，等 DOM 就位） ----
    requestAnimationFrame(() => {
      renderHeatmap(heatmap);
      renderTokenTrend(tokenTrend);
      renderPrStatus(prStatus);
      renderRepoIssues(repoIssues);
      renderDurationByMonth(durationByMonth);
    });
  }

  function makeKpiCard(label, value, suffix) {
    const c = el('div', { className: 'dash-kpi-card' });
    c.appendChild(el('div', { className: 'dash-kpi-value' }, [String(value) + suffix]));
    c.appendChild(el('div', { className: 'dash-kpi-label' }, [label]));
    return c;
  }

  // ---- 热力图（ECharts Calendar Heatmap — GitHub 贡献图风格） ----
  function renderHeatmap(data) {
    const chart = getChart('dash-heatmap');
    if (!chart) return;
    if (!data.length) { chart.clear(); return; }

    // 计算最近 6 个月的起止日期（按 Asia/Shanghai）
    const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
    const today = new Date(Date.now() + SHANGHAI_OFFSET_MS);
    const start = new Date(today);
    start.setMonth(start.getMonth() - 6);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const points = data.map(d => [d.date, d.count || 0]);
    const maxCount = Math.max(1, ...data.map(d => d.count || 0));

    chart.setOption({
      tooltip: { formatter: (p) => `${p.value[0]}<br/>修复 ${p.value[1]} 次` },
      visualMap: {
        min: 0,
        max: maxCount,
        show: false,
        inRange: { color: HEATMAP_COLORS },
      },
      calendar: {
        top: 20,
        left: 40,
        right: 20,
        bottom: 10,
        range: [fmt(start), fmt(today)],
        cellSize: ['auto', 13],
        orient: 'horizontal',
        splitLine: { show: false },
        yearLabel: { show: false },
        monthLabel: { nameMap: 'cn', color: '#6c6a64', fontSize: 11, margin: 8 },
        dayLabel: { firstDay: 1, nameMap: ['日','一','二','三','四','五','六'], color: '#6c6a64', fontSize: 11 },
        itemStyle: { borderWidth: 2, borderColor: '#ffffff', color: '#ebedf0' },
      },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: points }],
    });
  }

  // ---- 折线图：Token 趋势（按天） ----
  function renderTokenTrend(data) {
    const chart = getChart('dash-token-trend');
    if (!chart) return;
    if (!data.length) { chart.clear(); return; }
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: '#6c6a64' } },
      grid: { left: 50, right: 16, top: 16, bottom: 40 },
      xAxis: {
        type: 'category',
        data: data.map(d => d.day),
        axisLabel: { color: '#6c6a64', fontSize: 11, formatter: v => v.slice(5) },
        axisLine: { lineStyle: { color: '#e6dfd8' } },
        axisTick: { lineStyle: { color: '#e6dfd8' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#6c6a64', fontSize: 11, formatter: v => formatTokenCount(v) },
        splitLine: { lineStyle: { color: '#ebe6df' } },
      },
      series: [
        { name: '输入 Token', type: 'line', smooth: true, showSymbol: true, symbolSize: 6, data: data.map(d => d.input), itemStyle: { color: '#cc785c' }, areaStyle: { color: 'rgba(204,120,92,0.08)' } },
        { name: '输出 Token', type: 'line', smooth: true, showSymbol: true, symbolSize: 6, data: data.map(d => d.output), itemStyle: { color: '#5db8a6' }, areaStyle: { color: 'rgba(93,184,166,0.08)' } },
        { name: '缓存创建', type: 'line', smooth: true, showSymbol: true, symbolSize: 6, data: data.map(d => d.cache), itemStyle: { color: '#e8a55a' }, areaStyle: { color: 'rgba(232,165,90,0.08)' } },
      ],
    });
  }

  // ---- 环形图：任务状态分布 ----
  function renderPrStatus(prStatus) {
    const chart = getChart('dash-pr-status');
    if (!chart) return;
    const labels = Object.keys(prStatus);
    if (!labels.length) { chart.clear(); return; }
    chart.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: '#6c6a64' } },
      series: [{
        type: 'pie',
        radius: ['40%', '65%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data: labels.map(l => ({
          value: prStatus[l],
          name: STATUS_LABELS[l] || l,
          itemStyle: { color: STATUS_COLORS[l] || '#8e8b82' },
        })),
        emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0,0,0,0.15)' } },
      }],
    });
  }

  // ---- 堆叠柱状图：各仓库 Issue 数量（按状态拆分） ----
  function renderRepoIssues(data) {
    const chart = getChart('dash-repo-issues');
    if (!chart) return;
    if (!data.length) { chart.clear(); return; }
    chart.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, icon: 'rect', itemWidth: 10, itemHeight: 10, textStyle: { color: '#6c6a64' } },
      grid: { left: 60, right: 16, top: 16, bottom: 40 },
      xAxis: {
        type: 'value',
        axisLabel: { color: '#6c6a64', fontSize: 11 },
        splitLine: { lineStyle: { color: '#ebe6df' } },
      },
      yAxis: {
        type: 'category',
        data: data.map(d => d.repo),
        axisLabel: { color: '#6c6a64', fontSize: 12 },
        axisLine: { lineStyle: { color: '#e6dfd8' } },
      },
      series: [
        { name: '已关闭（merged/failed）', type: 'bar', stack: 'total', data: data.map(d => d.closed), itemStyle: { color: '#5db872' }, barMaxWidth: 40 },
        { name: '进行中', type: 'bar', stack: 'total', data: data.map(d => d.open), itemStyle: { color: '#e8a55a' }, barMaxWidth: 40 },
      ],
    });
  }

  // ---- 柱状图：平均修复时长（最近 7 天，按天） ----
  function renderDurationByMonth(data) {
    const chart = getChart('dash-duration');
    if (!chart) return;
    if (!data.length) { chart.clear(); return; }
    chart.setOption({
      tooltip: { trigger: 'axis', formatter: (p) => `${p[0].name}<br/>平均时长: ${p[0].value} 分钟` },
      legend: { show: false },
      grid: { left: 50, right: 16, top: 16, bottom: 30 },
      xAxis: {
        type: 'category',
        data: data.map(d => d.day),
        axisLabel: { color: '#6c6a64', fontSize: 11, formatter: v => v.slice(5) },
        axisLine: { lineStyle: { color: '#e6dfd8' } },
      },
      yAxis: {
        type: 'value',
        name: '分钟',
        nameTextStyle: { color: '#6c6a64', fontSize: 11 },
        axisLabel: { color: '#6c6a64', fontSize: 11 },
        splitLine: { lineStyle: { color: '#ebe6df' } },
      },
      series: [{
        type: 'bar',
        data: data.map(d => Math.round(d.avg_ms / 1000 / 60)),
        itemStyle: { color: '#5da0db', borderRadius: [4, 4, 0, 0] },
        barMaxWidth: 40,
      }],
    });
  }

  // ============ 日志弹窗 (Dark Product Surface) ============
  function showLogModal(job, logContent) {
    const overlay = el('div', { className: 'modal-overlay',
      onClick: (e) => { if (e.target === overlay) overlay.remove(); }
    });

    const modal = el('div', { className: 'modal' });

    // Header
    const header = el('div', { className: 'modal-header' });
    header.appendChild(el('h3', {}, [`任务 #${job.id} - Issue #${job.issue_number}`]));
    const closeBtn = el('button', { className: 'btn btn-secondary btn-sm', onClick: () => overlay.remove() }, ['关闭']);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Body
    const body = el('div', { className: 'modal-body' });

    // 元信息
    const meta = el('div', { className: 'modal-meta' });
    meta.innerHTML = `
      <span>状态: <span class="badge badge-${job.status}">${job.status}</span></span>
      <span>分支: <code>${job.branch_name || '-'}</code></span>
      ${job.pr_url ? `<span>PR: <a class="link" href="${job.pr_url}" target="_blank">#${job.pr_number}</a></span>` : ''}
      ${job.duration_ms ? `<span>耗时: ${formatDuration(job.duration_ms)}</span>` : ''}
      ${job.input_tokens || job.output_tokens ? `<span>Token: ${formatTokenCount(job.input_tokens)} 入 / ${formatTokenCount(job.output_tokens)} 出 / ${formatTokenCount(job.cache_read_input_tokens)} 缓存命中</span>` : ''}
      ${job.error_message ? `<span style="color:var(--error);">错误: ${job.error_message}</span>` : ''}
    `;
    body.appendChild(meta);

    // 日志内容
    const viewer = el('div', { className: 'log-viewer' });
    viewer.textContent = logContent || '(无日志)';
    body.appendChild(viewer);

    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ============ 会话记录弹窗 ============
  function showSessionModal(job, sessionContent) {
    const overlay = el('div', { className: 'modal-overlay',
      onClick: (e) => { if (e.target === overlay) overlay.remove(); }
    });

    const modal = el('div', { className: 'modal' });

    const header = el('div', { className: 'modal-header' });
    header.appendChild(el('h3', {}, [`任务 #${job.id} - 会话记录`]));
    const closeBtn = el('button', { className: 'btn btn-secondary btn-sm', onClick: () => overlay.remove() }, ['关闭']);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = el('div', { className: 'modal-body' });
    const meta = el('div', { className: 'modal-meta' });
    meta.innerHTML = `
      <span>状态: <span class="badge badge-${job.status}">${job.status}</span></span>
      <span>Issue: <code>#${job.issue_number}</code></span>
      ${job.pr_url ? `<span>PR: <a class="link" href="${job.pr_url}" target="_blank">#${job.pr_number}</a></span>` : ''}
      ${job.duration_ms ? `<span>耗时: ${formatDuration(job.duration_ms)}</span>` : ''}
      ${job.input_tokens || job.output_tokens ? `<span>Token: ${formatTokenCount(job.input_tokens)} 入 / ${formatTokenCount(job.output_tokens)} 出 / ${formatTokenCount(job.cache_read_input_tokens)} 缓存命中</span>` : ''}
    `;
    body.appendChild(meta);

    const viewer = el('div', { className: 'log-viewer' });
    viewer.textContent = sessionContent || '(无会话记录)';
    body.appendChild(viewer);

    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ============ 启动 ============
  (async function boot() {
    const ok = await checkAuth();
    if (ok) {
      renderHeaderUser();
      render();
    }
  })();

  // 每 30 秒自动刷新任务日志
  setInterval(() => {
    if (currentTab === 'jobs') render();
  }, 30000);

})();
