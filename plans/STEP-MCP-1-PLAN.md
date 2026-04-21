# Step-MCP-1: MCP Server 只读骨架

> 状态：待执行
> 目标：MockForge 对外暴露 MCP Server，IDE AI 能通过 MCP 协议只读访问用户的 Mock 模块
> 预估：1-2 天

---

## 一、目标与范围

### 本 Step 必达

1. 用户可在 Settings 页生成/查看/吊销自己的 API Key
2. MockForge 在 `/mcp` 暴露一个 Streamable HTTP Transport 的 MCP Server
3. MCP Server 用 `X-API-Key` 鉴权，解出 userId 并通过 `runWithUser` 注入用户上下文
4. 暴露 3 个只读工具：`list_modules` / `get_api_doc` / `get_openapi`
5. 暴露 1 个 MCP Resource：`mockforge://guide`（AI 使用指南）
6. IDE（Cursor / Claude Code）配 `mcp.json` 后能连上并调用工具
7. Node.js 集成测试验证 MCP 协议全链路
8. 完整回归：现有所有测试 100% 绿（CLAUDE.md 零容忍）

### 本 Step **不做**（后续 Step）

- ❌ 写工具（create_module_from_spec / update_module）→ Step-MCP-2
- ❌ 业务侧感知工具（get_mock_access_log / diff_with_openapi）→ Step-MCP-2
- ❌ dry_run / 软 warnings / 成本控制 → Step-MCP-2
- ❌ stdio transport → Step-MCP-3（也可能永远不做）
- ❌ 交接报告工具 → Step-MCP-3

### 核心设计约束（经用户确认）

- **同步模型 + MCP progress notifications**：AI 一次调用等结果，后端推进度（本 Step 只读工具都是毫秒级，暂时用不上，但接口设计要为后续留位）
- **不阻塞的能力增强**：所有新加的东西是"默认不改变、需要时可用"
- **Web UI 与 MCP 共享状态**：同一个 Fastify 进程、同一个 SQLite、同一个 AsyncLocalStorage

---

## 二、架构要点

```
┌─────────────────────┐
│ Cursor / Claude Code│
│                     │
│  mcp.json:          │
│    url: localhost   │
│        :3000/mcp    │
│    X-API-Key: mf_...│
└──────────┬──────────┘
           │ HTTP (MCP Streamable)
           ▼
┌─────────────────────────────────────────┐
│  Fastify (现有进程)                       │
│                                         │
│  ┌──────────────┐  ┌──────────────────┐ │
│  │ /api/* (JWT) │  │ /mcp (API Key)   │ │
│  └──────────────┘  └────────┬─────────┘ │
│                             │           │
│                  ┌──────────▼─────────┐ │
│                  │ MCP Server         │ │
│                  │ - tools            │ │
│                  │ - resources        │ │
│                  └──────────┬─────────┘ │
│                             │           │
│                  ┌──────────▼─────────┐ │
│                  │ runWithUser        │ │
│                  │ (AsyncLocalStorage)│ │
│                  └──────────┬─────────┘ │
│                             │           │
│      ┌───────────┬──────────▼─────────┐ │
│      │ 现有 tool / BaseModel / FS     │ │
│      └────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 关键依赖

- `@modelcontextprotocol/sdk`（官方 TS SDK，提供 Server + Streamable HTTP transport）
- 沿用现有：Fastify / better-sqlite3 / Drizzle / zod / AsyncLocalStorage

### 鉴权设计

- API Key 格式：`mf_` + 32 位 base64url 随机（如 `mf_abc123...`）
- 存储：`users.api_key_hash`（bcrypt hash，不存明文）
- 生成时明文**只在响应里返回一次**，前端一次性展示并强制用户复制保存
- 吊销：重新生成即可（旧的 hash 被覆盖，旧 key 立即失效）
- 中间件：拦截所有 `/mcp/*` 请求 → 取 `X-API-Key` header → 对所有 users 的 api_key_hash 做 bcrypt 比对（或用 hash 前缀索引加速）→ 命中则 `runWithUser(userId, ...)`

**性能注意**：bcrypt 全表扫描会慢。v1 可接受（单机、用户数少）；v2 可改为存 HMAC-SHA256（用 API_KEY_SECRET 做 key），等值查询 O(1)。本 Step 先用 HMAC-SHA256 方案（性能 + 安全兼顾）。

---

## 三、文件变更清单

### 新增

```
src/server/mcp/
├── server.ts            # MCP Server 实例 + 工具注册
├── auth.ts              # API Key 解析 + userId 注入
├── tools/
│   ├── index.ts         # 工具注册入口
│   ├── list-modules.ts  # MCP Tool: list_modules
│   ├── get-api-doc.ts   # MCP Tool: get_api_doc
│   └── get-openapi.ts   # MCP Tool: get_openapi
├── resources/
│   └── guide.ts         # MCP Resource: mockforge://guide
└── routes.ts            # Fastify 插件：挂 /mcp 路径

src/server/api/
└── api-keys.ts          # REST: 生成/查看/吊销 API Key

src/client/pages/
└── （在现有 SettingsPage.vue 加 Tab，不新增页面）

src/client/components/settings/
└── ApiKeysTab.vue       # API Keys 管理 Tab 内容

tests/
└── mcp-server.spec.ts   # Node.js 集成测试（不用 Playwright）
```

### 修改

```
package.json             # 加 @modelcontextprotocol/sdk 依赖
src/server/core/schema.ts        # users 加 apiKeyHash / apiKeyLastUsedAt
src/server/core/database.ts      # 迁移新增字段
src/server/app.ts                # 注册 /mcp 路由插件
src/server/server.ts             # import mcpRoutes + register
src/client/pages/SettingsPage.vue # 加 API Keys Tab
src/client/composables/use-api.ts # 加 API Keys 相关接口
.env.example             # 加 MCP_API_KEY_SECRET（HMAC 密钥）
README.md                # 加 "Using MockForge from IDE (MCP)" 章节
```

---

## 四、Task 拆分

### Task 1.1 — Schema 迁移 + 依赖安装

**文件**：
- `package.json`
- `src/server/core/schema.ts`
- `src/server/core/database.ts`
- `.env.example`

**内容**：
1. `pnpm add @modelcontextprotocol/sdk`
2. `schema.ts` 的 `users` 表加：
   ```ts
   apiKeyHash: text('api_key_hash'),            // HMAC-SHA256(secret, api_key)，hex
   apiKeyLastUsedAt: text('api_key_last_used_at'),
   ```
3. `database.ts` 的 `ensureColumns` 逻辑追加这两字段的 `ALTER TABLE` 迁移
4. `.env.example` 加：
   ```
   MCP_API_KEY_SECRET=change-me-to-random-32-bytes
   ```
5. `src/server/core/api-key.ts`（新增）：封装
   - `generateApiKey()` → `{ plain: "mf_xxx", hash: "hex..." }`
   - `hashApiKey(plain)` → hex（HMAC-SHA256(MCP_API_KEY_SECRET, plain)）
   - `findUserByApiKey(plain)` → 查 users where api_key_hash = hash(plain)

**验收**：
- `pnpm dev` 启动不报错
- 数据库文件存在且 `users` 表新增了两列（`sqlite3 mockforge.db .schema users` 可见）

**commit**: `Step-MCP-1.1: schema + api-key hashing utility`

---

### Task 1.2 — API Key REST 接口

**文件**：
- `src/server/api/api-keys.ts`（新增）
- `src/server/server.ts`（注册路由）

**接口**：

```
GET    /api/users/me/api-key       → { hasKey: bool, lastUsedAt?: string, createdAt?: string }
POST   /api/users/me/api-key       → { apiKey: "mf_..." }  // 明文仅此一次返回
DELETE /api/users/me/api-key       → { success: true }
```

- 全部走现有 JWT 鉴权（复用 `src/server/core/auth.ts` 的 `requireAuth` hook）
- POST 会覆盖旧 hash（旧 key 立即失效）
- DELETE 置空 `api_key_hash`

**验收**：
- 用 curl / REST client 测试 3 个接口，符合预期
- 手动验证 POST 两次后第一个 key 不再能用（Task 1.3 完成后验证）

**commit**: `Step-MCP-1.2: REST endpoints for API key management`

---

### Task 1.3 — MCP Server 骨架 + HTTP Transport + 鉴权

**文件**：
- `src/server/mcp/server.ts`
- `src/server/mcp/auth.ts`
- `src/server/mcp/routes.ts`
- `src/server/app.ts` / `src/server/server.ts`（注册）

**`mcp/auth.ts`**：
- 导出 `resolveUserIdFromRequest(request)`：
  - 取 header `X-API-Key` 或 `Authorization: Bearer mf_xxx`
  - 调 `findUserByApiKey(plain)` → 命中返回 userId，否则 throw 401
  - 命中时顺手更新 `api_key_last_used_at`（非阻塞，异步）

**`mcp/server.ts`**：
- 用 `@modelcontextprotocol/sdk/server/index.js` 的 `Server` 类
- 在模块作用域创建一个**共享** MCP Server 实例（工具注册是静态的，每个请求带 userId context 进入）
- Server 元信息：`{ name: "mockforge", version: "0.1.0" }`
- 调用 `tools/index.ts` 和 `resources/guide.ts` 完成注册

**`mcp/routes.ts`**：
- Fastify plugin，挂载 `/mcp`（POST）
- 用 `StreamableHTTPServerTransport`（SDK 提供）
- 在路由 handler 里：
  1. 先调 `resolveUserIdFromRequest` 拿 userId
  2. 用 `runWithUser(userId, async () => { await transport.handleRequest(req, reply, body) })` 包一层
  3. 确保 AsyncLocalStorage context 贯穿整个 MCP 调用链

**注意事项**：
- MCP SDK 的 transport 可能和 Fastify 原生 req/reply 不完全兼容，需要用 `request.raw` / `reply.raw` 拿到 Node 的 IncomingMessage / ServerResponse
- 参考 SDK 文档的 Express 示例改写为 Fastify 版本
- 需要 `app.addContentTypeParser('application/json', ...)` 确保流式 body 被正确传递

**验收**：
- 启动服务后 `curl -X POST http://localhost:3000/mcp -H "X-API-Key: bad" -d '{}'` 返回 401
- 用正确的 key 发 MCP `initialize` 请求，返回正常的 MCP 握手响应

**commit**: `Step-MCP-1.3: MCP server skeleton + HTTP transport + API key auth`

---

### Task 1.4 — 3 个只读工具

**文件**：
- `src/server/mcp/tools/index.ts`
- `src/server/mcp/tools/list-modules.ts`
- `src/server/mcp/tools/get-api-doc.ts`
- `src/server/mcp/tools/get-openapi.ts`

**工具 schema**（用 zod，SDK 会转 JSON Schema）：

```ts
// list_modules
input:  {}
output: {
  modules: Array<{
    name: string;
    displayName: string;
    description?: string;
    status: 'creating' | 'editing' | 'active' | 'error';
    health: 'healthy' | 'degraded' | 'missing';
    endpoints: string[];    // e.g., ["GET /orders", "POST /orders"]
    mockBaseUrl: string;    // e.g., "http://localhost:3000/mock/order"
    updatedAt: string;
  }>
}

// get_api_doc
input:  { moduleName: string }
output: { moduleName: string; markdown: string; }

// get_openapi
input:  { moduleName: string }
output: { moduleName: string; openapi: object; }  // 直接返回解析后的 JSON
```

**实现要点**：
- 全部通过 `getUserIdFromContext()` 拿当前 userId（AsyncLocalStorage）
- 内部复用现有逻辑：
  - `list_modules` → 复用 `src/server/agent/tools/list-modules.ts`，但**增强**输出：加 `mockBaseUrl` / `endpoints`（从 `_meta.json` 和 controller.ts 解析）
  - `get_api_doc` → 读 `generated/{userId}/{moduleName}/api-doc.md`
  - `get_openapi` → 复用 ModuleDetailPage 里的 OpenAPI 构造逻辑（提取到 `src/server/core/openapi-export.ts` 便于复用）
- 错误处理：模块不存在 → MCP 错误响应（code: -32602 InvalidParams）

**验收**：
- MCP client（test 里用 SDK 的 Client）调 `tools/list` 看到 3 个工具
- 调用 `list_modules` 返回的 JSON 符合 schema
- 调用 `get_api_doc` 对不存在的模块返回友好错误

**commit**: `Step-MCP-1.4: three read-only MCP tools`

---

### Task 1.5 — guide Resource

**文件**：
- `src/server/mcp/resources/guide.ts`

**内容**：
- 注册 MCP Resource：URI = `mockforge://guide`，mimeType = `text/markdown`
- 内容是一份写给 AI 的使用指南，包含：
  1. MockForge 是什么、能做什么
  2. 推荐工作流（PRD → 契约 → Mock → 自测 → 修复循环）
  3. 当前可用工具列表 + 何时用哪个的决策树
  4. **重要边界**：当前 Step 只有只读工具，写能力在后续版本（让 AI 不要瞎调不存在的工具）
  5. 示例：典型的两三轮调用序列

**验收**：
- MCP client 调 `resources/list` 看到 guide
- 调 `resources/read` 拿到 markdown 内容
- 内容里不出现尚未实现的工具名

**commit**: `Step-MCP-1.5: MCP guide resource`

---

### Task 1.6 — Settings 页 API Keys Tab

**文件**：
- `src/client/components/settings/ApiKeysTab.vue`（新增）
- `src/client/pages/SettingsPage.vue`（加 Tab）
- `src/client/composables/use-api.ts`（加 3 个接口函数）

**UI 内容**：

未生成 key 状态：
```
┌─────────────────────────────────────────────┐
│  API Keys                                    │
│                                             │
│  你还没有 API Key。                           │
│  [生成 API Key]                              │
│                                             │
│  API Key 用于 IDE（Cursor / Claude Code）等  │
│  AI 工具通过 MCP 协议访问 MockForge。         │
└─────────────────────────────────────────────┘
```

已生成状态：
```
┌─────────────────────────────────────────────┐
│  API Keys                                    │
│                                             │
│  ✓ 已有 API Key                              │
│  上次使用：2026-04-21 14:32                   │
│  创建时间：2026-04-20 10:00                   │
│                                             │
│  [重新生成]  [吊销]                          │
│                                             │
│  ⚠ API Key 等同账户密码，泄漏后他人可操作     │
│    你的全部 Mock 模块。请妥善保管。           │
│                                             │
│  ──── MCP 配置示例（点击复制）────            │
│  ```json                                    │
│  { "mcpServers": { "mockforge": {          │
│    "url": "http://localhost:3000/mcp",     │
│    "headers": { "X-API-Key": "<your-key>" }│
│  }}}                                        │
│  ```                                        │
└─────────────────────────────────────────────┘
```

生成/重新生成后弹 Dialog：
```
┌─────────────────────────────────────────────┐
│  你的新 API Key                              │
│  mf_abc123...xyz789                          │
│  [📋 复制]                                    │
│                                             │
│  ⚠ 此 Key 仅展示这一次，请立即复制保存。      │
│    离开此弹窗后将无法再次查看。               │
│                                             │
│  [我已保存，关闭]                             │
└─────────────────────────────────────────────┘
```

**交互要点**：
- 重新生成 / 吊销都要 `useConfirm` 二次确认
- 复制成功后 toast 提示（用已有 `useToast`）
- Dialog 关闭前点击遮罩不关闭（防止误触丢失 key）

**验收**：
- 全流程手测：生成 → 复制 → 重新生成 → 吊销
- 吊销后 MCP 调用立即 401

**commit**: `Step-MCP-1.6: API keys management UI`

---

### Task 1.7 — Node.js 集成测试

**文件**：
- `tests/mcp-server.spec.ts`（新增，用 Playwright test runner 但不用浏览器）

**为什么不用 Playwright 浏览器？** MCP 是 HTTP 协议，用 Node.js 直连即可。Playwright 的 test runner（`@playwright/test`）本身就是很好的 test runner，能继续用它跑，只是不启 browser。

**覆盖用例**：

- **M01 鉴权** — 无 key / 错误 key 返回 401
- **M02 initialize** — 正确 key 能握手
- **M03 tools/list** — 能看到 3 个预期工具名
- **M04 list_modules** — 创建一个测试用模块后，能通过 MCP 拿到
- **M05 get_api_doc** — 读取存在模块的文档
- **M06 get_openapi** — 拿到合法 OpenAPI 3.0 JSON
- **M07 不存在模块** — 错误响应友好
- **M08 resources/list + read** — guide resource 可用
- **M09 lastUsedAt 更新** — 调用后 DB 字段被更新
- **M10 用户隔离** — userA 的 key 看不到 userB 的模块

**实现要点**：
- 用 `@modelcontextprotocol/sdk/client/index.js` 的 `Client` + `StreamableHTTPClientTransport`
- `beforeAll` 启动 MockForge server（或 assume 已启动，复用现有测试 pattern）
- 测试前创建两个测试用户，分别生成 API Key，每个用户创建 1-2 个测试模块

**验收**：
- 10 条全绿
- 回归：完整测试套件 `pnpm exec playwright test` 保持之前的绿率（现有 96 passed 不能退化）

**commit**: `Step-MCP-1.7: MCP server integration tests`

---

### Task 1.8 — 文档 + 配置样例

**文件**：
- `README.md`（新增章节）
- `docs/mcp-usage.md`（新增，详细用法）
- `.env.example`（核对已加 `MCP_API_KEY_SECRET`）

**README 新增章节**（简版）：

```markdown
## 🤖 Using MockForge from IDE (MCP)

MockForge supports the Model Context Protocol, letting IDE AI assistants
(Cursor, Claude Code, etc.) interact with your Mock modules directly.

### Setup

1. Log in → Settings → API Keys → Generate
2. Add to your IDE's `mcp.json`:
   ```json
   { "mcpServers": { "mockforge": {
     "url": "http://localhost:3000/mcp",
     "headers": { "X-API-Key": "mf_your_key" }
   }}}
   ```
3. Restart IDE. The AI will discover tools automatically.

### Available Tools (v1 — read-only)

- `list_modules` — list all your Mock modules
- `get_api_doc` — read a module's API documentation
- `get_openapi` — get a module's OpenAPI spec

Write capabilities (create/update modules) coming in v2.

See [docs/mcp-usage.md](docs/mcp-usage.md) for details.
```

**docs/mcp-usage.md**：
- Cursor / Claude Code / Zed 的 mcp.json 配置差异
- Docker 部署场景的地址配置
- 常见问题（401 / 连不上）
- 示例 prompt：怎么引导 AI 用起来

**验收**：
- 文档无错别字、链接正确
- 按文档从零配一次 Cursor（或 Claude Code），实测能连通

**commit**: `Step-MCP-1.8: MCP usage documentation`

---

## 五、集成验收

### 端到端场景

在完成全部 8 个 Task 后，跑这条链路验证：

1. ✅ 在 MockForge Web UI 里通过对话生成一个 `order` 模块
2. ✅ Settings → API Keys → 生成 key
3. ✅ 在 Cursor 里配 mcp.json，粘贴 key
4. ✅ 重启 Cursor，问 AI："列一下我在 MockForge 里有哪些模块"
5. ✅ AI 调 `list_modules`，返回含 order
6. ✅ 问 AI："帮我看下 order 模块的接口文档"
7. ✅ AI 调 `get_api_doc`，正确输出
8. ✅ 问 AI："给我 order 的 OpenAPI"
9. ✅ AI 调 `get_openapi`，输出有效 spec
10. ✅ 吊销 key，再问 AI，返回 401

### 回归要求

- 所有新增 Task 的测试必须通过
- **完整测试套件不能退化**（CLAUDE.md 零容忍）
  - 基线（当前 PROGRESS.md 记录）：96 passed 绿 + 4 pre-existing responsive 失败
  - 本 Step 完成后：至少 96 + 10（新加）= 106 passed，无新增失败

### PROGRESS / CURSOR 更新

- `PROGRESS.md` 加 "Phase 6: MCP 集成" 章节
- `CURSOR.md` 已完成列表加 Step-MCP-1
- 子计划文件（本文件）在 Step 验收完成后删除
- `/compact` 后进入 Step-MCP-2

---

## 六、风险与回滚

### 风险

| 风险 | 应对 |
|------|------|
| MCP SDK 的 Streamable HTTP transport 与 Fastify 兼容性 | Task 1.3 先做 spike，若不兼容则用 `@fastify/express` 兼容层或改用 SDK 的 SSE transport |
| HMAC secret 默认值导致"不改 .env 就不安全" | 首次启动检测 `MCP_API_KEY_SECRET` 未设置则生成随机值写入文件 + 打印警告 |
| AsyncLocalStorage 在 Streamable 响应中丢失 context | 在 transport handler 外面包一层 runWithUser，确保所有 tool execute 都在同一 context |
| 新字段迁移失败（老数据库没迁移脚本） | `database.ts` 现有的 `ensureColumns` 机制已处理，只需追加新字段 |

### 回滚方案

- Git revert 到 Step-UX-Polish-5 commit（eb3bc47 之后最后一个绿点）
- 数据库字段保留无影响（nullable）

---

## 七、非本 Step 工作的明确记录

本 Step 只做读，**写能力的完整设计留给 Step-MCP-2**。Step-MCP-2 需要决策的点在此先备案：

- `create_module_from_spec` 如何桥接 ChatRunner
- MCP progress notifications 的具体实现
- access_log 的存储（是否需要新表 / 保留多久）
- 软 warnings 的 schema
- dry_run 的实现方式

这些在 Step-MCP-1 完成后、进入 Step-MCP-2 前再展开讨论。
