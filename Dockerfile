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
# tsx ESM hook 在 production 处理 AI 生成的 .ts 文件(controller.ts/test.ts)时,
# 需要读 tsconfig.json 解析 `@core/*` paths alias,否则 `import from '@core/base-model.js'`
# 会被 Node 当作 root-relative 路径 → "Cannot find module '/app/core/base-model.js'" 500。
# server tsconfig 用 extends tsconfig.json,两者都得复制。
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/tsconfig.server.json ./tsconfig.server.json

# Writable runtime directories (replaced by mounted volumes in docker-compose).
RUN mkdir -p data uploads generated

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/server.js"]
