FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# 安装 Claude Code CLI（SDK query() 需要底层二进制）
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# 先复制依赖描述文件，利用 Docker 缓存层
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 复制源码
COPY src/ src/
COPY public/ public/
COPY .env.example CLAUDE.md README.md ./

# 创建数据与日志目录（运行时挂载卷覆盖）
RUN mkdir -p data/repos logs && chown -R node:node /app

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 容器内端口（可通过 PORT 环境变量覆盖）
EXPOSE 3000

# 运行时环境变量（在 docker-compose.yml 或 docker run 中设置）
#   ENCRYPTION_KEY  — 数据加密主密钥（必须）
#   ANTHROPIC_API_KEY — Claude Code API Key（必须）
#   PORT            — 服务端口（默认 3000）
#   PUBLIC_BASE_URL — 服务公网地址
#   ADMIN_USERNAME  — 管理员用户名（默认 admin）
#   ADMIN_PASSWORD  — 管理员密码（默认 123456）

USER node

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
