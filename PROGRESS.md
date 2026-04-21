# MockForge 实现进度

## 总览
| Phase | 名称 | 状态 |
|-------|------|------|
| 1 | 项目基础 | ✅ 完成 |
| 2 | AI Agent 核心 | ✅ 完成 |
| 3 | 前端 — 对话 | ✅ 完成 |
| 4 | 前端 — 模块管理 | ✅ 完成 |
| 5 | 增强 | ✅ 完成 |
| 6 | MCP 集成 | ✅ 完成（Step-MCP-1 + Step-MCP-2）|

## Phase 1：项目基础

### Step 1: 项目初始化 ✅ (d759059)
- Vite 6 + Vue 3 + Tailwind 3 + shadcn-vue
- 备注：Vite 8 不兼容 Node 20.16.0

### Step 2: 数据库 + Schema ✅ (1665a08)
- SQLite + Drizzle ORM，7 张系统表

### Step 3: BaseModel ✅ (dcd3880)
- 通用 CRUD + AsyncLocalStorage 用户隔离

### Step 4: Fastify 基础 ✅ (3d8c091)
- CORS + multipart + rate-limit + 统一响应

### Step 5: 认证 + Seed ✅ (c67a9b2)
- JWT + AES 加密 + 注册/登录 + admin seed

## Phase 2：AI Agent 核心

### Step 6: Agent 工具集 ✅ (acd2c2b)
- 6 个工具 + test-runner + tool-registry

### Step 7: System Prompt + AgentRunner ✅ (0571bbf)
- 5 个系统 API + 系统提示词 + SSE 流

### Step 8: mock-router ✅ (a0cb85b)
- 动态 /mock/* catch-all 路由

### Step 9: 端到端验证 ✅ (7505e02)
- 完整 CRUD 流程验证通过

## Phase 3：前端 — 对话

### Step 10: 前端基础 ✅ (73b1e8c)
- 路由 + 布局 + 登录 + auth store

### Step 11: Settings 页面 ✅ (c59dc5d)
- Provider + Preset CRUD

### Step 12: 对话页 ✅ (1bbc04a)
- 会话管理 + SSE 流式对话

### Step 13: 文件上传 ✅ (5a1e136)
- 文件解析 + 上传 API

## Phase 4：前端 — 模块管理

### Step 14-18: 模块管理 ✅ (7720803)
- 模块列表 + 详情 + 端点测试

## Phase 5：增强

### Step 19-23: 增强功能 ✅ (eb3bc47)
- 延迟/异常模拟 + 数据管理 API + 管理员面板 + Docker

## Phase 6：MCP 集成

### Step-MCP-1: MCP Server 只读骨架 ✅
- 新目录 `src/server/mcp/`（context / auth / server / routes / tools / resources）
- 新依赖 `@modelcontextprotocol/sdk` 1.29
- `users` 表新增 `api_key_hash / api_key_created_at / api_key_last_used_at`
- Settings 页新增「API Keys」Tab，一次性明文展示 + MCP 配置片段复制
- 3 只读工具（list_modules / get_api_doc / get_openapi）+ `mockforge://guide` Resource
- 完整回归 245 passed，MCP 新增 10 条 + UI 4 条全绿
- 详见 `CURSOR.md` 对应章节

### Step-MCP-2: MCP 全读写能力 + 业务侧感知 + 交接报告 ✅
- MCP 工具总数增至 **12 个**：6 读（新增 get_mock_access_log / get_module_health / diff_with_openapi）、5 写（delete_module / run_test / manage_data / create_module_from_spec / update_module）、1 汇报（generate_handoff_report）
- 新增基础设施：
  - `core/access-log.ts` — /mock/* 请求持久化，每用户滚动 cap 10000
  - `mcp/lib/headless-session.ts` — 桥接 ChatRunner，让 MCP 开的 session 写入共享 sessions 表（Web UI 可接管）
  - `mcp/lib/retry-counter.ts` — 软 warnings
- `core/openapi-export.ts` — 自动给实体注入 id/created_at/updated_at
- `core/mock-router.ts` — 用 reply.raw 'close' 钩子非侵入记录 access log
- create/update 工具支持 **MCP progress notifications** 和 **dry_run** 预览
- `generate_handoff_report` 输出结构化 markdown（契约 + 健康 + 访问日志 + 后端建议）
- 新增 30 条测试（mock-access-log L01-L05、mcp-server-v2 M11-M32、mcp-headless-session H01-H02、mcp-retry-counter R01-R04）；M25/M32 用 admin 免费 gemma 真实调 LLM 验证
- 详见 `CURSOR.md` 对应章节

## 关键决策记录
- Vite 6 而非 8（Node 20.16.0 兼容性）
- Tailwind 3 而非 4（同上）
- shadcn-vue 组件手动创建（corepack 兼容性问题）
- 使用 --env-file .env 加载环境变量
- MCP API Key 用 HMAC-SHA256 而非 bcrypt（O(1) 查询 vs 全表扫描）
- MCP 用 stateless StreamableHTTPServerTransport + per-request McpServer（简单安全）
- 用户上下文经 AsyncLocalStorage 注入（复用项目既有 BaseModel 模式）
