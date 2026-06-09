# CLAUDE.md — Auto-Fix-Bug 项目指南

## 项目概述
GitHub Issue 自动修复平台：Web 应用监控 GitHub 仓库，检测新 Issue 后自动调用 Claude Code Agent 修复、测试、提 PR、审核、合并。

## 技术栈
- **后端**: Node.js + Express 4 + SQLite (better-sqlite3)
- **前端**: 原生 HTML/CSS/JS SPA
- **Agent**: @anthropic-ai/claude-code SDK (`query()` 函数)
- **GitHub API**: @octokit/rest
- **加密**: Node.js 内置 crypto (AES-256-GCM)

## 启动方式
```bash
npm install      # 安装依赖
npm start        # 生产启动
npm run dev      # 开发模式（nodemon 热重载）
```
默认端口 3000，访问 http://localhost:3000

## 目录结构
```
src/
  index.js          # 入口
  config.js         # 配置管理（含 .env 读写、密码加密）
  crypto/           # AES-256-GCM 加密
  db/               # SQLite 数据库（schema + queries）
  github/           # GitHub API 封装（JWT / Token / Webhook）
  monitor/          # 监控引擎（Webhook + 轮询）
  agent/            # Claude Code Agent 调用 & 流水线
  pr/               # PR 创建、审核、合并
  log/              # 日志模块
  middleware/       # Express 中间件
  routes/           # REST API 路由
  utils/            # 工具函数
public/             # 前端 SPA
data/               # SQLite DB + 临时 clone 目录（不提交 Git）
logs/               # 运行日志（不提交 Git）
```

## 代码风格
- 使用 CommonJS (`require` / `module.exports`)
- 中文注释和日志
- async/await 风格处理异步操作
- Express 路由模块化

## 关键注意事项
- **GitHub Token** 以 AES-256-GCM 加密存储在 SQLite 中
- **Claude Code Agent** 使用 `permissionMode: 'bypassPermissions'` 无头模式运行
- **日志文件** 在 `logs/` 目录，按上海日期切分，不提交 Git
- **工作目录** 在 `data/repos/` 下，任务完成后自动清理
- **默认密码** 为 `123456`；若未修改，系统启动后拒绝响应 API 请求（仅 `/api/auth/*` 可用）
- **环境变量** 通过 `.env` 管理；首次启动自动生成 `ENCRYPTION_KEY`

## Docker 部署
```bash
docker-compose up -d   # 后台启动
```
数据卷挂载：`./data` → `/app/data`，`./logs` → `/app/logs`
