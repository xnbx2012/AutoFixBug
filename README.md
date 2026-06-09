<div align="center">

# 🚀 Auto-Fix-Bug

**GitHub Issue → Agent 自动修复 → PR → 审核 → 合并**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Claude Code](https://img.shields.io/badge/Claude-Code-cc785c?logo=anthropic&logoColor=white)](https://docs.claude.com)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](Dockerfile)

GitHub Issue 自动修复平台。监控 GitHub 仓库的新 Issue，自动调用 Claude Code Agent 分析问题、编写修复代码、提交 PR、等待审核并自动合并。

A GitHub Issue auto-fix platform. Monitors new Issues, invokes the Claude Code Agent to analyze and fix the bug, opens a PR, waits for review, and auto-merges.

[English](#english) · [简体中文](#简体中文) · [Quick Start](#-quick-start--快速开始) · [Docker](#-docker-deployment--docker-部署) · [License](#-license--开源协议)

</div>

---

## 简体中文

### ✨ 核心特性

- 🤖 **AI 自动修复** — Claude Code Agent 自动分析 Issue、定位问题、编写修复代码
- 🔄 **全流程自动化** — 监控 → 克隆 → 修复 → 测试 → 提交 → PR → 审核 → 合并
- 🔐 **安全加密** — GitHub Token 以 AES-256-GCM 加密存储在 SQLite 中
- 🔌 **多种监控模式** — 支持 Webhook 推送与 REST API 轮询两种方式
- 🛡️ **可访问控制** — 配置允许触发自动修复的 GitHub 用户白名单
- 💬 **智能交互** — 信息不足时自动在 Issue 下留言询问，等待用户回复后继续
- 🐳 **开箱即用** — 一行命令 Docker 部署

### 📋 环境要求

- Node.js 20+
- Git
- 一个 Anthropic API Key
- 一个 GitHub Personal Access Token（需要 `repo` + `admin:repo_hook` 权限）

### 🚀 快速开始

#### 方式一：本地运行

```bash
# 1. 克隆项目
git clone https://github.com/xnbx2012/AutoFixBug.git
cd AutoFixBug

# 2. 安装依赖
npm install

# 3. 复制环境变量模板并编辑
cp .env.example .env
# 编辑 .env，至少需要：
#   PUBLIC_BASE_URL = 你的服务器公网地址（如 https://your-domain.com）

# 4. 启动
npm start
# 默认监听 http://localhost:3000
```

#### 方式二：Docker 部署

```bash
# 1. 克隆项目
git clone https://github.com/xnbx2012/AutoFixBug.git
cd AutoFixBug

# 2. 编辑 .env，填入 ENCRYPTION_KEY 和 ANTHROPIC_API_KEY

# 3. 启动
docker-compose up -d
```

### ⚙️ 初始化配置

1. 浏览器访问 `http://localhost:3000`
2. 使用默认账号登录：`admin` / `123456`
3. ⚠️ **立即修改密码** — 默认密码下系统会拒绝响应 API 请求
4. 进入「**配置**」页面，填入：
   - GitHub Personal Access Token（`repo` + `admin:repo_hook` 权限）
   - Anthropic API Key
   - 默认代码审核人
5. 进入「**仓库**」页面，添加需要监控的 GitHub 仓库
6. 进入「**监控**」页面，创建监控任务并启用
7. 在 Issue 中以 `@claude` 触发自动修复

### 🏗️ 工作流程

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│ 监控引擎     │───▶│ 仓库克隆      │───▶│ 创建修复分支  │
│ Webhook/Pol │    │ 默认分支      │    │ fix/issue-N  │
└─────────────┘    └──────────────┘    └──────────────┘
                                              │
                                              ▼
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│ PR 自动合并  │◀───│ 等待审核通过  │◀───│ 创建 PR       │
└─────────────┘    └──────────────┘    └──────────────┘
       ▲                                      ▲
       │            ┌──────────────┐          │
       └────────────│ 测试验证      │◀─────────┘
                    └──────────────┘
                          ▲
                    ┌──────────────┐
                    │ Agent 修复    │
                    │ (Claude Code) │
                    └──────────────┘
```

1. **监控引擎** 检测到新 Issue（Webhook 推送 或 REST API 轮询）
2. **克隆仓库** 主分支到本地临时目录
3. **创建修复分支** `fix/issue-{N}`
4. **Claude Code Agent** 分析 Issue 并自动修复
5. 信息不足时自动 **留言询问** ，等待用户回复
6. **运行测试** 确认修复无误
7. **提交并推送** 修复分支
8. **创建 PR** 并指派审核人
9. **轮询审核状态**，通过后自动合并
10. 关闭 Issue 并添加完成通知

### 📁 目录结构

```
src/
├── index.js              # Express 入口
├── config.js             # 配置管理（.env 读写、密码加密）
├── crypto/               # AES-256-GCM 加密
├── db/                   # SQLite 数据库（schema + queries）
├── github/               # GitHub API 封装（JWT/Token/Webhook）
├── monitor/              # 监控引擎（Webhook + 轮询）
├── agent/                # Claude Code Agent 调用 & 流水线
├── pr/                   # PR 创建、审核、合并
├── log/                  # 日志模块
├── middleware/           # Express 中间件
├── routes/               # REST API 路由
└── utils/                # 工具函数
public/                   # 前端 SPA
data/                     # SQLite DB + 临时 clone 目录（不提交）
logs/                     # 运行日志（不提交）
```

### 🛠️ 常用命令

```bash
npm start            # 生产模式启动
npm run dev          # 开发模式（nodemon 热重载）
bash start-test.sh   # 启动并打开 DEBUG 日志
```

### 🔐 安全说明

- **不要提交 `.env` 文件** — 已默认忽略，包含 ENCRYPTION_KEY 与敏感凭据
- **首次启动后立即修改默认密码** `123456`
- **GitHub Token** 在数据库中以 AES-256-GCM 加密存储
- **ENCRYPTION_KEY** 丢失将导致历史 Token 不可恢复

### 🤝 贡献

欢迎提交 Issue 与 PR！请阅读 [CLAUDE.md](CLAUDE.md) 了解项目约定。

### 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。

---

## English

### ✨ Features

- 🤖 **AI-Powered Fixes** — Claude Code Agent auto-analyzes Issues, locates the bug, writes the fix
- 🔄 **End-to-End Automation** — Monitor → Clone → Fix → Test → Commit → PR → Review → Merge
- 🔐 **Secure by Design** — GitHub Tokens encrypted with AES-256-GCM in SQLite
- 🔌 **Flexible Monitoring** — Webhook push or REST API polling
- 🛡️ **Access Control** — Whitelist of GitHub users allowed to trigger auto-fix
- 💬 **Smart Interaction** — Auto-comment on Issues asking for clarification when info is missing
- 🐳 **Docker Ready** — One command to deploy

### 📋 Requirements

- Node.js 20+
- Git
- An Anthropic API Key
- A GitHub Personal Access Token (needs `repo` + `admin:repo_hook` scopes)

### 🚀 Quick Start

#### Option 1: Run Locally

```bash
# 1. Clone the repository
git clone https://github.com/xnbx2012/AutoFixBug.git
cd AutoFixBug

# 2. Install dependencies
npm install

# 3. Copy env template and edit
cp .env.example .env
# Edit .env, at minimum set:
#   PUBLIC_BASE_URL = your public server URL (e.g. https://your-domain.com)

# 4. Start
npm start
# Default: http://localhost:3000
```

#### Option 2: Docker

```bash
# 1. Clone the repository
git clone https://github.com/xnbx2012/AutoFixBug.git
cd AutoFixBug

# 2. Edit .env and provide ENCRYPTION_KEY and ANTHROPIC_API_KEY

# 3. Start
docker-compose up -d
```

### ⚙️ Initial Configuration

1. Open `http://localhost:3000` in your browser
2. Login with default credentials: `admin` / `123456`
3. ⚠️ **Change the password immediately** — the API refuses all requests under the default password
4. Open the **Config** page and provide:
   - GitHub Personal Access Token (`repo` + `admin:repo_hook` scopes)
   - Anthropic API Key
   - Default reviewer
5. Open the **Repos** page and add the GitHub repos to monitor
6. Open the **Monitors** page, create a monitor and enable it
7. Mention `@claude` in an Issue to trigger auto-fix

### 🏗️ Workflow

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│  Monitor     │───▶│ Clone Repo   │───▶│ Create Branch │
│ Webhook/Pol │    │ default br   │    │ fix/issue-N   │
└─────────────┘    └──────────────┘    └──────────────┘
                                              │
                                              ▼
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│ Auto-Merge  │◀───│ Wait Review  │◀───│ Open PR        │
└─────────────┘    └──────────────┘    └──────────────┘
       ▲                                      ▲
       │            ┌──────────────┐          │
       └────────────│ Run Tests     │◀─────────┘
                    └──────────────┘
                          ▲
                    ┌──────────────┐
                    │ Agent Fix     │
                    │ (Claude Code) │
                    └──────────────┘
```

1. The **monitor** detects a new Issue (Webhook or REST polling)
2. **Clone** the default branch into a local working dir
3. **Create branch** `fix/issue-{N}`
4. **Claude Code Agent** analyzes the Issue and writes a fix
5. If info is insufficient, **auto-comment** asking for clarification
6. **Run tests** to verify the fix
7. **Commit and push** the fix branch
8. **Open a PR** and assign the reviewer
9. **Poll review status**; auto-merge once approved
10. Close the Issue and post a completion notice

### 📁 Project Structure

```
src/
├── index.js              # Express entry point
├── config.js             # Configuration (.env read/write, password encryption)
├── crypto/               # AES-256-GCM encryption
├── db/                   # SQLite database (schema + queries)
├── github/               # GitHub API wrappers (JWT/Token/Webhook)
├── monitor/              # Monitor engine (Webhook + Polling)
├── agent/                # Claude Code Agent invocation & pipeline
├── pr/                   # PR creation, review, merge
├── log/                  # Logger module
├── middleware/           # Express middleware
├── routes/               # REST API routes
└── utils/                # Utility helpers
public/                   # Frontend SPA
data/                     # SQLite DB + temp clone dirs (gitignored)
logs/                     # Runtime logs (gitignored)
```

### 🛠️ Common Commands

```bash
npm start            # Start in production mode
npm run dev          # Start in dev mode (nodemon hot-reload)
bash start-test.sh   # Start with DEBUG logging
```

### 🔐 Security Notes

- **Never commit `.env`** — it's gitignored by default and contains ENCRYPTION_KEY and other secrets
- **Change the default password** `123456` immediately after first login
- **GitHub Tokens** are stored AES-256-GCM encrypted in the SQLite database
- **Losing ENCRYPTION_KEY** will render all stored tokens unrecoverable

### 🤝 Contributing

Issues and PRs are welcome! Please read [CLAUDE.md](CLAUDE.md) for project conventions.

### 📄 License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">

Made with ❤️ by the AutoFixBug contributors

⭐ Star us on GitHub if this project helps you automate your workflow!

</div>
