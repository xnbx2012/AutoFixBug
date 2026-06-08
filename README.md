# Auto-Fix-Bug

GitHub Issue 自动修复平台。监控 GitHub 仓库的新 Issue，自动调用 Claude Code Agent 分析问题、编写修复代码、提交 PR、等待审核并自动合并。

## 快速开始

```bash
# 安装依赖
npm install

# 复制环境变量模板并编辑
cp .env.example .env
# 编辑 .env 填入 PUBLIC_BASE_URL（你的服务器公网地址）

# 启动
npm start

# 开发模式（热重载）
npm run dev
```

## 配置步骤

1. 访问 `http://localhost:3000`
2. 在"配置"页面填入 GitHub Personal Access Token（需 `repo` + `admin:repo_hook` 权限）
3. 设置默认代码审核人
4. 在"仓库"页面添加需要监控的 GitHub 仓库
5. 在"监控"页面创建监控任务（Webhook 或轮询模式）
6. 开启监控开关

## 架构

- **后端**: Express.js + SQLite (better-sqlite3)
- **前端**: 原生 HTML/CSS/JS SPA
- **Agent**: Claude Code Agent SDK (`@anthropic-ai/claude-code`)
- **加密**: AES-256-GCM 加密存储 GitHub Token

## 目录结构

```
src/
├── index.js              # 入口
├── config.js             # 配置管理
├── db/                   # SQLite 数据库
├── crypto/               # 密钥加密
├── github/               # GitHub API 封装
├── monitor/              # 监控引擎（Webhook + 轮询）
├── agent/                # Claude Code Agent 调用 & 流水线
├── pr/                   # PR 创建、审核、合并
├── log/                  # 日志模块
└── routes/               # REST API 路由
public/                   # 前端 SPA
data/                     # SQLite DB + 临时 clone 目录
logs/                     # 运行日志（不提交 Git）
```

## 工作流程

1. 监控引擎检测新 Issue（Webhook 推送 或 REST API 轮询）
2. 克隆仓库主分支到本地
3. 创建修复分支 `fix/issue-{N}`
4. 调用 Claude Code Agent SDK 分析问题并修复
5. 如信息不足，自动在 Issue 下留言询问，等待回复后继续
6. 运行测试确认修复无误
7. 提交并推送修复分支
8. 创建 PR（含 Review 报告）并指派审核人
9. 轮询审核状态，审核通过后自动合并
10. 关闭 Issue 并添加完成通知
