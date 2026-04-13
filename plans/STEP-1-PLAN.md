# Step 1: 项目初始化 — 聚焦子计划

## 目标
搭建 MockForge 项目骨架，安装所有依赖，配置构建工具链，使 `pnpm dev` 能同时启动前后端开发服务器。

## 前置条件
- Node.js 22 LTS 已安装
- pnpm 已安装
- 当前目录为空项目（仅有 PLAN.md、CLAUDE.md）

## Task 清单

### Task 1: git init + pnpm init + 安装依赖
**文件**: package.json
**操作**:
1. `git init`
2. `pnpm init`
3. 安装生产依赖：
   ```
   ai @ai-sdk/vue @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google
   fastify @fastify/cors @fastify/multipart @fastify/static @fastify/rate-limit
   better-sqlite3 drizzle-orm
   jose bcryptjs zod
   @faker-js/faker
   markdown-it @shikijs/markdown-it shiki
   pdf-parse mammoth exceljs yaml
   node-cron
   vue vue-router pinia @tanstack/vue-table vue-sonner
   lucide-vue-next
   ```
4. 安装开发依赖：
   ```
   typescript tsx concurrently
   vite @vitejs/plugin-vue
   tailwindcss @tailwindcss/vite
   drizzle-kit
   @types/better-sqlite3 @types/node @types/markdown-it @types/bcryptjs
   ```
**验收**: package.json 存在，node_modules 安装成功

### Task 2: Vite + TypeScript + Tailwind 配置
**文件**: vite.config.ts, tsconfig.json, tsconfig.server.json, tsconfig.client.json, src/client/main.ts, src/client/App.vue, src/client/styles.css
**关键细节**:
- vite.config.ts:
  - `@vitejs/plugin-vue`
  - `@tailwindcss/vite`
  - server.proxy: `/api` → `http://localhost:3000`, `/mock` → `http://localhost:3000`, `/uploads` → `http://localhost:3000`
  - resolve.alias: `@` → `src/client`
- tsconfig.json（基础）:
  - strict: true, esModuleInterop: true, skipLibCheck: true
  - paths: `@core/*` → `["src/server/core/*"]`, `@/*` → `["src/client/*"]`
- tsconfig.server.json:
  - extends: ./tsconfig.json
  - target: ES2022, module: NodeNext, moduleResolution: NodeNext
  - include: ["src/server/**/*", "src/shared/**/*"]
- tsconfig.client.json:
  - extends: ./tsconfig.json
  - target: ES2020, module: ESNext, moduleResolution: bundler
  - jsx: preserve
  - include: ["src/client/**/*", "src/shared/**/*"]
  - Vite 引用此配置
- src/client/styles.css: `@import "tailwindcss";`
- src/client/App.vue: 最简骨架（`<div>MockForge</div>`）
- src/client/main.ts: createApp + mount
- package.json scripts:
  ```json
  "dev": "concurrently \"pnpm dev:server\" \"pnpm dev:client\"",
  "dev:server": "tsx watch src/server/server.ts",
  "dev:client": "vite",
  "build": "vite build && tsc -p tsconfig.server.json",
  "start": "node dist/server/server.js"
  ```
**验收**: `pnpm dev:client` 能启动 Vite，无 TS 编译错误

### Task 3: shadcn-vue 初始化 + 安装组件
**操作**:
1. `npx shadcn-vue@latest init`（选择 New York 风格，zinc 色系）
2. 安装组件：Button, Input, Select, Dialog, Tooltip, Switch, Tabs, Pagination, Skeleton, Popover, DropdownMenu
3. Toast 使用 vue-sonner（已在依赖中）
**验收**: `src/client/components/ui/` 下有对应组件文件夹

### Task 4: 创建项目文件
**文件**:
- index.html（Vite 入口）
- .env.example + .env
- .gitignore
- src/server/server.ts（最简启动：监听 3000 端口，返回 health check）
- src/server/app.ts（Fastify 实例占位）
- src/shared/types.ts（空文件占位）
- src/shared/constants.ts（空文件占位）
- src/client/router/index.ts（基础路由配置）

**环境变量（.env.example）**:
```bash
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
DB_PATH=./data/mockforge.db
JWT_SECRET=your-jwt-secret-change-this
JWT_EXPIRES_IN=7d
ENCRYPTION_KEY=your-32-char-encryption-key-here
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
ALLOW_REGISTRATION=true
UPLOAD_DIR=./uploads
UPLOAD_MAX_SIZE=10485760
UPLOAD_CLEANUP_HOURS=24
DEFAULT_AI_PROVIDER=openai
DEFAULT_AI_MODEL=doubao-seed-2-0-pro-260215
DEFAULT_AI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DEFAULT_AI_API_KEY=
```

**.gitignore**:
```
node_modules/
dist/
data/
uploads/
generated/
.env
*.db
```

**验收**: 所有文件创建完成，无遗漏

### Task 5: 端到端验收
**操作**:
1. `pnpm dev` 启动前后端
2. 前端 Vite dev server 正常运行（5173 端口）
3. 后端 Fastify 正常运行（3000 端口）
4. 浏览器打开显示 "MockForge" 文字，无报错
5. git commit: "Step 1: 项目初始化"
**验收**: 全部通过

## 编码规范摘要
- TypeScript strict 模式
- 2 空格缩进，单引号，有分号，LF 行尾
- 文件名 kebab-case，Vue 组件 PascalCase
- 变量/函数 camelCase，常量 UPPER_SNAKE_CASE

## 回归检查
（Step 1 无前置 Step，不需要回归）
