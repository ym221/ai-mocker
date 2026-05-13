# syntax=docker/dockerfile:1.7

# ---------- Build stage ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Speed up pnpm in regions where the default registry is slow / unreliable.
# Override at build time with: --build-arg NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_REGISTRY=https://registry.npmmirror.com/
ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY}

RUN corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm config set registry ${NPM_REGISTRY} \
 && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Drop devDependencies from node_modules. Native bindings (better-sqlite3) stay compiled for this platform.
RUN pnpm prune --prod

# ---------- Production stage ----------
FROM node:20-bookworm-slim
WORKDIR /app

# tini for proper PID 1 signal forwarding (clean SIGTERM on `docker stop`).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# tsx ESM hook 加载 AI 生成的 .ts 文件时,从 cwd/tsconfig.json 读 @core/* paths alias。
# 容器只有 dist 没有 src,所以 paths 必须指 dist — 用 tsconfig.runtime.json 改名复制。
COPY --from=builder /app/tsconfig.runtime.json ./tsconfig.json

# Writable runtime directories (replaced by mounted volumes in docker-compose).
RUN mkdir -p data uploads generated

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/server.js"]
