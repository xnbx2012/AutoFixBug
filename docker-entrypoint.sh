#!/bin/sh
# ============================================================
# Auto-Fix-Bug 容器启动入口
# 1. 若 .env 不存在，从 .env.example 复制
# 2. 兜底缺失关键环境变量
# ============================================================
set -e

ENV_FILE="/app/.env"

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "/app/.env.example" ]; then
    cp /app/.env.example "$ENV_FILE"
    echo "[entrypoint] 已从 .env.example 生成 .env"
  else
    touch "$ENV_FILE"
    echo "[entrypoint] 警告：未找到 .env.example，已创建空 .env"
  fi
fi

# 兜底：确保 ANTHROPIC_API_KEY 透传
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "[entrypoint] 警告：ANTHROPIC_API_KEY 未设置，Agent 调用将失败"
fi

# 兜底：确保 ENCRYPTION_KEY 存在（首次启动由应用自动生成）
if [ -z "$ENCRYPTION_KEY" ]; then
  echo "[entrypoint] 提示：ENCRYPTION_KEY 未设置，应用将自动生成并写入 .env"
fi

# 数据与日志目录权限修正
mkdir -p /app/data/repos /app/logs
chown -R node:node /app/data /app/logs

exec "$@"
