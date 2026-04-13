# Step 4: Fastify 基础 — 聚焦子计划

## 目标
完善 Fastify 实例配置（CORS、multipart、rate-limit、静态文件、错误处理），实现统一响应工具函数。

## Task 清单

### Task 1: response.ts — 统一响应格式
**文件**: src/server/core/response.ts
- `success(data, message?)` → `{ success: true, data, message }`
- `paginated(list, total, page, pageSize)` → `{ success: true, data: { list, total, page, pageSize } }`
- `error(code, message)` → `{ success: false, message }`（同时设置 HTTP 状态码）

### Task 2: app.ts — 完整 Fastify 配置
**文件**: src/server/app.ts
- @fastify/cors: Mock 路由全开放 origin: true
- @fastify/multipart: 文件上传（10MB 限制）
- @fastify/rate-limit: API 限流
- @fastify/static: /uploads 静态服务（开发+生产），/ 前端静态（仅生产）
- 全局错误处理器：Zod→400，JWT→401，404，500
- 保留 /api/health endpoint

### Task 3: 验证
**验收**: pnpm dev:server 启动正常，/api/health 返回 ok，CORS headers 正确
