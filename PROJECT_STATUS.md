# Auto-Fix-Bug 项目状态报告

## 📋 项目概述
GitHub Issue 自动修复平台：Web 应用监控 GitHub 仓库，检测新 Issue 后自动调用 Claude Code Agent 修复、测试、提 PR、审核、合并。

## ✅ 已完成功能

### 核心模块（全部实现完成）
1. **后端基础架构**
   - Express 服务器（src/index.js）
   - SQLite 数据库（src/db/schema.js, queries.js）
   - AES-256-GCM 加密（src/crypto/secrets.js）
   - 配置管理（src/config.js）

2. **GitHub 集成**
   - GitHub API 客户端（src/github/client.js）
   - Webhook 监听（src/github/webhook.js, src/monitor/webhookHandler.js）
   - Issue 监控（src/github/issues.js）
   - PR 创建和合并（src/pr/creator.js, merger.js）

3. **Claude Code Agent**
   - Agent 运行器（src/agent/runner.js）
   - 自动修复流水线（src/agent/pipeline.js）

4. **监控调度**
   - Webhook 和轮询模式（src/monitor/scheduler.js, poller.js）
   - 任务队列管理

5. **API 路由**（src/routes/）
   - /api/config - 配置管理
   - /api/repos - 仓库管理
   - /api/monitors - 监控任务管理
   - /api/jobs - 任务日志
   - /webhook - Webhook 入口

6. **前端界面**（public/）
   - SPA 应用（public/js/app.js）
   - API 封装（public/js/api.js）
   - 响应式 UI（public/css/style.css）

## ⚠️ 已修复的代码问题（2026/06/07）

1. **`getMonitor` 不 JOIN repos**（src/db/queries.js）
   - 问题：webhookHandler 和 scheduler 调用 `getMonitor` 时缺少 owner/repo_name 等字段
   - 修复：改为与 listMonitors 一致的 JOIN 查询

2. **缺失 `buildPRDescription` 函数**（src/agent/pipeline.js）
   - 问题：第 128 行调用了此函数但未定义，会导致 ReferenceError
   - 修复：添加了完整的 PR 描述生成函数

3. **Git commit 缺少 user 配置**（src/agent/pipeline.js）
   - 问题：新 clone 的仓库没有 user.name/email，commit 会失败
   - 修复：在 gitCreateBranch 中追加 `git config user.name` 和 `user.email`

4. **并发控制未实现**（src/agent/pipeline.js）
   - 问题：config.maxConcurrentJobs 已定义但未使用
   - 修复：添加信号量（activeJobs + jobQueue），processIssue 入口获取、出口释放

5. **审核修改循环未完成**（src/agent/pipeline.js）
   - 问题：changes_requested 分支只打了 warn 日志
   - 修复：实现最多 3 轮的修改-测试-提交-等待审核循环

6. **addLabels 错误处理缺失**（src/pr/creator.js）
   - 问题：仓库没有 `auto-fix` 标签时会 404 报错
   - 修复：用 try/catch 包裹，失败时 warn 忽略

## ✅ 启动验证结果

```
[Config] 自动生成 ENCRYPTION_KEY 并写入 .env
[Server] auto-fix-bug 已启动: http://localhost:3000
[Server] 数据库: D:\11_ClaudeCode\auto-fix-bug\data\app.db
[Server] 日志目录: D:\11_ClaudeCode\auto-fix-bug\logs
[Scheduler] 发现 0 个已启用的监控任务
[Server] 监控调度器已启动
```

API 端点验证：
- `GET /api/config` → `{}` ✅
- `GET /api/repos` → `[]` ✅
- `GET /` → 200 OK ✅

## 🎯 下一步操作

### 立即可执行
1. **启动项目**（依赖已安装）
   ```bash
   npm run dev
   ```

2. **访问界面**
   - 打开浏览器访问 http://localhost:3000
   - 在"配置"页配置 GitHub Token（需要 `repo`, `admin:repo_hook` 权限）
   - 在"仓库"页添加要监控的 GitHub 仓库
   - 在"监控"页创建监控任务（推荐 Webhook 模式）

### 使用流程
1. 配置 GitHub Token + 默认代码审核人
2. 添加 GitHub 仓库 URL
3. 创建监控任务（Webhook 或轮询）
4. 启用监控
5. 在 GitHub 仓库创建新 Issue
6. 系统自动：Clone → 创建分支 → Agent 修复 → 测试 → 提交 → 创建 PR → 等待审核 → 合并 → 关闭 Issue

## 📝 注意事项

1. **GitHub Token 权限**
   - `repo` - 访问仓库和创建 PR
   - `admin:repo_hook` - 管理 Webhook

2. **安全配置**
   - Token 以 AES-256-GCM 加密存储
   - Claude Code Agent 使用 bypassPermissions 模式
   - 生产环境需要配置 HTTPS

3. **并发控制**
   - 默认 maxConcurrentJobs=1（单任务执行）
   - 可在 .env 中调整 MAX_CONCURRENT_JOBS

4. **日志查看**
   - 控制台实时输出
   - 文件存储在 logs/ 目录（按日期分割）

## 🔧 开发建议

### 调试
- 使用 `LOG_LEVEL=DEBUG` 查看详细日志
- 检查 logs/ 目录下的日志文件
- 查看 SQLite 数据库（data/app.db）

### 扩展功能
- 支持更多编程语言（当前：Node.js, Python, Go, Rust）
- 自定义修复策略
- 批量处理历史 Issue
- 统计报表和可视化

## 📦 技术栈
- **后端**: Node.js + Express 4 + SQLite (better-sqlite3)
- **前端**: 原生 HTML/CSS/JS SPA
- **Agent**: @anthropic-ai/claude-code SDK
- **GitHub**: @octokit/rest
- **加密**: Node.js crypto (AES-256-GCM)

---
**项目状态**: ✅ 全部修复完成，启动验证通过
**最后更新**: 2026/06/07
