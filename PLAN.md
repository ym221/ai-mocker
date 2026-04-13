# MockForge 实现计划

> ⚠️ **【强制】执行协议 — 任何实施工作开始前必读**
>
> **禁止直接从本文件执行任何 Step。** 本文件是设计参考文档（2700+ 行），直接执行必然遗漏上下文。
>
> **正确的执行流程**（详见第十二节「执行策略」）：
> 1. 读 `CURSOR.md` → 定位当前 Phase/Step/Task
> 2. 读 `STEP-N-PLAN.md` → 当前 Step 的聚焦子计划（3000-8000 字，包含所有相关设计）
> 3. 如果 `STEP-N-PLAN.md` 不存在 → 扫描本文件所有相关章节 → 生成子计划 → 用户确认后再执行
> 4. 按 Task 循环：写代码 → 自测 → 通过则 git commit + 更新 `CURSOR.md` → 下一 Task
> 5. Step 所有 Task 完成 → 集成验收 → 更新 `PROGRESS.md` → 删除子计划 → `/compact` → 下一 Step
>
> **关键文件**：`CURSOR.md`（执行游标）> `STEP-N-PLAN.md`（子计划）> `PROGRESS.md`（归档）> 本文件（设计参考）
>
> **这不是建议，是强制规则。** 跳过子计划直接写代码 = 必然出错。

---

## 一、项目定位

### 1.1 什么是 MockForge

MockForge 是一个面向前端开发人员的 **AI 驱动 Mock API 平台**。用户通过自然语言对话（或上传接口文档/需求文档），由 AI 自动生成**真实可运行**的 Mock 接口（含数据库、CRUD、业务逻辑），用于前端开发联调。

**"真实可运行"意味着**：
- 有真实的 SQLite 数据库存储
- 增删改查是真实的数据库操作
- 支持分页、筛选、排序
- 支持复杂业务逻辑（状态流转、关联校验等）
- 支持批量生成逼真的测试数据

### 1.2 核心使用场景

| # | 场景 | 说明 |
|---|------|------|
| 1 | 需求文档 → Mock 接口 | 需求确定后，前端先用 Mock 开发，不等后端 |
| 2 | 接口文档 → Mock 接口 | 拿到 Swagger/手写文档，一键生成对应 Mock |
| 3 | 修改字段/逻辑 | 需求变更时，对话式修改已有接口 |
| 4 | 调试数据场景 | 测试分页/筛选/数据长度 → 灵活管理测试数据 |
| 5 | 接口测试 | 生成后直接在页面测试验证 |
| 6 | 切换真实接口 | 真实接口就绪后，前端只需改代理地址 |

### 1.3 核心设计决策

**AI 就是最好的"模板引擎"**。通过精心设计的 System Prompt 定义代码骨架和规范，AI 直接生成完整的 TypeScript 代码。后续修改直接对话式读文件→改文件，天然支持增量修改和复杂业务逻辑。

**不使用模板引擎**的原因（前一个版本的教训）：
- Handlebars 是 HTML 模板引擎，默认转义单引号（`'` → `&#x27;`），生成的 SQL 100% 报错
- 模板只解决"初次生成"，但"修改"才是高频场景。修改时还是要 AI 写代码，模板的价值被稀释
- 模板产物需要动态 import + 缓存破坏，复杂且不稳定
- AI 写的代码 AI 自己能改；模板产物 AI 看不懂、改不好

---

## 二、技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 前端框架 | Vue 3.5 + TypeScript | Composition API + `<script setup>` |
| 前端构建 | Vite 6 | |
| 前端样式 | Tailwind CSS 4 + shadcn-vue | 原子化 CSS + 组件库 |
| 前端状态 | Pinia 3 | |
| 前端路由 | Vue Router 4 | |
| 前端代码高亮 | shiki（通过 @shikijs/markdown-it 集成） | 对话中的代码块高亮 |
| 后端框架 | Fastify 5 + TypeScript | 高性能 Node.js 框架 |
| Fastify 插件 | @fastify/cors, @fastify/multipart, @fastify/static, @fastify/rate-limit | CORS、文件上传、静态服务、限流 |
| 数据库 | SQLite (better-sqlite3) | 嵌入式，零配置 |
| ORM（系统表） | Drizzle ORM（drizzle-orm + drizzle-orm/better-sqlite3） | 类型安全，管理 users/sessions/providers 等固定结构表 |
| ORM（Mock 表） | BaseModel（原生 SQL） | 管理 AI 动态生成的 Mock 数据表 |
| AI 接口 | Vercel AI SDK (ai) | 统一多 Provider + 内置 Agent Loop |
| AI 前端 | @ai-sdk/vue | useChat composable，SSE 解析 + 消息状态 + 工具调用 |
| 数据生成 | @faker-js/faker | 批量生成逼真测试数据 |
| Schema 验证 | Zod | |
| 认证 | JWT (jose) + bcryptjs | bcryptjs 纯 JS 实现，无编译依赖 |
| Markdown + 高亮 | markdown-it + @shikijs/markdown-it | 一体化集成，内置 XSS 防护 |
| 数据表组件 | @tanstack/vue-table | 虚拟滚动、排序、筛选、内联编辑 |
| 文件解析 | pdf-parse、mammoth、exceljs、yaml | PDF/Word/Excel/YAML 文本提取 |
| 定时任务 | node-cron | uploads 清理等定时任务 |
| TS 运行时 | tsx | 开发环境后端运行 + 动态 import .ts 文件 |
| 并行启动 | concurrently | 同时启动前后端 dev server |
| 包管理 | pnpm | |
| 运行时 | Node.js 22 LTS | |
| 容器 | Docker + docker-compose | |

### 关于 Agent CLI 的说明

> "Agent CLI"（Claude Code、Cursor Agent 等）是桌面端工具，设计用于本地文件系统操作。MockForge 是 Web 应用，AI 通过 HTTP API + 工具函数与后端交互。两者运行环境不同，不需要集成 Agent CLI。Vercel AI SDK 的 `streamText + tools + maxSteps` 就是 Web 环境下的 Agent 运行时，功能等价。用户只需配置 AI Provider（API Key + 模型），即可使用任何兼容 OpenAI API 的大模型。

---

## 三、项目结构

```
mockforge/
├── src/
│   ├── server/                          # 后端
│   │   ├── agent/                       # AI Agent 系统
│   │   │   ├── agent-runner.ts          # streamText 封装（构建 model/tools/prompt，返回 SSE 流）
│   │   │   ├── system-prompt.ts         # 系统提示词（代码骨架级别）
│   │   │   ├── tool-registry.ts         # 工具注册
│   │   │   └── tools/                   # 工具实现
│   │   │       ├── index.ts
│   │   │       ├── write-file.ts        # 写入 generated/ 下的文件
│   │   │       ├── read-file.ts         # 读取 generated/ 下的文件
│   │   │       ├── run-test.ts          # 执行接口测试
│   │   │       ├── manage-data.ts       # 数据增删改查 + 批量生成
│   │   │       ├── list-modules.ts      # 列出已有模块
│   │   │       └── delete-module.ts     # 删除模块
│   │   │
│   │   ├── core/                        # 核心基础设施
│   │   │   ├── database.ts              # SQLite 连接 + Drizzle 配置
│   │   │   ├── schema.ts               # Drizzle schema（系统表定义）
│   │   │   ├── base-model.ts            # 通用 CRUD Model（Mock 表用）
│   │   │   ├── response.ts              # 统一响应格式
│   │   │   ├── mock-router.ts           # Mock 接口动态路由（catch-all 分发）
│   │   │   ├── auth.ts                  # JWT 认证中间件
│   │   │   ├── encryption.ts            # AES 加密（API Key 存储）
│   │   │   ├── test-runner.ts           # 测试执行器（提供 test/assert/request 工具函数）
│   │   │   └── file-parser.ts           # 文件解析器（统一入口，按类型分发解析）
│   │   │
│   │   ├── api/                         # 系统 API（/api/...）
│   │   │   ├── auth.ts                  # 登录/注册
│   │   │   ├── users.ts                 # 用户管理（管理员）
│   │   │   ├── chat.ts                  # POST /api/chat (SSE)
│   │   │   ├── sessions.ts             # 会话 CRUD
│   │   │   ├── providers.ts             # AI Provider 管理
│   │   │   ├── modules.ts              # 模块管理
│   │   │   ├── presets.ts              # 项目预设 CRUD
│   │   │   ├── data.ts                  # 数据管理 API（表数据 CRUD + 批量生成）
│   │   │   ├── test.ts                  # 接口测试代理
│   │   │   └── upload.ts               # 文件上传 + 解析
│   │   │
│   │   ├── app.ts                       # Fastify 实例配置
│   │   └── server.ts                    # 启动入口
│   │
│   ├── client/                          # 前端（Vue 3）
│   │   ├── components/
│   │   │   ├── ui/                      # shadcn-vue 基础组件
│   │   │   ├── layout/
│   │   │   │   ├── AppLayout.vue
│   │   │   │   ├── AppSidebar.vue
│   │   │   │   └── AppHeader.vue
│   │   │   ├── chat/
│   │   │   │   ├── ChatPanel.vue        # 对话面板
│   │   │   │   ├── MessageList.vue
│   │   │   │   ├── MessageBubble.vue
│   │   │   │   ├── ToolStatus.vue
│   │   │   │   ├── ChatInput.vue        # 输入框（含文件上传按钮 + 拖拽区）
│   │   │   │   └── AttachmentPreview.vue # 附件预览卡片（缩略图/文件图标/删除）
│   │   │   ├── module/
│   │   │   │   ├── ModuleCard.vue
│   │   │   │   ├── EndpointList.vue
│   │   │   │   └── ApiTester.vue        # 内嵌接口测试器
│   │   │   ├── data/
│   │   │   │   ├── DataTable.vue        # 可编辑数据表格（@tanstack/vue-table）
│   │   │   │   ├── EditableCell.vue     # Cell 编辑态组件（按字段类型映射表单元素）
│   │   │   │   └── DataGenerator.vue    # 批量数据生成 dialog
│   │   │   └── common/
│   │   │       └── ConfirmDialog.vue    # 通用确认弹窗（删除/清空等二次确认）
│   │   ├── pages/
│   │   │   ├── LoginPage.vue
│   │   │   ├── ChatPage.vue             # 对话 + 生成
│   │   │   ├── ModulesPage.vue          # 模块列表
│   │   │   ├── ModuleDetailPage.vue     # 模块详情（接口/数据/文档/测试）
│   │   │   ├── SettingsPage.vue         # AI Provider 配置
│   │   │   └── AdminPage.vue            # 用户管理（管理员）
│   │   ├── stores/
│   │   │   ├── auth.ts
│   │   │   ├── chat.ts
│   │   │   ├── modules.ts
│   │   │   ├── provider.ts
│   │   │   └── preset.ts               # 项目预设 CRUD + 可用列表
│   │   ├── composables/
│   │   │   ├── use-api.ts
│   │   │   ├── use-upload.ts            # 文件上传（拖拽/粘贴/进度/预校验）
│   │   │   └── use-auth.ts
│   │   ├── router/index.ts
│   │   ├── App.vue
│   │   └── main.ts
│   │
│   └── shared/                          # 前后端共享
│       ├── types.ts                     # Session, Message, Module, Provider, User 等类型定义
│       └── constants.ts                 # API 路径、文件大小限制、支持的文件类型等常量
│
├── scripts/                             # 自测脚本（tsx scripts/test-step-N.ts）
├── data/                                # 运行时数据（.gitignore 排除）
│   └── mockforge.db                    # SQLite 数据库文件
├── uploads/                             # 上传文件临时存储（.gitignore 排除）
│   └── {userId}/
├── generated/                           # AI 生成的模块文件（.gitignore 排除）
│   └── {userId}/
│       └── {module-name}/
│           ├── _meta.json
│           ├── schema.sql
│           ├── controller.ts
│           ├── test.ts
│           ├── _context.md              # 模块上下文（给 AI，精简，自动注入对话）
│           └── api-doc.md               # 接口文档（给人，完整详细，可下载）
├── index.html
├── vite.config.ts
├── tsconfig.json                        # 基础配置
├── tsconfig.server.json                 # 后端配置
├── tsconfig.client.json                 # 前端配置
├── package.json
├── .claude/                             # Claude Code 项目级配置
│   └── settings.json                   # 权限配置（全部放开）
├── .env.example
├── CLAUDE.md                            # Claude Code 开发指南
├── PROGRESS.md                          # 实时实现进度（AI 自动维护）
├── PROMPT.md                            # 新窗口启动提示词（固定内容）
├── Dockerfile
├── docker-compose.yml
└── PLAN.md                              # 本文件
```

---

## 四、核心设计

### 4.1 路由前缀设计

```
系统 API：  /api/auth/..., /api/chat, /api/modules, ...
Mock 接口：/mock/{module}/...
```

| 场景 | 路径 |
|------|------|
| 订单模块 | `/mock/order/`, `/mock/order/:id` |
| 商品模块 | `/mock/product/`, `/mock/product/:id` |
| 零散接口（无模块归属） | `/mock/misc/captcha`, `/mock/misc/upload` |

- `/mock/` 前缀与系统 API `/api/` 永不冲突
- 每个模块用自己的名字作为二级前缀
- 零散接口归入 `misc`（miscellaneous）模块
- 前端切到真实接口时只需改代理目标，路径保持一致
- **Mock 接口不需要鉴权**：前端代理直接访问，不带 JWT。这样前端联调时和真实接口一致（真实接口有自己的鉴权）
- **Mock 接口 CORS 全开放**：`@fastify/cors` 对 `/mock/*` 路径配置 `origin: true`（允许所有来源），确保任何前端项目都能直接跨域调用，无需代理。CORS 插件注册在 mock-router 之前，自动处理 OPTIONS preflight。
- **Mock 接口响应头**：mock-router 自动设置 `Content-Type: application/json; charset=utf-8`

### 4.2 动态路由机制（mock-router.ts）

**核心思路**：启动时注册一个 `/mock/*` catch-all 路由，运行时根据 `_meta.json` + controller 动态分发请求。AI 写完文件立即生效，无需重启。

```typescript
// 伪代码
app.all('/mock/*', async (req, reply) => {
  // 0. 确定 userId：从 query 参数 ?_uid= 或 Header X-Mock-User 获取
  //    Mock 接口不需要 JWT 鉴权，但需要知道是哪个用户的模块
  //    前端代理时自动附加 userId（在 mock-router 中间件中处理）
  //    如果未指定 userId，使用默认用户（单用户场景兼容）

  // 1. 解析 URL → 模块名 + 子路径
  //    /mock/order       → module="order", subPath="/"
  //    /mock/order/123   → module="order", subPath="/123"

  // 2. 读取 generated/{userId}/{module}/_meta.json，找到匹配的端点
  //    遍历 endpoints，用简单的路径匹配（不用 path-to-regexp 库，自己实现）：
  //    - 固定路径："/batch-ship" === subPath → 直接匹配
  //    - 参数路径："/:id" → 正则 /^\/([^/]+)$/，提取 params.id
  //    - 根路径："/" → subPath === "/" 或 subPath === ""
  //    - 匹配顺序：固定路径优先于参数路径（防止 /batch-ship 被 /:id 先匹配）

  // 3. 动态加载 controller（见下方说明）

  // 4. 调用对应函数
  //    ctrl.list(query) / ctrl.getById(id) / ctrl.create(body) / ...

  // 5. 返回结果
});
```

**Mock 接口的用户识别**：Mock 接口不需要 JWT 鉴权，但需要知道请求的是哪个用户的模块。方案：
- 前端在 Vite proxy 配置中自动附加 `X-Mock-User: {userId}` Header
- mock-router 从 Header 中读取 userId，定位到 `generated/{userId}/` 目录
- 如果未指定（如直接 curl），使用管理员 userId 作为默认值（单用户开发场景）

**为什么这比 v1 的方案简单得多**：
- v1 尝试用 `app.register()` 注册路由 → Fastify 禁止启动后注册 → 改用动态路由表 + 代理 → 还有 await 和缓存问题
- v2 只用一个 catch-all，所有分发逻辑在应用层处理，完全不依赖 Fastify 的路由注册
- controller.ts 用 `import()` 动态加载，`?t=timestamp` 保证每次拿到最新版本
- `_meta.json` 是静态 JSON，`fs.readFileSync` 即可，无缓存问题

**不需要 routes.ts**：`_meta.json` 的 endpoints 已完整描述路由映射（method + path + type），mock-router 直接据此匹配并调用 controller 的对应函数，不需要额外的路由定义文件。

**schema.sql 执行时机**：`write_file` 工具检测到 `.sql` 后缀时，自动执行 SQL 内容（`db.exec(content)`）。这样 AI 写完 schema.sql 后表立即创建，无需额外工具调用。

**modules 表同步**：`write_file` 工具写入 `_meta.json` 时，自动同步到 modules 系统表（插入或更新）。这样前端模块列表页能直接从 modules 表查询，不需要扫描文件系统。`delete_module` 工具同时删除文件和 modules 表记录。

**controller.ts 动态加载方式**：AI 生成的 controller.ts 是 TypeScript 文件，Node.js 原生不能 `import()` .ts 文件。解决方案：
- 开发环境使用 `tsx` 作为运行时（`tsx watch src/server/server.ts`），它原生支持 TS import
- 生产环境将 generated/ 下的 .ts 编译为 .js 后加载，或继续使用 tsx
- 动态 import 使用 `?t=timestamp` 破坏缓存，import 新版本后删除旧缓存条目防止内存泄漏

### 4.3 每个模块的文件结构

AI 为每个模块生成 6 个文件，放在 `generated/{userId}/{module-name}/` 下（项目根目录）：

| 文件 | 作用 | 给谁看 | 大小控制 |
|------|------|--------|---------|
| `_meta.json` | 结构化元信息（字段、端点、路由映射、测试结果） | 系统 | — |
| `schema.sql` | 建表 SQL（write_file 写入后自动执行） | 系统 | — |
| `controller.ts` | 业务逻辑（CRUD + 自定义逻辑） | 系统 | — |
| `test.ts` | 测试用例（CRUD + 业务逻辑验证） | 系统 | — |
| `_context.md` | 模块上下文（精简，自动注入 AI 对话） | AI | 控制在 ~500 token |
| `api-doc.md` | 完整接口文档（请求/响应/cURL 示例） | 用户 | 不限，完整详细 |

**_context.md**（给 AI，每次修改后自动更新）：
```markdown
# order 模块上下文
## 基本信息
模块名: order | 版本: 3 | 状态: active
## 字段清单
orderNo(string,必填) | status(enum:pending/paid/shipped) | totalAmount(decimal,必填)
## 业务规则
- 状态单向流转：pending → paid → shipped
- 已发货订单不可删除
## 变更历史
- v3: status → orderStatus
- v2: 添加 remark
- v1: 初始生成
## 关联文档
完整 API 文档见 api-doc.md
```

**api-doc.md**（给人，可下载，每次修改后自动更新）：
- 每个接口完整的请求参数表、响应示例 JSON、cURL 命令
- 如果用户选了项目预设（如自定义响应格式），文档中的示例按预设格式生成
- 包含代理配置（Vite/Webpack/Nginx）

**不需要 routes.ts**：`_meta.json` 的 endpoints 已定义路由映射，mock-router 直接据此分发。
**不需要 model.ts**：BaseModel 是通用的。
**不需要 types.ts**：类型内联在 controller.ts 里。
**不需要 seed.ts**：种子数据通过 `manage_data` 工具直接操作。
**不需要 config.ts**：配置在 `_meta.json` 里。

### 4.4 `_meta.json` 结构

```jsonc
{
  "name": "order",
  "displayName": "订单管理",
  "description": "电商订单管理模块",
  "basePath": "/mock/order",
  "version": 3,                           // 每次修改递增
  "status": "active",                     // active | error | disabled
  "entities": [{
    "name": "order",
    "tableName": "mock__order",           // AI 只写 mock__+原名，系统自动加 userId 前缀
    "displayName": "订单",
    "fields": [
      { "name": "orderNo", "type": "string", "displayName": "订单号", "required": true },
      { "name": "status", "type": "enum", "displayName": "状态", "enumValues": ["pending", "paid", "shipped"], "defaultValue": "pending" },
      { "name": "totalAmount", "type": "decimal", "displayName": "总金额", "required": true }
    ]
  }],
  "endpoints": [
    { "method": "GET", "path": "/", "name": "订单列表", "type": "list" },
    { "method": "GET", "path": "/:id", "name": "订单详情", "type": "detail" },
    { "method": "POST", "path": "/", "name": "创建订单", "type": "create" },
    { "method": "PUT", "path": "/:id", "name": "更新订单", "type": "update" },
    { "method": "DELETE", "path": "/:id", "name": "删除订单", "type": "delete" },
    { "method": "POST", "path": "/batch-ship", "name": "批量发货", "type": "custom", "handler": "batchShip" }
  ],
  "config": {
    "delay": { "min": 0, "max": 0 },     // 延迟模拟（ms）
    "errorRate": 0                         // 异常概率（0-1）
  },
  "testResults": {
    "passed": 5, "total": 5,
    "lastRun": "2024-01-01T00:00:00Z",
    "details": [
      { "endpoint": "GET /", "passed": true },
      { "endpoint": "POST /", "passed": true }
    ]
  },
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

### 4.5 System Prompt 设计

System Prompt 的质量直接决定生成成功率。设计原则：
- **骨架固定**：给出完整的代码模板，AI 只需填入具体的字段和逻辑
- **示例驱动**：给一个完整的示例模块，AI 照着改
- **约束明确**：禁止什么、必须什么，编号列清楚
- **低配友好**：骨架越固定，低配模型需要的"创造力"越少

> **注意**：以下是计划中的简写版 System Prompt。实际 `system-prompt.ts` 中需要：
> 1. 将所有引用（如"结构见 4.4 节"）替换为完整内联内容
> 2. 每个工具的 parameters 用 Zod schema 定义（如 `write_file: z.object({ path: z.string(), content: z.string() })`）
> 3. 在骨架之后附加一个**完整的示例模块**（包含 _meta.json + schema.sql + controller.ts + test.ts + _context.md + api-doc.md 的完整内容），让 AI 照着改
> 4. 动态注入当前用户的已有模块列表（`buildSystemPrompt(userId, moduleList)`）

```
你是 MockForge 的 AI 助手，负责生成和维护 Mock API 接口。

═══════════════════════════════════════
工具列表
═══════════════════════════════════════
- write_file(path, content)       写入 generated/{userId}/ 下的文件（.sql 后缀会自动执行建表）
                                  安全：path 经过校验，禁止 ../ 和绝对路径，限制在 generated/{userId}/ 下
- read_file(path)                 读取 generated/{userId}/ 下的文件（同样做路径校验）
- run_test(moduleName)            执行模块的 test.ts，运行所有测试用例
- manage_data(action, ...)        操作测试数据
  - insert: 插入一条
  - bulk_generate: 批量生成 faker 数据（根据 _meta.json fields 自动映射 faker 方法）
  - delete: 删除指定记录
  - clear: 清空表数据
- list_modules()                  列出所有模块
- delete_module(name)             删除模块（含表和文件）

═══════════════════════════════════════
BaseModel API（controller.ts 中使用）
═══════════════════════════════════════
const model = new BaseModel('mock__{表名}');
// 注意：AI 只写 mock__+表名，系统自动注入 userId 前缀，实际表名为 mock__{userId}_{表名}
// userId 传递方式：mock-router 调用 controller 函数前，通过 AsyncLocalStorage 设置当前 userId
// BaseModel 构造函数内部从 AsyncLocalStorage 读取 userId，AI 无需关心

model.findAll({ page, pageSize, where, orderBy? })
  → { list: Record[], total: number, page: number, pageSize: number }
  - where 解析规则（BaseModel 内部实现）：
    直接值: { status: 'active' }              → WHERE `status` = ?        params: ['active']
    like:   { name: { like: '%test%' } }      → WHERE `name` LIKE ?      params: ['%test%']
    gt/lt:  { age: { gt: 18 } }               → WHERE `age` > ?          params: [18]
    in:     { status: { in: ['a','b'] } }     → WHERE `status` IN (?,?)  params: ['a','b']
    多条件自动 AND 连接
  - orderBy: 'created_at DESC'（直接拼入 SQL，仅限字段名+方向，不做用户输入拼接防注入）

model.findById(id: number)
  → Record | null

model.create(data: Record<string, unknown>)
  → Record（含自动生成的 id、created_at、updated_at）
  - 自动 camelCase → snake_case 转换

model.update(id: number, data: Record<string, unknown>)
  → Record
  - 自动更新 updated_at

model.delete(id: number)
  → boolean（是否删除成功）

model.count(where?: Record)
  → number

model.raw(sql: string, params?: any[])
  → any[]（复杂查询兜底，尽量用上面的方法）
  - 必须使用 params 参数化查询（? 占位符），禁止字符串拼接 SQL 防止注入

═══════════════════════════════════════
统一响应格式（response.ts）
═══════════════════════════════════════
success(data, message?)    → { success: true, data, message }
paginated(list, total, page, pageSize)
                           → { success: true, data: { list, total, page, pageSize } }
error(code, message)       → { success: false, message }（HTTP 状态码也设为 code）

═══════════════════════════════════════
代码骨架（必须严格遵守）
═══════════════════════════════════════

每个模块固定 6 个文件，AI 按顺序生成：

【文件 1: _meta.json】
（实际 prompt 中内联完整结构，参见 4.4 节）

【文件 2: schema.sql】
CREATE TABLE IF NOT EXISTS `mock__{表名}` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 业务字段（全部加反引号，snake_case）
  `created_at` TEXT DEFAULT (datetime('now')),
  `updated_at` TEXT DEFAULT (datetime('now'))
);

注意：
- 表名前缀 mock__（双下划线），AI 只写 mock__+表名，不要写 userId
- 所有标识符加反引号（处理 SQL 保留字）
- 不要重复定义 id / created_at / updated_at
- DEFAULT 值用单引号，不要用 HTML 实体
- write_file 写入 .sql 后会自动执行建表，无需额外操作
- 修改字段时的 schema 变更策略（SQLite ALTER TABLE 限制）：
  AI 应使用以下模式处理字段修改（重命名/删除/改类型）：
  1. CREATE TABLE `mock__{表名}_new` (新结构);
  2. INSERT INTO `mock__{表名}_new` SELECT 迁移字段 FROM `mock__{表名}`;
  3. DROP TABLE `mock__{表名}`;
  4. ALTER TABLE `mock__{表名}_new` RENAME TO `mock__{表名}`;
  注意：新增字段可以直接 ALTER TABLE ADD COLUMN，不需要重建

【文件 3: controller.ts】
// 骨架代码，AI 生成时严格遵循此结构
// 注意：import 路径使用 @core 别名（tsconfig paths + tsx 均支持）
// .js 后缀是 ESM 规范要求，tsx 会自动解析到 .ts 文件
import { BaseModel } from '@core/base-model.js';
import { success, paginated, error } from '@core/response.js';

const model = new BaseModel('mock__{表名}');

// --- List ---
export function list(query: Record<string, string>) {
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || 20;
  const where: Record<string, unknown> = {};
  // 按需添加过滤条件
  const result = model.findAll({ page, pageSize, where });
  return paginated(result.list, result.total, result.page, result.pageSize);
}

// --- Detail ---
export function getById(id: string) {
  const item = model.findById(Number(id));
  if (!item) return error(404, '记录不存在');
  return success(item);
}

// --- Create ---
export function create(body: Record<string, unknown>) {
  const item = model.create(body);
  return success(item, 'Created');
}

// --- Update ---
export function update(id: string, body: Record<string, unknown>) {
  const existing = model.findById(Number(id));
  if (!existing) return error(404, '记录不存在');
  const item = model.update(Number(id), body);
  return success(item, 'Updated');
}

// --- Delete ---
export function remove(id: string) {
  const deleted = model.delete(Number(id));
  if (!deleted) return error(404, '记录不存在');
  return success(null, 'Deleted');
}

// --- 自定义业务逻辑在这里添加 ---

注意：
- mock-router 根据 _meta.json 的 endpoints 自动将 HTTP 请求路由到 controller 的对应函数
- endpoints 中 type 与函数的映射关系：
  list → list(query)，detail → getById(id)，create → create(body)
  update → update(id, body)，delete → remove(id)
- 自定义端点在 _meta.json 中用 type: "custom" + handler: "函数名" 声明

【文件 4: test.ts】
import { test, assert, request } from '@core/test-runner.js';

export default [
  // CRUD 基础测试
  test('创建记录', async () => {
    const res = await request.post('/mock/{模块名}', { /* 测试数据 */ });
    assert.ok(res.success);
    assert.exists(res.data.id);
    return res.data.id; // 返回值自动存入 ctx.lastId
  }),

  test('查询详情-数据一致性', async (ctx) => {
    const res = await request.get(`/mock/{模块名}/${ctx.lastId}`);
    assert.ok(res.success);
    assert.eq(res.data.字段名, 期望值); // 验证写入的数据能正确读出
  }),

  // 业务逻辑测试（根据需求编写）
  test('业务规则描述', async (ctx) => {
    // 测试具体的业务逻辑（状态流转、校验规则等）
  }),
];

注意：
- 测试用例要覆盖 CRUD 基础流程和用户需求中的业务逻辑
- test 函数返回值会存入 ctx.lastId，供后续用例使用
- 使用 test-runner.ts 提供的 assert（ok/not/eq/exists）和 request（get/post/put/delete）
- 以上断言（如 res.success）是默认响应格式的示例。如果用户指定了自定义响应格式（如 { code: 0, data }），AI 应按实际格式写断言（如 assert.eq(res.code, 0)）

【文件 5: _context.md】
（模块上下文，给 AI 看，精简。包含：基本信息、字段清单、业务规则、变更历史。控制在 ~500 token。）

【文件 6: api-doc.md】
（完整接口文档，给用户看。包含：每个接口的请求参数表 + 响应示例 JSON + cURL 命令 + 代理配置。）

═══════════════════════════════════════
工作流程
═══════════════════════════════════════

【新建模块】
1. 先用自然语言回应用户（如"好的，我来帮你生成用户管理接口，包含 name/email/phone 三个字段和标准 CRUD 端点。"），让用户知道 AI 理解了需求
2. 按顺序调用 write_file 写入 6 个文件（含 test.ts、_context.md、api-doc.md）
3. 调用 run_test 执行测试
4. 全通过 → manage_data bulk_generate 生成 20 条种子数据
5. 输出完成摘要，包含：
   - 生成了什么（模块名 + 端点数 + 字段列表）
   - Mock 接口地址（如 `http://localhost:3000/mock/user`）
   - 一个 cURL 示例命令（如 `curl http://localhost:3000/mock/user`）
   - 前端代理配置提示
   - `[download:模块名/api-doc.md]` 标记（前端渲染为 API 文档下载按钮）
6. 不通过 → read_file 查看失败用例和相关代码 → 判断是业务代码还是测试代码的问题 → 修复对应文件 → 再次 run_test（最多 2 轮）
7. 仍失败 → 告知用户具体错误，停止

【修改模块】
1. read_file _context.md → 了解当前模块上下文（如果对话已选中模块，_context.md 已自动注入，可跳过此步）
2. 如果用户的修改请求不够明确 → 先确认再动手
3. read_file 需要修改的文件
4. write_file 修改后的文件 + 更新 _meta.json（version +1）
5. write_file 更新 test.ts（补充新增/变更逻辑的测试用例）
6. run_test 执行测试
7. 更新 _context.md（变更历史）+ api-doc.md（接口文档）

【用户上传文件时】
1. 消息中会包含文件内容（文档文本或图片）
2. 理解文件内容（需求文档/接口文档/数据库设计/截图等）
3. 提取关键信息（字段、接口、业务规则）
4. 按【新建模块】或【修改模块】流程继续

【用户提供了接口文档时（重要）】
- 如果文档明确定义了接口路径、字段名、字段类型、请求/响应结构 → 必须严格按照文档实现，不要自行修改命名或结构
- 如果文档使用了特定的字段命名风格（如 snake_case 或 camelCase）→ 保持文档的风格，不要自动转换
- 如果文档定义了特定的响应格式（如 { code: 0, data, msg } 而非默认的 { success, data, message }）→ 在 controller 中直接返回文档规定的格式，不使用 response.ts 的封装
- 如果文档定义了特定的 URL 路径（如 /api/v1/orders 而非 /mock/order）→ 在 _meta.json 中按文档路径声明
- 概括：文档的描述 > 默认骨架。骨架是没有文档时的兜底方案

【禁止】
- 禁止修复循环超过 2 轮
- 禁止生成 6 个标准文件之外的文件
- 禁止修改 generated/ 之外的文件
- 禁止在 controller.ts 中直接写 SQL（必须用 BaseModel，复杂查询用 model.raw()）
- 成功后禁止自行"优化"用户没有要求的内容

【跨模块关联】
- 用户可能要求"订单关联用户 ID"等跨模块关联
- Mock 接口不需要真正的外键约束，但 controller 中可以通过 model.raw() 做简单的 JOIN 查询
- 关联字段（如 userId）存储为普通 integer 类型，AI 在 controller 中实现关联查询逻辑
- 如果用户要求同时生成多个关联模块，按顺序依次生成（先生成被引用的模块，再生成引用方）

【用户意图优先】
- "只要列表接口" → endpoints 只放 list
- 没有明确时 → 默认 list/detail/create/update/delete
- 字段名用 camelCase，BaseModel 自动转 snake_case
- 回复用中文，代码保持英文
```

### 4.6 模块上下文与 API 文档自维护

原来的 README.md 拆分为两个文件，各司其职：

**_context.md（给 AI，~500 token，自动注入对话上下文）**：
```markdown
# order 模块上下文
## 基本信息
模块名: order | 版本: 3 | 状态: active | 基础路径: /mock/order
## 字段清单
orderNo(string,必填) | status(enum:pending/paid/shipped) | totalAmount(decimal,必填)
## 端点
GET / (list) | GET /:id (detail) | POST / (create) | PUT /:id (update) | DELETE /:id (delete) | POST /batch-ship (custom:batchShip)
## 业务规则
- 状态单向流转：pending → paid → shipped
- 已发货订单不可删除
## 变更历史
- v3: status → orderStatus
- v2: 添加 remark
- v1: 初始生成
## 关联文档
完整 API 文档见 api-doc.md（用户可在模块详情页或对话中下载）
```

**api-doc.md（给人，完整详细，可下载）**：
```markdown
# 订单管理 API 文档

> 自动生成于 2024-01-01，版本 v3

## 接口列表

### GET /mock/order — 订单列表

**请求参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| page | number | 否 | 页码，默认 1 |
| pageSize | number | 否 | 每页条数，默认 20 |

**响应示例**：
（按项目预设格式生成，如 { code: 0, data: { list, total } } 或默认 { success: true, data: ... }）

**cURL**：
curl http://localhost:3000/mock/order?page=1&pageSize=20

...（每个接口完整的请求/响应/cURL）

## 代理配置
Vite:   proxy: { '/mock': { target: 'http://localhost:3000', headers: { 'X-Mock-User': '{userId}' } } }
Nginx:  location /mock/ { proxy_pass http://localhost:3000; proxy_set_header X-Mock-User {userId}; }
```

**自维护核心**：
- System Prompt 要求 AI 每次生成/修改模块后同时更新 _context.md 和 api-doc.md
- _context.md 精简控制在 ~500 token，是对话中自动注入的上下文来源
- api-doc.md 是面向用户的完整文档，在模块详情页可下载，对话完成后也可通过下载按钮获取
- 如果对话选择了项目预设，api-doc.md 中的响应示例按预设格式生成

### 4.7 测试策略

**核心思路**：AI 生成业务代码的同时生成测试用例（`test.ts`），由固定的测试执行器（`test-runner.ts`）运行。AI 最了解需求和业务逻辑，由它写测试用例能覆盖固定方案无法触及的业务场景。

**架构分工**：

| 组件 | 谁写 | 职责 |
|------|------|------|
| `core/test-runner.ts` | 开发者（写一次） | 提供 `test()`、`assert`、`request` 工具函数 |
| `generated/.../test.ts` | AI（每个模块） | 编写具体测试用例（CRUD + 业务逻辑） |
| `tools/run-test.ts` | 开发者（写一次） | 动态 import 模块的 test.ts 并执行，返回结果 |

**test-runner.ts 提供的 API**：

```typescript
// test(name, fn) — 定义一个测试用例，fn 返回值存入 ctx.lastId
function test(name: string, fn: (ctx: { lastId?: any }) => Promise<any>)

// assert — 断言工具
assert.ok(value)              // truthy
assert.not(value)             // falsy
assert.eq(actual, expected)   // 严格相等
assert.exists(value)          // 非 null/undefined

// request — HTTP 请求（自动拼接 baseURL http://localhost:{PORT}）
request.get(path)
request.post(path, body)
request.put(path, body)
request.delete(path)
```

**run_test 执行流程**：

```
1. 清理该模块的测试残留数据（manage_data clear）
2. 动态 import 模块的 test.ts（带 ?t=timestamp 破坏缓存）
3. 按顺序执行所有测试用例，用例间通过 ctx 传递数据（如 lastId）
4. 返回精简结果：{ passed: 5, total: 6, failures: [{ name, error }] }
```

**测试失败时的修复策略**：

AI 读取失败信息 + 相关代码，自行判断是业务代码还是测试代码的问题，修复对应文件。不限制只能改哪个文件。

**测试时机**：
- 新建模块后：全量测试
- 修改模块后：更新 test.ts 后全量测试
- 手动触发：页面上的"测试"按钮

### 4.8 文件上传与解析

用户上传文件（需求文档、接口文档、截图等），服务端解析后将内容注入 AI 对话上下文，AI 据此生成 Mock 接口。

**支持的文件类型**：

| 分类 | 格式 | 解析方式 | 传给 AI 的形式 |
|------|------|---------|---------------|
| 图片 | PNG、JPG、GIF、WebP、SVG | 不解析，直接传 | 多模态 image content（vision） |
| PDF | .pdf | pdf-parse 提取文本 | 文本拼入 user message |
| Word | .docx | mammoth 提取文本 | 文本拼入 user message |
| Excel | .xlsx、.csv | exceljs / 直接读取 → 转 Markdown 表格 | 文本拼入 user message |
| 结构化 | Swagger/OpenAPI .json/.yaml | JSON.parse / yaml.parse | 结构化文本拼入 user message |
| 文本 | .md、.txt、.json、.yaml、.html | 直接读取 | 文本拼入 user message |

**处理流程**：

```
用户拖拽/选择文件（支持多文件）
  │
  ▼ ① 前端预校验
  检查文件大小（单文件 ≤ 10MB）、类型白名单、数量（≤ 5 个）
  → 不通过则提示用户，不发请求
  │
  ▼ ② 上传到服务端
  POST /api/upload (multipart/form-data)
  → 返回 { fileId, fileName, fileType, parsedContent | imageUrl, preview }
  │
  ▼ ③ 前端显示附件预览
  图片 → 缩略图
  文档 → 文件名 + 类型图标 + 内容摘要（前 200 字）
  │
  ▼ ④ 用户发送消息时，附件随消息一起提交
  │
  ▼ ⑤ 后端 chat.ts 构建 AI 消息
  图片附件 → 多模态 content [{ type: 'image', image: base64 }, { type: 'text', text: '用户消息' }]
  文档附件 → 拼接文本 content: '用户消息\n\n--- 附件: xxx.pdf ---\n提取的文本内容'
```

**file-parser.ts 统一解析器**：

```typescript
// 统一入口，按 MIME 类型分发
async function parseFile(buffer: Buffer, mimeType: string, fileName: string): Promise<ParseResult> {
  // 图片类 → 不解析文本，返回 base64
  if (mimeType.startsWith('image/'))
    return { type: 'image', base64: buffer.toString('base64'), mimeType };

  // PDF
  if (mimeType === 'application/pdf')
    return { type: 'document', text: await parsePdf(buffer), fileName };

  // Word
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    return { type: 'document', text: await parseDocx(buffer), fileName };

  // Excel
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    return { type: 'document', text: await parseXlsx(buffer), fileName };

  // CSV
  if (mimeType === 'text/csv')
    return { type: 'document', text: buffer.toString('utf-8'), fileName };

  // JSON（可能是 Swagger）
  if (fileName.endsWith('.json'))
    return { type: 'document', text: buffer.toString('utf-8'), fileName };

  // YAML（可能是 OpenAPI）
  if (fileName.endsWith('.yaml') || fileName.endsWith('.yml'))
    return { type: 'document', text: buffer.toString('utf-8'), fileName };

  // 其他文本类
  if (mimeType.startsWith('text/'))
    return { type: 'document', text: buffer.toString('utf-8'), fileName };

  throw new Error(`不支持的文件类型: ${mimeType}`);
}

type ParseResult =
  | { type: 'image'; base64: string; mimeType: string }
  | { type: 'document'; text: string; fileName: string };
```

**API 设计**：

```
POST /api/upload
  Content-Type: multipart/form-data
  Body: file (二进制)
  Response: {
    fileId: string,          // UUID，用于后续关联到消息
    fileName: string,
    fileType: 'image' | 'document',
    preview: string,         // 图片: base64 缩略图; 文档: 前 200 字摘要
    parsedContent?: string,  // 文档: 完整提取文本（图片无此字段）
    imageUrl?: string,       // 图片: 临时访问 URL
  }
```

**存储策略**：
- 上传文件临时存储在 `uploads/{userId}/` 目录，24 小时后自动清理
- 图片需要保留到对话结束（AI 需要通过 URL 访问），用定时任务清理过期文件
- 文档解析后文本已拼入消息，原文件可提前清理
- `messages.attachments` 字段只存元信息（fileId、fileName、fileType），不存文件内容

**前端交互**：
- 输入框支持拖拽上传和点击上传（按钮在输入框左侧）
- 上传中显示进度条
- 上传完成显示预览卡片（可删除）
- 多文件并行上传
- 粘贴图片自动上传（Ctrl+V 截图）

**图片静态服务**：
- 上传的图片需要通过 URL 访问（AI 多模态输入、前端预览）
- 在 `app.ts` 中注册 `@fastify/static`，将 `uploads/` 目录映射到 `/uploads/` 路径
- 访问需要鉴权（验证 JWT + 只能访问自己的文件）

**多模态兼容性**：
- 并非所有模型都支持 vision（图片输入）
- 上传图片时检查用户当前选择的模型是否支持多模态
- 不支持时：提示用户切换模型，或降级为"不发送图片"

### 4.9 Token 优化策略

| 策略 | 说明 |
|------|------|
| 骨架固定 | AI 只需填空，生成的 token 量少 |
| 修改时先读再写 | AI 先 read_file 读取当前文件，修改后 write_file 全量写回。虽然是全量写入，但 AI 只需思考变更部分 |
| 测试结果精简 | 只返回通过/失败+原因，不返回完整响应体 |
| _meta.json | AI 不需要读所有文件就能了解模块状态 |
| _context.md 精简 | 控制在 ~500 token，新会话自动注入模块上下文（比读全部文件省 token） |
| api-doc.md 分离 | 完整文档给人看不给 AI，不消耗 AI token |
| 最多 2 轮修复 | 防止无限循环消耗 token |

---

## 五、数据库设计

### 5.1 系统表（Drizzle ORM 管理）

```sql
-- 用户
CREATE TABLE `users` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `username` TEXT NOT NULL UNIQUE,
  `password_hash` TEXT NOT NULL,
  `display_name` TEXT,
  `role` TEXT NOT NULL DEFAULT 'user',     -- admin | user
  `is_active` INTEGER DEFAULT 1,
  `created_at` TEXT DEFAULT (datetime('now')),
  `updated_at` TEXT DEFAULT (datetime('now'))
);

-- AI Provider 配置
CREATE TABLE `providers` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `name` TEXT NOT NULL,                    -- 显示名
  `type` TEXT NOT NULL,                    -- anthropic | openai | google | openai-compatible | custom
  `api_key_encrypted` TEXT,
  `base_url` TEXT,
  `default_model` TEXT NOT NULL,
  `scope` TEXT NOT NULL DEFAULT 'private', -- public | private
  `owner_id` INTEGER REFERENCES users(id),
  `is_verified` INTEGER DEFAULT 0,        -- 是否已验证可用
  `is_active` INTEGER DEFAULT 1,
  `created_at` TEXT DEFAULT (datetime('now')),
  `updated_at` TEXT DEFAULT (datetime('now'))
);

-- 项目预设（提示词模板）
CREATE TABLE `presets` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `name` TEXT NOT NULL,                    -- 显示名（如"公司标准接口规范"）
  `description` TEXT,                     -- 简要说明
  `content` TEXT NOT NULL,                -- JSON 配置（responseFormat, fieldNaming, pagination, customPrompt）
  `scope` TEXT NOT NULL DEFAULT 'private', -- public | private
  `owner_id` INTEGER REFERENCES users(id),
  `is_active` INTEGER DEFAULT 1,
  `created_at` TEXT DEFAULT (datetime('now')),
  `updated_at` TEXT DEFAULT (datetime('now'))
);

-- 对话会话
CREATE TABLE `sessions` (
  `id` TEXT PRIMARY KEY,                   -- UUID
  `title` TEXT DEFAULT '新对话',
  `user_id` INTEGER REFERENCES users(id),
  `provider_id` INTEGER REFERENCES providers(id),
  `model` TEXT,                          -- 可覆盖 provider 的默认模型（null 时用 provider.default_model）
  `preset_id` INTEGER REFERENCES presets(id), -- 关联的项目预设（null 表示用默认骨架）
  `module_name` TEXT,                    -- 当前选中的模块名（null 表示未选中，AI 自行判断）
  `created_at` TEXT DEFAULT (datetime('now')),
  `updated_at` TEXT DEFAULT (datetime('now'))
);
-- 注：用户在对话顶部切换 Provider/Model/Preset/Module 时，更新当前 session 对应字段

-- 对话消息
CREATE TABLE `messages` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `session_id` TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  `role` TEXT NOT NULL,                    -- user | assistant
  `content` TEXT,
  `tool_calls` TEXT,                       -- JSON: [{ toolCallId, toolName, args, result }]
  `attachments` TEXT,                      -- JSON: [{ fileId, fileName, fileType, preview }]
  `created_at` TEXT DEFAULT (datetime('now'))
);

-- 已生成模块注册
CREATE TABLE `modules` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `name` TEXT NOT NULL,
  `user_id` INTEGER REFERENCES users(id),
  `display_name` TEXT NOT NULL,
  `description` TEXT,
  `base_path` TEXT NOT NULL,
  `status` TEXT DEFAULT 'active',
  `created_at` TEXT DEFAULT (datetime('now')),
  `updated_at` TEXT DEFAULT (datetime('now')),
  UNIQUE(`name`, `user_id`)
);

-- Mock 请求日志（用于 8.3 请求日志功能）
CREATE TABLE `mock_requests` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `user_id` INTEGER REFERENCES users(id),
  `module_name` TEXT NOT NULL,
  `method` TEXT NOT NULL,
  `path` TEXT NOT NULL,
  `status_code` INTEGER,
  `duration_ms` INTEGER,              -- 响应耗时
  `request_body` TEXT,                -- JSON（可选，大 body 截断）
  `response_body` TEXT,               -- JSON（可选，大 body 截断）
  `created_at` TEXT DEFAULT (datetime('now'))
);
```

### 5.2 Mock 表（BaseModel 管理，AI 动态创建）

**表名两层映射**：
- AI 生成代码中写：`new BaseModel('mock__order')` — AI 只关心逻辑名
- 实际数据库中为：`mock__1_order` — BaseModel 构造函数自动注入当前用户 userId 前缀
- 如果模块有多个实体：`mock__1_order_item`（userId + 模块名 + 实体名）

这样 AI 不需要知道 userId，用户隔离完全在基础设施层完成。

所有标识符用反引号包裹，BaseModel 内置 camelCase ↔ snake_case 自动转换。

---

## 六、前端功能设计

### 6.1 页面结构与导航

```
┌──────────────────────────────────────────────────────────────┐
│  Header: Logo | 当前 Provider/Model 选择下拉 | 用户头像/退出  │
├──────────┬───────────────────────────────────────────────────┤
│          │                                                   │
│  侧边栏   │              主内容区                              │
│          │                                                   │
│ ┌──────┐ │  ChatPage          对话 + 生成（默认首页）          │
│ │新建  │ │  ModulesPage       模块列表                        │
│ │对话  │ │  ModuleDetailPage  单模块详情                      │
│ ├──────┤ │  SettingsPage      Provider 配置                   │
│ │对话1 │ │  AdminPage         用户管理（仅 admin）             │
│ │对话2 │ │                                                   │
│ │对话3 │ │                                                   │
│ ├──────┤ │                                                   │
│ │ 模块 │ │                                                   │
│ │ 设置 │ │                                                   │
│ │ 管理 │ │                                                   │
│ └──────┘ │                                                   │
└──────────┴───────────────────────────────────────────────────┘
```

**路由设计**：
- `/` → 重定向到 `/chat`（默认首页是对话页）
- `/login` → 登录/注册页
- `/chat` → 对话页（左侧会话列表 + 右侧对话区）
- `/chat/:sessionId` → 指定会话
- `/modules` → 模块列表
- `/modules/:name` → 模块详情
- `/settings` → Provider 配置
- `/admin` → 管理员面板（仅 admin）

**首次使用引导**：
1. 注册 → 登录 → 自动跳转 `/chat`
2. 检查用户是否有可用的 Provider（自己的 + public 的）：
   - 有可用 Provider → 直接进入对话，Header 下拉默认选中第一个
   - 没有任何可用 Provider → 对话区显示引导卡片："配置你的 AI 服务以开始使用" + 简短说明（"填入你的 API Key，支持 OpenAI、Claude、国产大模型等"）+ [去配置] 按钮
3. 在 SettingsPage 保存 Provider 成功后 → toast 提示"保存成功" + 显示 [去对话] 按钮（或 3 秒后自动跳转回 /chat）

**Toast 通知**：使用 shadcn-vue 的 `toast` 组件（基于 `vue-sonner`，需单独安装），在 App.vue 中添加 `<Toaster />` 组件，通过 `import { toast } from 'vue-sonner'` 调用。用于成功/失败/警告提示。

**响应式布局**：
- 桌面（≥1024px）：侧边栏固定显示 + 主内容区
- 平板/小屏（<1024px）：侧边栏默认收起为图标，点击展开为 drawer 覆盖层
- 对话页在小屏下侧边栏会话列表为抽屉式

**暗黑模式**：
- 使用 Tailwind CSS 的 `dark:` 前缀 + shadcn-vue 内置暗黑主题
- 在 AppHeader 添加主题切换按钮（亮/暗/跟随系统）
- 主题偏好存 localStorage，刷新保持

**全局加载状态**：
- 各页面首次加载数据时显示 Skeleton 占位（模块列表卡片骨架屏、会话列表骨架条、DataTable 已有）
- API 请求中按钮显示 loading spinner，防止重复提交

**ChatPage 侧边栏**：
- 顶部 [+ 新建对话] 按钮
- 会话列表（按 updated_at 倒序），每项显示标题 + 时间
- 当前会话高亮
- hover 显示操作按钮（重命名、删除）
  - 重命名：点击后标题变为内联 Input，blur 或 Enter 保存（PUT /api/sessions/:id）
  - 删除：ConfirmDialog 确认后删除 → 如果是当前会话，自动切到最近的另一个会话；如果无会话了，显示空状态
- 底部固定导航：模块、设置、管理

**对话输入框交互**：
- Enter 发送消息，Shift+Enter 换行（和主流 AI 产品一致）
- 输入框为空时发送按钮 disabled
- 输入框自适应高度（随内容增长，最大 200px 后出滚动条）
- Ctrl+V 粘贴图片时自动触发上传

**长对话 token 限制**：
- Vercel AI SDK 的 `streamText` 会自动将 messages 发送给模型，如果超出 context window，模型会报错
- 处理策略：agent-runner 捕获 context length 相关错误 → 返回友好提示"对话过长，建议新建对话继续"
- 前端显示提示 + [新建对话] 按钮，新对话中 AI 可以通过 read_file _context.md 恢复模块上下文

### 6.2 模块详情页（ModuleDetailPage）— 最多 6 个 Tab（Phase 5 新增 Tab 5/6）

Tab 栏带图标使识别更直观：接口列表（ListIcon）/ 测试器（FlaskIcon）/ 数据管理（TableIcon）/ 文档（FileTextIcon）/ 设置（SettingsIcon）/ 日志（ScrollIcon）。图标用 `lucide-vue-next`（shadcn-vue 已内置）。

**Tab 1: 接口列表 + 快速测试**
- 顶部：模块状态徽标 + 测试结果摘要（如"5/5 通过"）+ [运行全部测试] 按钮
- [运行全部测试]：调用后端 `POST /api/modules/:name/test`，后端执行 run_test → 返回结果 → 更新 _meta.json testResults → 刷新页面展示
- 每个端点一行：方法徽标（GET 绿 / POST 蓝 / PUT 橙 / DELETE 红）+ 路径 + 说明 + 测试状态（通过/失败/未测试）
- 点击端点行展开"快速测试"面板：预填示例参数（从 _meta.json fields 推导）、[发送] 按钮、响应区（状态码 + JSON 高亮 + 耗时）
- 一键复制 cURL 命令

**Tab 2: 接口测试器（ApiTester）**（与 Tab 1 的区别：Tab 1 是快速一键测试已有端点，Tab 2 是自由组装任意请求，适合调试自定义参数和边界场景）

```
┌──────────────────────────────────────────────────────┐
│ [GET ▾]  [/mock/order/:id          ]    [发送]       │
├──────────────────────────────────────────────────────┤
│ Params │ Headers │ Body(JSON)                         │
│ ┌─────────────────────────────────────────────┐      │
│ │ {                                           │      │
│ │   "status": "paid"                          │      │
│ │ }                                           │      │
│ └─────────────────────────────────────────────┘      │
├──────────────────────────────────────────────────────┤
│ 状态: 200 OK    耗时: 12ms    大小: 256B             │
│ ┌─────────────────────────────────────────────┐      │
│ │ {                                           │      │
│ │   "success": true,                          │      │
│ │   "data": { ... }                           │      │
│ │ }                                           │      │
│ └─────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────┘
```

- 方法下拉：GET / POST / PUT / DELETE / PATCH
- URL 输入：支持路径参数高亮（`:id` 部分变色）
- 请求体：JSON 编辑器（带语法高亮，可从 _meta.json 自动生成示例 body）
- 响应区：状态码（带颜色）+ 耗时 + 响应体大小 + JSON 高亮 + 一键复制
- 请求通过服务端代理转发（POST /api/test/request），避免 CORS

**Tab 3: 数据管理（DataTable）**

详见 6.3 节。

**Tab 4: 文档**
- 渲染 api-doc.md（完整接口文档）
- 下载按钮：[下载 Markdown] [下载 OpenAPI JSON]

**Tab 5: 设置**（Phase 5 Step 19 新增）
- 延迟模拟：min/max 毫秒输入
- 异常模拟：errorRate 滑块 0-1
- 保存后更新 _meta.json config

**Tab 6: 请求日志**（Phase 5 Step 20 新增）
- 最近 Mock 请求列表（时间/方法/路径/状态码/耗时）
- 点击展开查看请求体和响应体

### 6.3 数据管理详细设计

#### 6.3.1 表格布局

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [+ 新增]  [批量生成]  [清空]  [列设置]        筛选: [___________] 🔍   │
├──┬────┬──────────┬───────────┬─────────┬────────────┬──────────────┬───┤
│☐ │ ID │ 订单号    │ 状态      │ 金额    │ 创建时间    │ 操作         │   │
│  │    │ ▲ 筛选    │ ▲ 筛选    │ ▲ 筛选  │ ▲ 筛选      │              │   │
├──┼────┼──────────┼───────────┼─────────┼────────────┼──────────────┤   │
│☐ │ 1  │ ORD-001  │ pending   │  99.90  │ 2024-01-01 │ [···]        │   │
│☐ │ 2  │ ORD-002  │ paid      │ 188.00  │ 2024-01-02 │ [···]        │   │
│☐ │ 3  │ ORD-003  │ 这是一... │  52.30  │ 2024-01-03 │ [···]        │   │
├──┴────┴──────────┴───────────┴─────────┴────────────┴──────────────┤   │
│ 共 156 条                  [批量删除(2)]         « 1  2  3  4  5 » │   │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 6.3.2 Cell 展示模式

- **固定列宽**：按字段类型预设——string 180px、number 100px、enum 120px、date 160px、boolean 80px、ID 60px。可拖拽列头右边缘调整，宽度存入 localStorage
- **文本溢出**：`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`
- **Tooltip**：鼠标悬浮 300ms 后显示完整内容（shadcn-vue Tooltip，`delayDuration={300}`）。仅在内容确实被截断时显示（`el.scrollWidth > el.clientWidth` 判断）

#### 6.3.3 Cell 编辑模式——按字段类型映射表单元素

点击 Cell → 原地变为对应表单元素（回显当前值）：

| 字段类型 | 展示态 | 编辑态表单元素 | 说明 |
|---------|--------|-------------|------|
| string | 文本 | `<Input>` | 单行输入框 |
| number / decimal | 数字 | `<Input type="number">` | 数字输入框，step 根据 decimal 精度设置 |
| enum | 枚举值 | `<Select>` | 下拉选择，选项从 `_meta.json` 的 `enumValues` 读取 |
| boolean | true/false | `<Switch>` | 开关切换，点击即保存 |
| date | 日期字符串 | `<DatePicker>` | 日期选择器（shadcn-vue） |
| text（长文本） | 截断文本 | `<Textarea>` | 弹出 Popover 编辑（避免撑开行高） |

**ID / created_at / updated_at 列不可编辑**（只读灰底）。

#### 6.3.4 无抖动切换

展示态和编辑态占据完全相同的盒子尺寸，切换无布局跳动：

```
实现方式：
1. Cell 容器固定 height（36px）+ padding（0 8px），展示态和编辑态共用
2. 表单元素 width: 100%，去掉默认 border/padding 差异
   → Input: border: none, background: white, outline on focus（ring-2 ring-primary）
   → Select: trigger 区域与 Cell 同尺寸
3. 展示态 <span> 和编辑态 <Input> 用 v-if 切换，两者在同一个定高容器内
4. 编辑态出现时自动 focus + 全选文本（input.select()）
```

#### 6.3.5 编辑保存机制

```
点击 Cell → 进入编辑态（回显当前值）
  │
  ├─ 失焦（blur）或 Enter → 保存
  │   ├─ 值未变 → 直接退出编辑态，不发请求
  │   ├─ 值已变 → PUT /api/data/:module/:id { field: newValue }
  │   │   ├─ 成功 → Cell 更新，绿色背景闪烁 0.3s（保存反馈）
  │   │   └─ 失败 → 回退旧值，toast 错误提示
  │
  ├─ Esc → 放弃修改，恢复原值，退出编辑态
  ├─ Tab → 保存当前 Cell，跳到右边下一个可编辑 Cell（Excel 式连续编辑）
  └─ Enter → 保存当前 Cell，跳到下方同列 Cell
```

#### 6.3.6 新增行

```
点击 [+ 新增] → 表格底部插入一行空行，所有 Cell 进入编辑态
  ├─ 各字段根据类型显示空表单（enum 默认选第一个，boolean 默认 false）
  ├─ required 字段的 Cell 标红色边框
  │
  ├─ 填完后点 [保存] 或 Tab 到最后一个字段回车
  │   ├─ 校验 required → 不通过则红色提示
  │   ├─ 通过 → POST /api/data/:module → 成功后 ID 由服务端返回填入
  │   └─ 失败 → toast 提示
  │
  └─ 点击 [取消] 或 Esc → 移除空行
```

#### 6.3.7 批量操作

**批量删除**：
- 每行左侧 checkbox，表头 checkbox = 全选/取消
- 选中后底部工具栏显示 `[批量删除(N)]`
- 点击 → 二次确认 dialog → POST batch-delete → 刷新列表

**批量生成**：
```
点击 [批量生成] → 弹出 dialog：
┌──────────────────────────────────────┐
│ 生成数量：[50            ] 条         │
│                                      │
│ 字段规则（可选自定义）：                │
│ orderNo: [faker 默认  ▾]             │  ← 下拉：faker 默认 / 递增序号 / 固定值
│ status:  [随机枚举    ▾]             │
│ amount:  [faker 默认  ▾]             │
│                                      │
│              [取消]  [生成]           │
└──────────────────────────────────────┘
→ POST /api/data/:module/bulk-generate { count, rules }
→ 生成后自动刷新列表
```

**清空数据**：`[清空]` → 二次确认 → POST /api/data/:module/clear → 刷新

#### 6.3.8 扩展能力

| 能力 | 说明 |
|------|------|
| **列排序** | 点击列头排序（升序 ↑ / 降序 ↓ / 无），发送 `?orderBy=field+DESC` |
| **列筛选** | 列头下方筛选输入框：string 模糊搜索、enum 下拉多选、number 范围、date 日期范围 |
| **列宽拖拽** | 拖拽列头右边缘调整宽度，存入 localStorage |
| **列可见性** | 工具栏 [列设置] 按钮，勾选显示/隐藏列 |
| **行展开** | 点击行展开箭头，展开显示完整数据（JSON 格式），适合字段多的模块 |
| **单行操作** | 行尾 [···] 按钮 → 复制为 JSON / 复制为 cURL / 删除 |
| **快捷键** | Enter=保存并下移，Tab=保存并右移，Esc=取消，Ctrl+Z=撤销最近一次修改 |
| **操作状态栏** | 底部左侧显示"共 N 条"，修改时显示"已修改 M 条"，可查看最近修改历史 |
| **空状态** | 居中图标 + "暂无数据" + `[批量生成 20 条]` 快捷入口 |

#### 6.3.9 技术实现

使用 `@tanstack/vue-table` 提供表格核心能力。注意：tanstack table 是 **headless**（无 UI），只提供状态逻辑，所有 HTML/CSS 都需要自己写。

```
@tanstack/vue-table 负责（纯逻辑）：
├─ 列定义（根据 _meta.json fields 动态生成 columnDefs）
├─ 排序状态管理（getSortedRowModel）
├─ 分页状态管理（getPaginationRowModel）
├─ 行选择状态（getSelectedRowModel）
├─ 筛选状态管理（getFilteredRowModel）
└─ 核心行/单元格遍历 API

自己实现（所有 UI + 交互）：
├─ <table>/<thead>/<tbody> HTML 结构 + Tailwind 样式
├─ Cell 展示/编辑态切换（EditableCell.vue）
├─ 按 field.type 映射表单组件
├─ 无抖动 CSS + tooltip
├─ 筛选 UI（列头 filter input/select）
├─ 批量生成 dialog
└─ 工具栏 + 操作状态栏
```

**列定义动态生成**：
```typescript
function buildColumns(fields: Field[]): ColumnDef[] {
  return [
    { id: 'select', size: 40, cell: CheckboxCell },
    { accessorKey: 'id', header: 'ID', size: 60, enableEditing: false },
    ...fields.map(f => ({
      accessorKey: f.name,
      header: f.displayName,
      size: getWidthByType(f.type),
      meta: { fieldType: f.type, enumValues: f.enumValues, required: f.required },
    })),
    { accessorKey: 'createdAt', header: '创建时间', size: 160, enableEditing: false },
    { id: 'actions', size: 60, cell: ActionCell },
  ];
}
```

#### 6.3.10 视觉规范

| 元素 | 设计 |
|------|------|
| 表格 | 白底，细线分隔（border-border），hover 行高亮（bg-muted/50） |
| 编辑态 Cell | 蓝色聚焦环（ring-2 ring-primary），白底 |
| 保存成功 | 绿色背景闪烁 0.3s（bg-green-50 → transparent，transition） |
| 校验失败 | 红色边框（ring-destructive）+ Cell 下方红色小字提示 |
| 必填标记 | 列头名称后红色 `*` |
| 分页 | 底部左侧"共 N 条"，右侧页码（shadcn-vue Pagination） |
| 空状态 | 居中 icon + "暂无数据" + [批量生成 20 条] 按钮 |
| 加载态 | 表格区域 Skeleton 占位（3 行 × 全列） |
| 只读列 | 灰色背景（bg-muted/30），cursor: default |

### 6.4 数据管理 API

```
GET    /api/data/:moduleName                  列出数据（分页 + 排序 + 筛选）
  Query: page, pageSize, orderBy, filter[field]=value
POST   /api/data/:moduleName                  新增一行
PUT    /api/data/:moduleName/:id              修改一行（支持部分字段更新）
DELETE /api/data/:moduleName/:id              删除一行
POST   /api/data/:moduleName/batch-delete     批量删除（Body: { ids: [1,2,3] }，用 POST 避免 DELETE body 兼容问题）
POST   /api/data/:moduleName/clear            清空表（用 POST 避免与单行 DELETE 路径冲突）
POST   /api/data/:moduleName/bulk-generate    批量生成 faker 数据（Body: { count, rules? }）
```

### 6.5 完整 API 路由表

```
认证
  POST   /api/auth/register                   注册（Body: { username, password }）
  POST   /api/auth/login                      登录（→ { token, user }）

会话
  GET    /api/sessions                        当前用户的会话列表
  POST   /api/sessions                        创建会话（Body: { providerId, presetId?, moduleName? }）
  PUT    /api/sessions/:id                    更新会话（标题、provider、preset、module 等）
  DELETE /api/sessions/:id                    删除会话（级联删除消息）
  GET    /api/sessions/:id/messages           加载历史消息

对话
  POST   /api/chat                            AI 对话（SSE 流，Body: { sessionId, messages, attachments? }）

Provider
  GET    /api/providers                       当前用户可用的 Provider 列表（含 public）
  POST   /api/providers                       添加 Provider
  PUT    /api/providers/:id                   编辑 Provider
  DELETE /api/providers/:id                   删除 Provider
  POST   /api/providers/:id/verify            验证 Provider 连通性

项目预设
  GET    /api/presets                         当前用户可用的预设列表（自己的 + public）
  POST   /api/presets                         创建预设
  PUT    /api/presets/:id                     编辑预设
  DELETE /api/presets/:id                     删除预设

模块
  GET    /api/modules                         当前用户的模块列表
  GET    /api/modules/:name                   模块详情（含 _meta.json 完整内容）
  GET    /api/modules/:name/context           获取模块的 _context.md 原始内容
  GET    /api/modules/:name/api-doc           获取/下载模块的 api-doc.md
  POST   /api/modules/:name/test              手动运行测试（执行 run_test → 更新 testResults → 返回结果）
  DELETE /api/modules/:name                   删除模块（含文件和数据库表）

数据管理
  GET    /api/data/:moduleName                列出数据（Query: page, pageSize, orderBy, filter）
  POST   /api/data/:moduleName                新增一行
  PUT    /api/data/:moduleName/:id            修改一行（支持部分字段）
  DELETE /api/data/:moduleName/:id            删除一行
  POST   /api/data/:moduleName/batch-delete   批量删除（Body: { ids }）
  POST   /api/data/:moduleName/clear          清空表
  POST   /api/data/:moduleName/bulk-generate  批量生成（Body: { count, rules? }）

接口测试
  POST   /api/test/request                    代理转发（Body: { method, url, headers, body } → 返回完整响应）

文件上传
  POST   /api/upload                          上传文件（multipart → 解析 → 返回结果）

用户管理（仅 admin）
  GET    /api/users                           用户列表
  PUT    /api/users/:id                       更新用户状态（启用/禁用）
  PUT    /api/users/:id/reset-password        重置密码

健康检查
  GET    /api/health                          → { success: true, data: 'ok' }
```

> 以上所有 `/api/` 路由（除 health 和 auth）都需要 JWT 鉴权。admin 专用路由额外检查 `role === 'admin'`。

### 6.6 数据生成（faker 映射）

```typescript
// 1. 先按字段名智能匹配
name → faker.person.fullName()
email → faker.internet.email()
phone → faker.phone.number()
price → faker.number.float({ min: 1, max: 1000, fractionDigits: 2 })
avatar → faker.image.avatar()
title → faker.lorem.sentence()
address → faker.location.streetAddress()
...

// 2. 兜底按类型
string → faker.lorem.words(3)
number → faker.number.int({ min: 1, max: 1000 })
boolean → faker.datatype.boolean()
date → faker.date.recent().toISOString().split('T')[0]
enum → 从 enumValues 随机选
```

### 6.7 对话系统设计

#### 6.7.1 技术选型

使用 `@ai-sdk/vue` 的 `useChat` composable 作为对话数据层。它内置了 SSE 解析、消息状态管理、工具调用状态流转、abort 控制，不需要自己实现 SSE 解析。

#### 6.7.2 完整数据流

```
用户输入消息（可带附件）
  │
  ▼ ① 前端 useChat
  useChat({ api: '/api/chat', headers: { Authorization }, body: { sessionId, attachments } })
  → POST /api/chat { sessionId, messages, attachments }（useChat 自动管理 messages，sessionId 和 attachments 通过 body 参数扩展）
  │
  ▼ ② 后端 api/chat.ts
  ├─ JWT 验证 → 获取 userId
  ├─ 根据 sessionId 查 session → 获取 providerId + model
  ├─ 根据 providerId 解密 API Key → 构建 AI model 实例
  ├─ 处理附件：图片 → 多模态 content，文档 → 文本拼入消息
  │
  ▼ ③ agent-runner.ts
  // 构建 System Prompt（4 层拼接）
  const moduleList = await listUserModules(userId);
  const preset = session.preset_id ? await getPreset(session.preset_id) : null;
  const moduleContext = session.module_name ? await readModuleContext(userId, session.module_name) : null;
  streamText({
    model,
    system: buildSystemPrompt({
      userId,
      moduleList,         // [3] 已有模块列表
      preset,             // [2] 项目预设（覆盖默认响应格式/字段风格等）
      moduleContext,      // [4] 选中模块的 _context.md 内容
    }),
    // 拼接顺序：[1]基础骨架 → [2]预设 → [3]模块列表 → [4]模块上下文
    messages,
    tools: buildTools(userId),   // 工具内部限制只能操作 generated/{userId}/
    maxSteps: 10,                // Agent Loop 由 SDK 自动驱动
  })
  │
  ▼ ④ SDK 自动驱动 Agent Loop（SSE 实时推送到前端）
  AI 输出文本        → SSE: text-delta     → useChat 自动追加到 messages
  AI 调用工具        → SSE: tool-call      → ToolStatus 组件显示"执行中"
  服务端执行工具     → SSE: tool-result    → ToolStatus 组件显示结果
  ...重复直到 AI 不再调用工具或达到 maxSteps...
  AI 输出最终文本    → SSE: text-delta
  │
  ▼ ⑤ 流完成后持久化（不阻塞流输出）
  保存 user message + assistant message（含 tool_calls JSON）到 messages 表
  更新 session.updated_at
```

#### 6.7.3 会话管理（Pinia chat store）

`useChat` 管理单个会话的消息流。Pinia store 管理多会话的切换和缓存：

```
chat store 职责：
├─ sessions: Ref<Session[]>          会话列表
├─ activeSessionId: Ref<string>      当前会话
├─ messageCache: Map<id, Message[]>  消息内存缓存
├─ loadSessions()                    从 DB 拉会话列表
├─ switchSession(id)                 切换会话（保存当前 → 恢复目标）
├─ createSession(providerId)         新建会话（关联用户选择的 Provider）
└─ deleteSession(id)                 删除会话 + 清理缓存
```

**消息数据来源优先级**：
1. `useChat` 内存（当前会话，实时）
2. `messageCache` Map（已访问过的会话）
3. DB 查询（首次打开 / 刷新页面）

#### 6.7.4 消息持久化策略

```
用户消息          → 收到请求时立即保存（防止流中断丢失）
流式输出中        → 不存 assistant 消息（频繁写 DB 无意义）
Agent Loop 中间步  → 不存（中间状态不完整）
整个响应完成       → 一次性写入完整的 assistant 消息（含所有 tool_calls）
```

后端使用 `streamText` 的 `onFinish` 回调持久化：

```typescript
const result = streamText({
  model, system, messages, tools, maxSteps,
  onFinish: async ({ responseMessages }) => {
    // 持久化 assistant 消息（含所有 tool calls）
    for (const msg of responseMessages) {
      await db.insert(messages).values({
        sessionId,
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        toolCalls: msg.toolInvocations ? JSON.stringify(msg.toolInvocations) : null,
      });
    }
  }
});
return result.toUIMessageStreamResponse();
```

**历史消息加载时的格式转换**：
- DB 存储：`{ role, content, tool_calls: JSON string, attachments: JSON string }`
- `useChat` 需要：`{ role, content, toolInvocations: object[] }`
- `GET /api/sessions/:id/messages` 返回时，后端将 `tool_calls` JSON 解析为 `toolInvocations` 数组
- `setMessages()` 接收的格式和 `useChat` 内部一致，无需前端额外转换

#### 6.7.5 对话 UI 功能

- **Markdown 渲染 + 代码高亮**：markdown-it + @shikijs/markdown-it。注意 shiki highlighter 初始化是异步的（`await createHighlighter({ themes, langs })`），需在 app 初始化时预加载，或在组件 onMounted 中惰性初始化后缓存到全局
- **工具状态卡片（ToolStatus.vue）**：
  - 默认折叠为单行摘要，点击展开查看参数和结果
  - 工具名友好映射：`write_file` → "📄 写入 order/_meta.json"、`run_test` → "🧪 运行测试"、`manage_data` → "📊 生成 20 条数据"
  - 执行中状态：显示 spinner + "执行中..."
  - 执行完成：write_file → "✅ 已写入"、run_test → "✅ 5/5 通过"或"❌ 3/5 通过（2 个失败）"
  - 展开后显示：工具参数（JSON 格式化）+ 执行结果（JSON 或精简文本）
  - 多个工具调用连续出现时，同类工具（如连续 5 个 write_file）自动分组折叠为 "📄 写入了 5 个文件" 一行，展开后显示每个文件
  - `useChat` 自动维护 `toolInvocations` 的 `state`（call → result）
- **自动滚动**：消息变化时自动滚底，用户主动上滚时暂停（距底部 > 100px 判定为主动上滚）
- **复制按钮**：代码块右上角一键复制
- **停止生成**：`useChat.stop()` 内部调用 `AbortController.abort()`
- **生成中状态约束**：isLoading=true 时——输入框 disabled、侧边栏切换会话前先 stop()、禁止删除当前会话
- **重新生成**：删除最后一条 assistant 消息，重新 submit 最后一条 user 消息
- **会话标题自动生成**：首条消息发送后，截取内容前 20 字作为标题
- **网络错误处理**：SSE 流中断时显示错误提示 + [重试] 按钮；fetch 失败时 toast "网络连接失败，请检查网络"
- **空状态**：无会话时左侧显示"开始你的第一次对话"引导；有会话但未选中时右侧显示 Logo + 提示文字
- **对话顶部选择器**：
  - 📂 项目预设下拉（可选，不选用默认骨架）：列表来自 `GET /api/presets`（自己的 + public）。选择后更新 session.preset_id。AI 的 System Prompt 自动注入预设配置（响应格式、字段风格、自定义提示词等）
  - 📦 模块下拉（可选，不选 AI 自行判断）：列表来自 `GET /api/modules`。选择后更新 session.module_name。AI 自动加载该模块 _context.md，修改操作锁定在此模块
  - 切换预设/模块时更新 session（PUT /api/sessions/:id）。正在生成中则先 stop
- **API 文档下载按钮**：AI 输出文本中包含 `[download:模块名/api-doc.md]` 标记，MessageBubble 用正则 `/\[download:([^\]]+)\]/g` 匹配并替换为可点击的下载按钮组件（"📄 下载 API 文档"），点击调 `GET /api/modules/:name/api-doc`
- **附件预览**：输入框下方显示已上传附件卡片（图片缩略图 / 文件图标），可删除
- **模块列表联动**：对话完成后，如果工具调用中包含 write_file(_meta.json) 或 delete_module，自动触发 `stores/modules.ts` 的列表刷新，用户切到模块页时无需手动刷新
- **模块快捷跳转**：AI 输出中提到模块名时（如"订单管理接口生成完成"），ToolStatus 组件中 write_file(_meta.json) 的结果区域显示 [查看模块详情] 链接，点击跳转到 `/modules/:name`
- **Provider 切换**：Header 的 Provider/Model 选择更新当前 session 的 provider_id 和 model。切换后的下一条消息才用新 Provider，已发送的消息不受影响。切换时如果正在生成中，需要先停止生成再切换

#### 6.7.6 多用户并发

每个 `POST /api/chat` 是独立的 HTTP 连接，`streamText` 各自独立运行，无共享状态：

| 层 | 隔离方式 |
|---|---------|
| AI 对话 | 每次请求独立的 `streamText` 调用 |
| 工具执行 | `buildTools(userId)` 注入 userId，限制文件/数据库访问范围 |
| 消息存储 | `session.user_id` 关联 |
| 文件系统 | `generated/{userId}/` + `uploads/{userId}/` 目录隔离 |
| Mock 表 | `mock__{userId}_{module}_{entity}` 表名隔离 |

### 6.8 项目预设（Preset）设计

项目预设让用户预先配置公司/项目的接口规范，对话时选择一个即可，不用每次重复描述。

**预设 content 字段（JSON 结构）**：
```jsonc
{
  // 响应格式（覆盖默认的 { success, data, message }）
  "responseFormat": {
    "success": "{ code: 0, data, msg }",
    "error": "{ code: number, msg: string }",
    "paginated": "{ code: 0, data: { list, total, pageNum, pageSize } }"
  },
  // 字段命名风格：camelCase | snake_case | 保持文档原样
  "fieldNaming": "snake_case",
  // 分页参数命名
  "pagination": {
    "pageParam": "pageNum",
    "sizeParam": "pageSize"
  },
  // 自定义提示词（自由文本，追加到 System Prompt 末尾）
  "customPrompt": "所有接口都需要在 header 中传入 X-Token。日期字段用时间戳（ms）。枚举值用数字。"
}
```

**配置页面（SettingsPage 新增"项目预设" Tab）**：
```
┌─────────────────────────────────────────────────────┐
│ 编辑项目预设                                         │
├─────────────────────────────────────────────────────┤
│ 名称：[公司标准接口规范              ]               │
│ 描述：[统一的接口响应格式和字段命名规范]               │
│                                                     │
│ ── 响应格式 ──                                      │
│ 成功：[{ code: 0, data, msg }           ]           │
│ 错误：[{ code: number, msg: string }    ]           │
│ 分页：[{ code: 0, data: { list, total } }]          │
│                                                     │
│ ── 字段规范 ──                                      │
│ 命名风格：[snake_case ▾]                            │
│ 分页页码参数：[pageNum    ]                          │
│ 分页大小参数：[pageSize   ]                          │
│                                                     │
│ ── 自定义提示词 ──                                   │
│ ┌─────────────────────────────────────────────┐     │
│ │ 所有接口需要 header 传入 X-Token。           │     │
│ │ 日期字段用时间戳（ms）。                      │     │
│ │ 枚举值用数字（如 status: 1=待处理）。         │     │
│ └─────────────────────────────────────────────┘     │
│                                                     │
│ ☐ 公开给所有用户                                    │
│                                                     │
│              [取消]  [保存]                          │
└─────────────────────────────────────────────────────┘
```

**预设注入 System Prompt 的方式**：
- 预设的 `responseFormat` → 覆盖骨架中"统一响应格式"部分
- 预设的 `fieldNaming` → 覆盖骨架中"字段名用 camelCase"的默认规则
- 预设的 `pagination` → 覆盖骨架中 controller.ts list 函数的参数名
- 预设的 `customPrompt` → 追加到 System Prompt 末尾（在所有规则之后）
- AI 生成的 api-doc.md 中的响应示例也按预设格式

**scope 规则**（与 Provider 一致）：
- `private`：仅创建者可用
- `public`：所有用户可选用
- 管理员可管理所有预设

**删除保护**（与 Provider 一致）：
- 删除预设前检查是否有关联的 session（session.preset_id）
- 如果有：提示"此预设被 N 个会话使用，删除后这些会话将回退到默认骨架。确认删除？"
- 删除后，关联 session 的 preset_id 置为 null

---

## 七、认证与多用户

### 7.1 用户体系

- 初始化创建管理员（用户名/密码从 .env ADMIN_USERNAME/ADMIN_PASSWORD 读取）
- 注册控制：.env ALLOW_REGISTRATION=true/false，关闭后只有管理员能创建用户
- 注册校验：用户名 3-20 字符（字母数字下划线），密码 6 位以上
- JWT 登录：jose 签发，过期时间从 .env JWT_EXPIRES_IN 读取（默认 7d）
- 密码存储：bcryptjs.hash(password, 10) 哈希存储，不可逆

### 7.2 Provider / API Key 管理

**scope 设计**：
- `private`（默认）：仅创建者自己可用
- `public`：所有用户都可以选择使用
- 只有验证通过（`is_verified = 1`）的 Provider 才能设为 public
- 创建/编辑 Provider 时，公开开关在未验证状态下 disabled + tooltip 提示"请先验证连接"
- 管理员可以将任意已验证的 Provider 设为 public 或 private

**Provider 类型**：

| type 值 | 说明 | base_url | 示例 |
|---------|------|----------|------|
| `anthropic` | Anthropic 官方 | 预填 `https://api.anthropic.com`，可改 | Claude 系列 |
| `openai` | OpenAI 官方 | 预填 `https://api.openai.com/v1`，可改 | GPT 系列 |
| `google` | Google AI | 预填 `https://generativelanguage.googleapis.com`，可改 | Gemini 系列 |
| `openai-compatible` | 兼容 OpenAI 协议的第三方 | 必填 | DeepSeek、Qwen、GLM、Moonshot 等 |
| `custom` | 完全自定义 | 必填 | 任意第三方转发服务 |

- 选择预设提供商（anthropic/openai/google）时，base_url 自动填入官方地址，用户仍可修改（适配代理/镜像地址）
- 选择 openai-compatible 或 custom 时，base_url 为空需用户手动填入
- 底层实现：
  - anthropic → `import { anthropic } from '@ai-sdk/anthropic'`
  - openai → `import { openai } from '@ai-sdk/openai'`
  - google → `import { google } from '@ai-sdk/google'`
  - openai-compatible / custom → `import { createOpenAI } from '@ai-sdk/openai'; const provider = createOpenAI({ baseURL, apiKey })`

**配置表单**：

```
┌──────────────────────────────────────────────┐
│ 添加 AI Provider                              │
├──────────────────────────────────────────────┤
│ 显示名称：[我的 Claude                  ]     │
│                                              │
│ 提供商：  [Anthropic     ▾]                  │
│           Anthropic                          │
│           OpenAI                             │
│           Google                             │
│           OpenAI 兼容（第三方）               │
│           自定义                              │
│                                              │
│ Base URL：[https://api.anthropic.com    ]     │  ← 预设提供商自动填入，可修改
│                                              │
│ API Key： [sk-••••••••••••              ]     │  ← 密码模式，已保存的显示脱敏
│                                              │
│ 默认模型：[claude-sonnet-4-5-20250929   ]     │  ← 手动输入模型 ID
│                                              │
│ ☐ 公开给所有用户（需验证通过后才可开启）         │  ← 未验证时 disabled + tooltip
│                                              │
│         [验证连接]   [取消]   [保存]           │
└──────────────────────────────────────────────┘
```

**验证流程**：
1. 点击 [验证连接] → 用当前 API Key + Base URL + Model 发送一个简单的测试请求
2. 成功 → 绿色提示"连接成功"，`is_verified = 1`
3. 失败 → 红色提示具体错误（如"API Key 无效"、"模型不存在"、"连接超时"）
4. 未验证的 Provider 也可以保存，但标记为"未验证"警告，且无法设为公开

**删除保护**：
- 删除 Provider 前检查是否有关联的 session
- 如果有：提示"此 Provider 被 N 个会话使用，删除后这些会话将无法继续对话。确认删除？"
- 删除后，关联 session 的 provider_id 置为 null，用户进入这些会话时提示"请重新选择 Provider"

**用户看到的 Provider 列表**：
- 自己创建的所有 Provider（不论 scope）
- 其他用户设为 `public` 的 Provider（只读，不能编辑/删除，但可以使用）
- 管理员能看到并管理所有 Provider

### 7.3 数据按用户隔离

- 生成的文件：`generated/{userId}/{moduleName}/`
- 上传的文件：`uploads/{userId}/`
- Mock 表名：`mock__{userId}_{moduleName}_{entityName}`
- 会话和模块按 `user_id` 查询
- 管理员可查看所有

---

## 八、扩展功能

### 8.1 延迟模拟

在 `_meta.json` 的 `config.delay` 配置 `{ min: 200, max: 1000 }`（毫秒），mock-router 在返回响应前执行 `await sleep(randomInt(min, max))`。前端模块详情页可通过 UI 修改此配置（两个数字输入框 + 保存按钮），保存后更新 _meta.json。设置为 `{ min: 0, max: 0 }` 时无延迟。

### 8.2 异常模拟

在 `_meta.json` 的 `config.errorRate` 配置 0-1 之间的数值（如 0.1 = 10% 概率）。mock-router 在处理请求前执行 `if (Math.random() < errorRate) return reply.status(500).send({ success: false, message: 'Mock 异常模拟' })`。前端通过滑块组件调整。用于测试前端的错误处理和 loading 状态。

### 8.3 请求日志

mock-router 中间件记录每个 Mock 请求到 `mock_requests` 表：时间、方法、路径、状态码、响应耗时（ms）、请求体（截断 2KB）、响应体（截断 2KB）。模块详情页新增"日志" Tab（Step 20），表格展示 + 点击展开详情 + 按方法/状态码筛选。支持自动清理：保留最近 1000 条记录，超出时删除最旧的。

### 8.4 导入/导出

- 导出模块为 JSON（含 _meta + schema + controller + test + _context + api-doc）
- 导入模块 JSON
- 导出 OpenAPI 3.0 JSON（从 _meta 生成）
- 导入 OpenAPI/Swagger → 生成模块

**与对话上传的区分**：
- **对话上传**（4.8 节）：用户在对话框上传任意文件（需求文档/截图等），AI 理解内容后生成模块。入口是对话，AI 参与理解和决策。
- **导入功能**（本节）：用户在模块管理页直接导入结构化文件（MockForge JSON / OpenAPI），系统直接解析创建模块，不经过 AI。入口是模块管理页的导入按钮。

### 8.5 接口快照/版本（未来）

保存接口某个时刻的状态，可回滚。

### 8.6 WebSocket Mock（未来）

### 8.7 团队协作（未来）

模块级共享/权限控制。

---

## 九、编码规范

### 9.1 通用

- TypeScript strict 模式
- 缩进：2 空格
- 引号：单引号
- 分号：有
- 行尾：LF
- 编码：UTF-8

### 9.2 命名

| 类型 | 风格 | 示例 |
|------|------|------|
| 文件/目录 | kebab-case | `base-model.ts`, `use-api.ts` |
| Vue 组件文件 | PascalCase | `ChatInput.vue`, `DataTable.vue` |
| 变量/函数 | camelCase | `getModuleList`, `sessionId` |
| 类 | PascalCase | `BaseModel` |
| 常量 | UPPER_SNAKE_CASE | `MAX_STEPS`, `DEFAULT_PORT` |
| 类型/接口 | PascalCase | `ModuleMeta`, `ProviderConfig` |
| 数据库系统表 | snake_case | `users`, `providers` |
| 数据库 Mock 表 | mock__ 前缀 | `mock__1_order_order` |
| API 路由 | kebab-case | `/api/bulk-generate` |

### 9.3 Vue 组件

- `<script setup lang="ts">` + Composition API
- Props: `defineProps<{}>()` 泛型
- 组件名与文件名一致
- 超过 200 行考虑拆分

### 9.4 后端

- Fastify async handler
- 错误：`error(code, message)`
- 成功：`success(data, message?)`
- 分页：`paginated(list, total, page, pageSize)`
- Mock 数据操作走 BaseModel

---

## 十、环境与配置

### 10.1 环境变量（.env.example）

```bash
# 服务器
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# 数据库
DB_PATH=./data/mockforge.db

# JWT
JWT_SECRET=your-jwt-secret-change-this
JWT_EXPIRES_IN=7d

# 加密（API Key 存储）
ENCRYPTION_KEY=your-32-char-encryption-key-here  # 必须 32 字符，可用 node -e "console.log(require('crypto').randomBytes(16).toString('hex'))" 生成

# 管理员初始化
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123

# 注册控制
ALLOW_REGISTRATION=true

# 文件上传
UPLOAD_DIR=./uploads
UPLOAD_MAX_SIZE=10485760          # 10MB
UPLOAD_CLEANUP_HOURS=24

# AI 默认配置（可选，用户也可在页面配置）
# 测试时可直接使用以下豆包大模型配置
DEFAULT_AI_PROVIDER=openai
DEFAULT_AI_MODEL=doubao-seed-2-0-pro-260215
DEFAULT_AI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DEFAULT_AI_API_KEY=2d544923-f877-4c8b-8add-84b93cc56c35
```

### 10.2 Vite 开发配置

```typescript
// vite.config.ts — 开发环境代理配置
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:3000',     // 系统 API
      '/mock': 'http://localhost:3000',    // Mock 接口
      '/uploads': 'http://localhost:3000', // 上传文件静态服务
    }
  },
  // ...
});
```

开发时前端 Vite dev server 运行在 5173 端口，后端 Fastify 运行在 3000 端口。Vite 代理 `/api`、`/mock`、`/uploads` 到后端。

**开发启动命令**：
```bash
# package.json scripts
"dev": "concurrently \"pnpm dev:server\" \"pnpm dev:client\"",
"dev:server": "tsx watch src/server/server.ts",
"dev:client": "vite",
"build": "vite build && tsc -p tsconfig.server.json",
"start": "node dist/server/server.js"
```
需安装 `concurrently` 作为 devDependency，同时启动前后端。`tsx` 作为后端开发运行时（支持 TS 动态 import）。

生产环境 Fastify 直接 serve 前端构建产物（`dist/client/`），不需要 Vite。

### 10.3 全局错误处理

```typescript
// app.ts 中注册
app.setErrorHandler((error, request, reply) => {
  // 1. Zod 校验错误 → 400
  // 2. JWT 过期/无效 → 401
  // 3. 权限不足 → 403
  // 4. 资源不存在 → 404
  // 5. AI 调用失败（API Key 过期/余额不足/模型不可用）→ 502 + 友好提示
  // 6. 其他未知错误 → 500 + 日志记录
  // 统一返回 { success: false, message: '...' }
});

// AI 调用特定错误处理（agent-runner.ts 中）
// - API Key 无效 → 提示用户检查 Provider 配置
// - 余额不足 → 提示用户充值
// - 模型不可用 → 提示用户切换模型
// - 网络超时 → 提示用户重试
// - 流中断 → 前端 useChat 的 error ref 自动捕获，显示错误提示 + 重试按钮
```

### 10.4 日志

使用 Fastify 内置的 pino 日志：
- 开发环境：`pino-pretty` 格式化输出
- 生产环境：JSON 格式，按日期轮转
- Mock 请求日志：单独记录到 `mock_requests` 表（用于 8.3 节请求日志功能）

### 10.5 进度追踪与上下文恢复机制

项目使用五个文件协同追踪实现进度，确保 AI 在上下文超限切换窗口后能完整恢复工作状态：

| 文件 | 用途 | 生命周期 | 大小 | 更新频率 |
|------|------|---------|------|---------|
| `PLAN.md` | 完整设计（只读参考） | 永久 | 大 | 仅在方案变更时更新 |
| `PROGRESS.md` | 已完成归档 + 关键决策 + 踩坑 | 永久（Phase 完成后归档） | 中等 | 每完成一个 Step 追加 |
| `CURSOR.md` | **实时执行游标**（当前在哪、下一步做什么） | 永久（不断覆写） | **极小（20-30行）** | 每个 Task 开始/完成时覆写 |
| `STEP-N-PLAN.md` | 当前 Step 的聚焦实施子计划 | Step 完成后删除 | 中等（3000-8000字） | Step 开始时生成 |
| `PROMPT.md` | 新窗口启动提示词（固定） | 永久 | 小 | 基本不变 |

**创建时机**：PROGRESS.md、CURSOR.md、PROMPT.md 均在 Step 1（项目初始化）的第一个子任务中创建初始版本。不要在计划阶段创建，因为计划可能还会变。

**PROGRESS.md 完整结构**：

```markdown
# MockForge 实现进度

> 给 AI 的说明：先读 CURSOR.md 定位当前位置，再读 STEP-N-PLAN.md 获取实施上下文。仅在子计划不存在时才读本文件和 PLAN.md。

## 当前状态
> 实时执行位置见 CURSOR.md，以下为概要。
- 当前阶段：Phase N
- 当前步骤：Step X
- 阻塞问题：无 / 描述
- 上次更新：YYYY-MM-DD

## 当前代码状态摘要
（每次更新时刷新，新窗口 AI 据此快速了解项目现状）
- 已创建的关键文件：src/server/core/database.ts, base-model.ts, ...
- 已可用的 API：/api/health, /api/auth/login, ...
- 数据库状态：6 张系统表已创建，seed 数据已初始化
- 前端状态：基础路由 + 布局 + 登录页已完成
- 可运行的命令：pnpm dev 可启动

## 已完成
### Phase 1：项目基础 ✅ (详见 PROGRESS-PHASE-1.md)
关键上下文：...一行摘要...

### Step N: 标题 ✅ (日期)
- 做了什么（一句话）
- 关键决策：...（影响后续步骤的才记）
- 踩坑：...（后续可能再遇的才记）

## 进行中
### Step X: 标题
- [x] 子任务 1
- [ ] 子任务 2
- 问题记录：...

## 未开始
- Step Y ~ Step 23

## 计划变更记录
| 日期 | 变更内容 | 原因 | PLAN.md 对应位置 |
|------|---------|------|-----------------|

## 关键上下文（新窗口必读）
- 测试用 AI Provider 已预置到 providers 表（id=1）
- ...其他不能从代码推导出的关键信息...
```

**维护规则**：
- 每完成一个 Step：
  1. 从"进行中"移到"已完成"，写入简要描述 + 关键决策 + 踩坑
  2. 更新"当前代码状态摘要"（刷新已创建文件、已可用 API 等）
  3. 更新"当前状态"区域
- 遇到方案变更 → 同步更新 PLAN.md 和 PROGRESS.md 的"计划变更记录"（含变更位置）
- 已完成的 Step 只保留关键信息，不保留具体代码和调试过程（这些在 git history 里）
- Phase 全部完成后 → 归档到 `PROGRESS-PHASE-{N}.md`，PROGRESS.md 只留一行摘要 + 关键上下文

**三级拆分与 Task 执行机制**：

计划采用 Phase → Step → Task 三级结构：

| 层级 | 粒度 | 定义位置 | 说明 |
|------|------|---------|------|
| Phase | 项目阶段 | PLAN.md 固定 | Phase 1~5，不变 |
| Step | 功能模块 | PLAN.md 固定 | Step 1~23，作为目标和验收单元 |
| Task | 原子操作 | **实施时动态拆分，记录到 PROGRESS.md** | 每个 Task 涉及 1-3 个文件，可独立验证 |

**Task 拆分规则**：
- 开始一个 Step 前，先将其拆为 2-5 个 Task（如果 Step 本身很小，如 Step 2，可以不拆直接执行）
- 每个 Task 尽量只新建/修改 1 个核心文件
- 复杂组件先写骨架（空壳 + 路由 + props），再逐 Task 填充功能
- 同一功能先后端 API → 验证 → 再前端 UI
- 先核心功能跑通，再加排序/筛选/快捷键等增强

**Task 执行流程**（完整生命周期见第十二节「执行策略」）：
```
开始 Step N
  │
  ├─ ① 生成 STEP-N-PLAN.md（汇聚 PLAN.md 中所有相关上下文）
  ├─ ② 用户确认子计划
  ├─ ③ 拆分为 Task N.1, N.2, N.3...（记录到 STEP-N-PLAN.md + CURSOR.md）
  │
  ▼ 执行 Task N.1
  ├─ 更新 CURSOR.md（状态: 执行中）
  ├─ 写代码（参照 STEP-N-PLAN.md，1-3 个文件）
  ├─ 自测验证（该 Task 的验收点）
  ├─ 通过 → **必须 git commit** → 更新 CURSOR.md（标记完成 + commit hash）→ 继续 N.2
  └─ 不通过 → 修复 → 更新 CURSOR.md（修复轮次+1）→ 再验证（最多 3 轮）→ 通过后再 commit
      └─ 3 轮仍失败 → 更新 CURSOR.md（状态: 阻塞）→ 暂停，报告用户
  │
  ▼ 所有 Task 完成
  ├─ 执行 Step 级别的集成验收 + 回归检查
  ├─ 通过 → 更新 PROGRESS.md（归档）→ 删除 STEP-N-PLAN.md → 更新 CURSOR.md（指向下一 Step）
  │   → /compact 压缩上下文 → 开始下一 Step
  └─ 不通过 → 定位问题 Task → 修复 → commit → 再验收
```

**Task 在 PROGRESS.md 中的体现**：
```markdown
## 进行中
### Step 12: 对话页
- [x] Task 12.1: ChatPage 骨架 + 会话列表 ✅
- [x] Task 12.2: 消息渲染 + useChat 接入 ✅
- [ ] Task 12.3: Markdown 渲染 + 代码高亮 ← 当前
- [ ] Task 12.4: ToolStatus 组件
- [ ] Task 12.5: 对话交互完善
```

**git commit 规范（强制）**：
- **每个 Task/Step 验证通过后必须立即 git commit，才能继续下一个**。这是硬性规则，不可跳过。
- 未拆 Task 的 Step：验证通过 → `git add -A && git commit -m "Step N: 描述"`
- 拆了 Task 的 Step：每个 Task 验证通过 → `git add -A && git commit -m "Step N.M: Task 描述"`
- commit 消息格式示例：
  - `Step 1: 项目初始化`
  - `Step 7.1: Provider CRUD API`
  - `Step 12.3: Markdown 渲染 + 代码高亮`
- 意义：git history 是精确的回滚点，每个 commit 对应一个验证通过的功能增量

**什么时候不需要拆 Task**：
- Step 本身只涉及 1-2 个文件（如 Step 2 数据库 + schema）
- Step 逻辑简单且独立（如 Step 19 延迟/异常模拟）

**并行执行（子代理）**：
Claude Code 支持开子代理（Agent tool）并行执行互不依赖的任务。以下场景应使用并行：
- **Step 7 子步骤 1-3**：api/providers.ts、api/presets.ts、api/sessions.ts 三个 CRUD 完全独立，可同时开 3 个子代理并行实现
- **Step 7 子步骤 4（api/modules.ts）**：依赖 providers/sessions 完成后才能集成测试，但代码编写可以和 1-3 并行
- **Step 10 内部**：stores/auth.ts、composables/use-api.ts、composables/use-auth.ts 三者独立，可并行
- **Phase 4 的 Step 15/16/17/18**：四个 Tab 组件相互独立（都依赖 Step 15 的 ModuleDetailPage 容器），容器搭好后四个 Tab 可并行
- **Phase 5 的 Step 19/20**：延迟模拟和请求日志互不依赖，可并行

**并行原则**：
- 只有确认无数据/文件依赖的任务才并行
- 并行的子代理各自独立完成 + 自测
- 所有子代理完成后做一次集成验证
- 如果不确定是否能并行，就串行（安全优先）

**Phase 归档机制**：
- 归档文件只在需要**回溯已完成 Phase 的决策**时才读取
- 新窗口默认只读 PLAN.md + PROGRESS.md（两个文件足够恢复上下文）
- PROGRESS.md 的"已完成"区域为已归档 Phase 保留一行摘要（含关键上下文），不需要读归档文件就能继续工作

**自测机制**：
- 每个 Step 完成后必须执行验收测试（验收标准见实施计划）
- 验收通过才能标记为已完成
- **自测方式**：编写 `scripts/test-step-N.ts` 脚本，用 `tsx scripts/test-step-N.ts` 直接执行（不引入 Vitest/Jest 测试框架）。脚本内部：
  - 后端测试：import Fastify app → `app.inject()` 发请求（Fastify 内置的轻量测试方法，不需要真正启动 HTTP 服务）→ 断言响应
  - 如果需要启动服务器（如 SSE 流测试）：`app.listen({ port: 0 })` 随机端口 → fetch → `app.close()`
  - 前端不写自动化测试，用浏览器手动验收
- AI Agent 相关测试（Step 9）使用预置的 Provider 配置（数据库 seed），prompt 用最简文案（如"生成一个只有 name 和 age 两个字段的 test 模块"），最小化 token 消耗
- 每个 test script 执行成功输出 `✅ Step N 验收通过`，失败输出具体错误信息

**新窗口恢复流程**（优先读 CURSOR.md，最快速恢复）：
```
新窗口启动（Claude Code 自动读取 CLAUDE.md）
  │
  ├─ ① 读 CURSOR.md → 10 秒定位：当前 Phase/Step/Task + 下一步动作
  │
  ├─ ② 是否存在 STEP-N-PLAN.md？
  │   ├─ 存在 → 读取，从 CURSOR.md 指示的 Task 继续（无需读完整 PLAN.md）
  │   └─ 不存在 → 读 PLAN.md + PROGRESS.md → 生成 STEP-N-PLAN.md → 继续
  │
  ├─ ③ 如需了解更多背景 → 读 PROGRESS.md 的"当前代码状态摘要"
  │
  └─ 继续执行（通常不需要读归档文件，除非明确依赖已归档 Phase 的决策）
```

**PROMPT.md vs CLAUDE.md 的关系**：
- **CLAUDE.md**：Claude Code（CLI/IDE 插件）自动读取，无需手动操作
- **PROMPT.md**：在其他 AI 工具（如 Cursor、ChatGPT 等）中开发时，手动粘贴内容到新窗口
- 两者内容互补：CLAUDE.md 侧重开发命令和规范，PROMPT.md 侧重恢复上下文的完整指令

### 10.6 CLAUDE.md

```markdown
# MockForge 开发指南

## 项目背景
MockForge 是 AI 驱动的 Mock API 平台。完整设计见 PLAN.md，实时进度见 PROGRESS.md，执行游标见 CURSOR.md。

---

## 【强制】执行协议（违反此协议 = 必然出错）

**禁止直接从 PLAN.md 执行任何 Step。** PLAN.md 有 2700+ 行，直接执行必然遗漏上下文。

### 正确流程
1. **读 `CURSOR.md`** → 10 秒定位当前 Phase/Step/Task + 下一步动作
2. **读 `STEP-N-PLAN.md`** → 当前 Step 的聚焦子计划（唯一执行依据）
3. 如果 `STEP-N-PLAN.md` 不存在 → 读 PLAN.md 所有相关章节 → 生成子计划 → 用户确认后再执行
4. **按 Task 循环**：写代码 → 自测 → 通过则 git commit + 更新 CURSOR.md → 下一 Task
   - 失败 → 修复 → 再验证（最多 3 轮，超出则暂停报告用户）
5. Step 所有 Task 完成 → 集成验收 + 回归检查 → 更新 PROGRESS.md → 删除 STEP-N-PLAN.md → `/compact` → 下一 Step

### 关键文件（按读取优先级排列）
| 优先级 | 文件 | 用途 | 何时读 |
|--------|------|------|--------|
| 1 | `CURSOR.md` | 执行游标：当前在哪 + 下一步做什么 | **每次会话开始必读** |
| 2 | `STEP-N-PLAN.md` | 当前 Step 的聚焦子计划 | 实施时的唯一依据 |
| 3 | `PROGRESS.md` | 已完成归档 + 关键决策 | 需要了解历史背景时 |
| 4 | `PLAN.md` | 完整设计文档（2700+ 行） | **仅在生成子计划时读取** |

### 不可跳过的规则
- **不跳过子计划**：无论 Step 多简单，至少生成精简版 STEP-N-PLAN.md
- **不跨 Step 执行**：未完成验收前，不得开始下一个 Step
- **不脱离子计划写代码**：发现遗漏 → 先补充子计划 → 再写代码
- **每个 Task 完成后必须更新 CURSOR.md**：这是断点续传的关键

完整执行策略详见 PLAN.md 第十二节。

---

## 开发命令
- `pnpm dev` — 启动开发环境（前端 Vite + 后端 tsx watch）
- `pnpm build` — 构建生产版本
- `pnpm start` — 启动生产服务

## Git 规范
- 每个 Task 完成后 commit：`Step N.M: Task 描述`
- 不要积攒多个 Task 一起 commit
- 不要 commit 未验证的代码

## 编码规范
见 PLAN.md 第九节
```

---

## 十一、实施计划

### Phase 1：项目基础 [ ]

- [ ] Step 1: 项目初始化
  - `git init` 初始化 Git 仓库
  - `pnpm init` 然后安装依赖（参考以下清单，版本用最新稳定版）：
    ```
    # 生产依赖
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

    # 开发依赖
    typescript tsx concurrently
    vite @vitejs/plugin-vue
    tailwindcss @tailwindcss/vite
    drizzle-kit
    @types/better-sqlite3 @types/node
    ```
  - Vite/TS/Tailwind 配置
  - shadcn-vue 初始化（`npx shadcn-vue@latest init`）+ 安装常用组件：Button、Input、Select、Dialog、Tooltip、Toast（vue-sonner）、Switch、Tabs、Pagination、Skeleton、Popover、DropdownMenu、DatePicker
  - 创建 CLAUDE.md、PROGRESS.md（初始空模板，见 10.5 节结构）、CURSOR.md（初始空模板，见 12.3 节结构）、PROMPT.md（见 10.5 节说明）
  - 创建 .env.example、.env（从 .env.example 复制，填入实际值）、.gitignore（排除 data/、uploads/、generated/、node_modules/、dist/、.env）
  - tsconfig 配置（单包项目，非 monorepo）：
    - tsconfig.json（基础配置，compilerOptions 公共部分）
    - tsconfig.server.json（extends base，target: ES2022, module: NodeNext，include: src/server/**）
    - tsconfig.client.json（extends base，target: ES2020, module: ESNext, jsx，include: src/client/**）
    - Vite 使用 tsconfig.client.json，tsx 使用 tsconfig.server.json
  - package.json scripts（dev/dev:server/dev:client/build/start）
  - tsconfig paths 配置 `@core/*` → `src/server/core/*`（AI 生成的 controller/test 中使用此别名 import）
  - git commit: "Step 1: 项目初始化"
  - 验收：`pnpm dev` 能启动前后端，浏览器打开显示空白页面无报错

- [ ] Step 2: 数据库 + schema
  - database.ts（SQLite 连接 + Drizzle 配置）
  - schema.ts（Drizzle schema：users/providers/presets/sessions/messages/modules/mock_requests 七张表）
  - 启动时自动建表（drizzle migrate 或 push）
  - 验收：启动后 SQLite 文件生成，7 张系统表存在

- [ ] Step 3: BaseModel
  - base-model.ts（通用 CRUD：findAll/findById/create/update/delete/count/raw）
  - 内置 camelCase ↔ snake_case 自动转换
  - 使用 Node.js AsyncLocalStorage 传递当前 userId，BaseModel 构造函数从中读取并自动注入表名前缀
  - 验收：单元测试——创建临时表，CRUD 操作全部通过，camelCase 字段写入后 snake_case 存储、查出后自动转回，不同 userId 的表名隔离正确

- [ ] Step 4: Fastify 基础
  - app.ts（实例配置：cors、multipart、rate-limit、全局错误处理）
  - @fastify/static 注册两次：1) prefix: '/uploads'，root: './uploads'（图片访问） 2) 生产环境 prefix: '/'，root: './dist/client'（前端静态文件，开发环境由 Vite 处理不需要）
  - server.ts（启动入口）
  - response.ts（success/paginated/error 三个函数）
  - 验收：`GET /api/health` → `{ success: true, data: 'ok' }`

- [ ] Step 5: 认证 + 数据库 seed
  - auth.ts 中间件（JWT 验证 + 检查 user.is_active，禁用用户即使 JWT 有效也返回 401）
  - encryption.ts（AES 加解密）
  - api/auth.ts（POST /api/auth/register + POST /api/auth/login）
  - 启动时 seed：创建管理员账号（从 .env）+ 预置测试用 AI Provider（id=1）
  - 验收：注册 → 201；登录 → 返回 JWT；带 JWT 访问受保护接口 → 200；不带 → 401；providers 表有预置记录

### Phase 2：AI Agent 核心 [ ]

- [ ] Step 6: Agent 工具集
  - write-file.ts（写入 generated/{userId}/ 下的文件，.sql 后缀自动执行建表，_meta.json 写入时自动同步 modules 表。SQL 执行失败时 catch 异常并返回错误信息给 AI，AI 可据此修复 SQL）
  - read-file.ts（读取 generated/{userId}/ 下的文件）
  - run-test.ts（动态 import test.ts 并执行）
  - manage-data.ts（参数：{ action, moduleName, ...args }）
    - insert(moduleName, data) → 插入一条
    - bulk_generate(moduleName, count) → 读取 generated/{userId}/{moduleName}/_meta.json 的 fields → 按 faker 映射规则生成 count 条 → 批量插入
    - delete(moduleName, id) → 删除指定记录
    - clear(moduleName) → 清空表数据
  - list-modules.ts（列出用户的所有模块，从 modules 表查）
  - delete-module.ts（删除模块：1. DROP mock 数据表 2. 删除 generated/{userId}/{module}/ 目录 3. 删除 modules 表记录）
  - test-runner.ts（test/assert/request 工具函数）
  - tool-registry.ts（统一注册，注入 userId）
  - 验收：手动调用每个工具函数，确认功能正确

- [ ] Step 7: System Prompt + AgentRunner + 系统 API
  实现顺序（内部子步骤）：
  1. api/providers.ts（Provider CRUD + 验证，不依赖 AI，先实现方便后续测试）
  2. api/presets.ts（项目预设 CRUD，scope 规则同 Provider）
  3. api/sessions.ts（会话 CRUD + 消息加载，sessions 表含 preset_id + module_name）
  4. api/modules.ts（模块列表 + 详情 + _context.md + api-doc.md 下载）
  5. system-prompt.ts（完整 prompt，所有引用内联 + 完整示例模块 + 预设注入逻辑）
  6. agent-runner.ts（封装 streamText + maxSteps，4 层 System Prompt 拼接：基础骨架 → 预设 → 模块列表 → 模块上下文）
  7. api/chat.ts（POST /api/chat，鉴权 → 查 session/provider/preset/module → 调 agent-runner → 持久化）
  - 验收：
    1. Provider CRUD 正常（添加/编辑/删除/验证/列表含 public）
    2. Preset CRUD 正常（创建/编辑/删除/列表含 public）
    3. Session CRUD 正常（创建含 presetId/moduleName、列表/删除/加载消息）
    4. 用脚本发送 POST /api/chat（带 JWT + sessionId），收到 SSE 事件流（text-delta + tool-call + tool-result）
    5. 消息持久化到 messages 表
    6. 选择预设后 System Prompt 中包含预设的 responseFormat/customPrompt

- [ ] Step 8: mock-router.ts
  - catch-all `/mock/*` 路由
  - 解析 URL → 模块名 + 子路径 → 匹配 _meta.json endpoints → import controller → 调函数
  - 动态 import 缓存管理（旧版本清理）
  - 延迟模拟 + 异常模拟（读 _meta.json config）
  - 模块不存在或端点不匹配时返回 404 `{ success: false, message: '接口不存在' }`
  - controller 运行时异常（AI 代码 bug）时 catch 并返回 500 `{ success: false, message: '接口内部错误: {error.message}' }`，不让 Fastify 进程崩溃
  - 验收：手动在 generated/ 下放一个模块文件，`curl GET /mock/test` 返回正确数据；`curl GET /mock/nonexistent` 返回 404

- [ ] Step 9: 端到端验证
  - 通过对话生成一个完整模块 → 测试通过 → 修改字段 → 增量测试通过
  - 验收：对话中发 "生成一个订单管理接口" → AI 生成 6 个文件（含 _context.md + api-doc.md） → run_test 全部通过 → 发 "把 status 改成 orderStatus" → 修改后测试通过 → _context.md 和 api-doc.md 同步更新

### Phase 3：前端 — 对话 [ ]

- [ ] Step 10: 前端基础
  - router/index.ts（路由定义 + 路由守卫：未登录重定向 /login，已登录跳过 /login）
  - AppLayout.vue（左侧边栏 + 顶部 Header + 右侧主内容区）
  - AppSidebar.vue（导航项：对话、模块、设置、管理；底部用户头像 + 退出）
  - AppHeader.vue（Logo + 当前 Provider/Model 选择下拉 + 用户信息）
  - LoginPage.vue（登录/注册双 Tab 切换表单，字段：用户名 + 密码 + 确认密码(注册)，表单校验，登录后跳转首页）
  - stores/auth.ts（登录/注销/token 持久化到 localStorage/当前用户信息）
  - composables/use-api.ts（fetch 封装：自动附带 JWT、401 自动跳登录页、统一错误 toast）
  - composables/use-auth.ts（登录状态检查 + 权限判断）
  - 验收：注册新用户 → 登录 → 显示布局 → 刷新页面不丢失登录态 → 退出后跳转登录页

- [ ] Step 11: Provider 配置页 + 项目预设页
  - SettingsPage.vue（两个 Tab：Provider 配置 + 项目预设）
  
  **Tab 1: Provider 列表 + 添加/编辑 dialog 表单**
  - 表单字段：显示名、提供商类型下拉（Anthropic/OpenAI/Google/OpenAI 兼容/自定义）、Base URL（预设提供商自动填入可修改，兼容/自定义必填）、API Key（密码输入，已保存显示 sk-****脱敏）、默认模型 ID、公开开关（scope）
  - [验证连接] 按钮：测试请求 → 成功绿色提示 + is_verified=1 → 失败红色显示具体错误
  - 列表显示：名称、类型图标、Base URL（截断显示）、模型、scope 标签（私有/公开）、验证状态徽标、操作（编辑/删除，公开的他人 Provider 只显示"使用"）
  - stores/provider.ts（Provider CRUD + 当前选中的 Provider + 可用列表含 public）
  
  **Tab 2: 项目预设列表 + 添加/编辑 dialog 表单**
  - 预设列表：名称、描述、scope 标签、操作（编辑/删除，public 他人的只读）
  - 编辑表单：名称、描述、响应格式（成功/错误/分页三个输入框）、字段命名风格下拉、分页参数名、自定义提示词 textarea、公开开关
  - stores/preset.ts（Preset CRUD + 可用列表含 public）
  
  - 验收：
    1. 添加 Anthropic Provider → base_url 自动填入 → 验证通过绿色标记
    2. 添加自定义 Provider → 手动填 base_url → 验证通过
    3. 设为公开 → 另一用户能看到并使用
    4. 编辑修改 API Key → 保存成功
    5. 删除 → 有关联会话时弹出警告
    6. 预置的测试 Provider 可用
    7. 创建项目预设 → 填写响应格式和自定义提示词 → 保存成功
    8. 预设列表显示正常，公开的他人预设可见

- [ ] Step 12: 对话页
  - ChatPage.vue（useChat 接入 + 顶部项目预设/模块选择器）
  - ChatPanel.vue / MessageList.vue / MessageBubble.vue / ChatInput.vue / ToolStatus.vue
  - MessageBubble 解析 `[download:模块名/api-doc.md]` 标记渲染为下载按钮
  - stores/chat.ts（会话列表 + 切换 + 缓存 + 预设/模块选择状态同步到 session）
  - Markdown 渲染（markdown-it + @shikijs/markdown-it）
  - 停止生成、重新生成、会话标题自动生成
  - 自动滚动（用户上滚暂停）
  - 首次进入无会话时自动创建一个新会话
  - 加载历史消息（GET /api/sessions/:id/messages → setMessages）
  - 验收：能对话，流式输出正常，工具调用显示状态，切换会话消息不丢失，刷新页面后消息恢复，预设/模块选择器正常工作（选择后 session 更新，AI 行为受预设影响），API 文档下载按钮可点击下载

- [ ] Step 13: 文件上传与解析
  - file-parser.ts（统一解析器）
  - api/upload.ts（POST /api/upload，multipart 接收 → 解析 → 返回结果）
  - composables/use-upload.ts（拖拽/粘贴/进度/预校验）
  - AttachmentPreview.vue
  - chat.ts 中附件消息构建（图片 → 多模态，文档 → 文本拼接）
  - 验收：拖拽 PDF 到输入框 → 显示预览 → 发送后 AI 能理解文档内容并生成模块

### Phase 4：前端 — 模块管理 [ ]

- [ ] Step 14: 模块列表页
  - ModulesPage.vue（网格布局，响应式 1-3 列）
  - ModuleCard.vue 每张卡片显示：
    - 模块名 + 描述
    - 状态徽标（active 绿 / error 红 / disabled 灰）
    - 端点数量（如"5 个接口"）
    - 测试通过率（如"5/5 通过"，带进度条颜色：全通过绿、部分橙、全失败红）
    - 最后更新时间
    - 操作按钮：[查看详情] [在对话中修改]（创建新会话，预填消息"我要修改 {模块名} 模块"） [删除]
  - stores/modules.ts（模块列表 + 单模块详情 + 删除）
  - 顶部搜索框（按模块名/描述过滤）
  - 空状态：无模块时显示引导"去对话页生成你的第一个 Mock 模块"
  - 删除模块：ConfirmDialog 明确提示"将永久删除模块 {name} 的所有接口、数据和文件，不可恢复"
  - 验收：显示所有模块卡片，卡片信息完整，搜索过滤正常，删除后列表更新

- [ ] Step 15: 模块详情页 — 接口列表 Tab
  - ModuleDetailPage.vue（Tab 容器：接口列表 / 测试器 / 数据管理 / 文档，页面加载时调 GET /api/modules/:name 获取完整 _meta.json 内容，作为 props 传给各 Tab 组件）
  - EndpointList.vue（端点列表 + 点击展开快速测试面板）
  - 每行：方法徽标 + 路径 + 说明 + [展开测试]
  - 展开面板：自动生成示例请求参数 → [发送] → 显示响应 JSON + 状态码 + 耗时
  - 验收：显示所有端点，展开后发送请求能看到正确响应，cURL 复制正常

- [ ] Step 16: 模块详情页 — 接口测试器 Tab
  - ApiTester.vue（方法下拉 + URL 输入 + Params/Headers/Body 三 Tab + 响应区）
  - Body 编辑器用 `<textarea>` + JSON 格式化（非 Monaco，避免重量级依赖）
  - 响应区：状态码着色 + 耗时 + 大小 + JSON 高亮 + 一键复制
  - api/test.ts（服务端代理：接收前端请求 → 转发到 Mock 接口 → 返回完整响应含 status/headers/body/duration）
  - 验收：GET/POST/PUT/DELETE 均能正常发送和显示，路径参数 :id 能正确替换，JSON body 格式错误时有提示

- [ ] Step 17: 模块详情页 — 数据管理 Tab
  - DataTable.vue（@tanstack/vue-table 集成，动态列定义、Cell 展示/编辑切换、排序、筛选、分页、行选择）
  - EditableCell.vue（按字段类型映射表单元素：Input/Select/Switch/DatePicker/Textarea）
  - DataGenerator.vue（批量生成 dialog：数量 + 字段规则自定义）
  - api/data.ts（CRUD + 批量删除 + 批量生成 + 排序筛选参数处理）
  - 验收：
    1. 表格正常展示，列宽固定，长文本省略 + 悬浮 tooltip
    2. 点击 Cell 无抖动切换为表单元素，回显当前值
    3. 编辑后 blur/Enter 保存，成功绿色闪烁，失败回退 + toast
    4. Tab 连续编辑，Esc 取消，Enter 下移
    5. 新增行 → 填写 → 保存成功
    6. 批量生成 50 条 → 数据正常
    7. 勾选 → 批量删除 → 确认后删除成功

- [ ] Step 18: 模块详情页 — 文档 Tab
  - 用 markdown-it + @shikijs/markdown-it 渲染模块的 api-doc.md（GET /api/modules/:name/api-doc）
  - 顶部工具栏：[下载 Markdown] [下载 OpenAPI JSON] [复制代理配置]
  - 代理配置区域：Vite/Webpack/Nginx 三种场景的配置代码片段，一键复制
  - 验收：文档渲染正确（含代码块高亮），Markdown 下载内容完整，OpenAPI JSON 结构正确

### Phase 5：增强 [ ]

- [ ] Step 19: 延迟/异常模拟
  - 模块详情页新增"设置"区域（或 Tab 5），可配置 delay（min/max ms）和 errorRate（0-1 滑块）
  - 保存后更新 _meta.json 的 config 字段
  - mock-router 读取 config：delay 时 `await sleep(random(min, max))`，errorRate 时随机返回 500
  - 验收：设置 delay 200-500ms 后请求耗时在此范围，设置 errorRate 0.5 后约一半请求 500

- [ ] Step 20: 请求日志
  - mock-router 中间件：每个 Mock 请求记录到 mock_requests 表（method/path/status/duration/request_body/response_body）
  - request_body 和 response_body 超过 2KB 截断存储
  - 模块详情页新增"日志" Tab：表格展示最近请求，列（时间/方法/路径/状态码/耗时），点击展开查看请求体和响应体
  - 支持按方法、状态码筛选，按时间倒序排列
  - 验收：发 5 个请求后日志 Tab 显示 5 条记录，展开能看到详情

- [ ] Step 21: OpenAPI 导入/导出
  - 导出：读取 _meta.json → 转换为 OpenAPI 3.0 JSON（paths/schemas/info），字段类型映射为 OpenAPI type
  - 导入：解析 OpenAPI JSON → 提取 paths 和 schemas → 创建 _meta.json + schema.sql + 空 controller.ts（只有 CRUD 骨架）
  - 模块列表页添加 [导入] 按钮，弹出 dialog 选择文件
  - 验收：导出后粘贴到 Swagger Editor 能正确渲染，导入一个标准 OpenAPI 文件后模块可用且接口能访问

- [ ] Step 22: 管理员面板
  - AdminPage.vue（仅 role=admin 可访问，路由守卫检查）
  - 用户管理 Tab：用户列表表格（用户名/角色/状态/注册时间），操作（启用/禁用/重置密码）。注意：只做禁用不做删除（禁用后数据保留，避免级联清理的复杂性）
  - Provider 管理 Tab：所有 Provider 列表，操作（设为公共/取消公共）
  - Preset 管理 Tab：所有预设列表，操作（设为公共/取消公共/删除）
  - api/users.ts（GET 列表 + PUT 状态 + PUT 重置密码，仅 admin 权限）
  - 验收：管理员能看到所有用户，禁用用户后该用户无法登录，Provider 设为公共后其他用户可见

- [ ] Step 23: Docker 化 + 生产部署
  - Dockerfile 多阶段构建：
    Stage 1: `node:22-alpine` 安装依赖
    Stage 2: 构建前端（`vite build`）+ 编译后端（`tsc`）
    Stage 3: 最终镜像仅包含 dist/ + node_modules（生产依赖）
  - docker-compose.yml：
    volumes 挂载 `./data:/app/data`、`./uploads:/app/uploads`、`./generated:/app/generated`
    environment 注入 .env 变量
    ports 映射 3000
  - Fastify 生产模式：serve `dist/client/` 静态文件，generated/ 下 .ts 文件通过 tsx 加载
  - 验收：`docker-compose up -d` → 浏览器访问 → 注册登录 → 对话生成模块 → Mock 接口可用

---

## 十二、执行策略（Step 级实施协议）

> **核心原则：大计划不可直接执行。每个 Step 必须先"聚焦"再"动手"。**
> AI 的上下文窗口有限，直接面对完整 PLAN.md 必然遗漏细节。
> 解决方案：为每个 Step 生成一份**自包含的实施子计划**，将散落在 PLAN.md 各章节的相关设计
> 汇聚到一个文件中，AI 只需聚焦该文件即可完整实施。

### 12.1 Step 实施生命周期

```
开始 Step N
  │
  ▼ ① 生成实施子计划（STEP-N-PLAN.md）
  ├─ 扫描 PLAN.md 所有章节，收集与 Step N 相关的全部上下文
  ├─ 检查已完成 Step 的产出（哪些文件/API/表已存在）
  ├─ 生成 STEP-N-PLAN.md（结构见 12.2）
  ├─ **用户确认**（可调整/补充）
  │
  ▼ ② 拆分 Task（写入 STEP-N-PLAN.md 的 Task 清单区域 + CURSOR.md）
  ├─ 按 Task 拆分规则拆为 2-5 个 Task
  ├─ 每个 Task 明确：改哪些文件、验收条件、依赖关系
  │
  ▼ ③ 逐 Task 执行（循环）
  │   ┌─────────────────────────────────────────────┐
  │   │  执行 Task N.M                               │
  │   │  ├─ 更新 CURSOR.md（状态: 执行中）            │
  │   │  ├─ 写代码（参照 STEP-N-PLAN.md）             │
  │   │  ├─ 自测验证                                  │
  │   │  │   ├─ 通过 → git commit                    │
  │   │  │   │   → 更新 CURSOR.md（完成 + commit hash）│
  │   │  │   │   → 下一 Task                          │
  │   │  │   └─ 失败 → 分析原因 → 修复                │
  │   │  │       → 更新 CURSOR.md（修复轮次+1）        │
  │   │  │       → 再验证（最多 3 轮）                 │
  │   │  │           ├─ 通过 → commit                  │
  │   │  │           └─ 3 轮仍失败 → 暂停              │
  │   │  │               → 更新 CURSOR.md（状态:阻塞） │
  │   │  │               → 报告问题，等用户决策         │
  │   └──┘                                            │
  │   重复直到所有 Task 完成                            │
  │                                                   │
  ▼ ④ Step 集成验收
  ├─ 执行 Step 级验收标准（来自 PLAN.md 实施计划中的"验收"项）
  ├─ 回归检查：之前 Step 的核心功能是否仍正常
  │   ├─ 通过 → Step 完成
  │   └─ 不通过 → 定位问题 → 修复 → 再验收
  │
  ▼ ⑤ 收尾
  ├─ 更新 PROGRESS.md（Step 状态 + 关键决策 + 踩坑记录）
  ├─ 删除 STEP-N-PLAN.md（已完成，信息已归入 PROGRESS.md 和 git history）
  ├─ 更新 CURSOR.md（指向下一 Step）
  ├─ /compact 压缩上下文（释放工作内存）
  ├─ 进入下一个 Step → 回到 ①
```

### 12.2 STEP-N-PLAN.md 结构

每个 Step 开始前生成，是该 Step 的**唯一执行依据**。

```markdown
# Step N: 标题

## 目标
一句话说明这个 Step 完成后系统新增了什么能力。

## 前置状态
- 依赖的已完成 Step：Step X, Y（简述其产出）
- 已存在的关键文件：列出本 Step 会用到的
- 已可用的 API/表/组件：列出本 Step 会依赖的

## 设计上下文（从 PLAN.md 各章节汇聚）
> 这是最关键的部分。把 PLAN.md 中散落在不同章节、与本 Step 相关的设计
> 全部摘录/整理到这里。AI 实施时只需看这一个文件。

### 数据库（摘自第四节）
相关表结构、字段说明...

### API 接口（摘自第五节）
相关接口的完整定义（路径、参数、响应、错误码）...

### 前端页面（摘自第六节）
相关页面/组件的设计、交互逻辑...

### 业务规则（摘自第七/八节）
相关的业务逻辑、权限规则、边界条件...

### 编码规范（摘自第九节）
本 Step 需要特别注意的规范...

## Task 清单
- [ ] Task N.1: 描述
  - 文件：`path/to/file.ts`（新建/修改）
  - 要点：关键实现细节
  - 验收：怎么确认这个 Task 做对了
- [ ] Task N.2: ...
- [ ] Task N.3: ...

## Step 验收标准（摘自 PLAN.md 实施计划）
- [ ] 验收项 1
- [ ] 验收项 2

## 回归检查项
- [ ] 之前 Step 的哪些功能需要确认未被破坏
```

### 12.3 CURSOR.md 结构

实时执行游标，极简文件，每次 Task 状态变更时**覆写**（不是追加）。

```markdown
# 执行游标

## 当前位置
- Phase: 2
- Step: 7 — System Prompt + AgentRunner + 系统 API
- Task: 7.3 — api/sessions.ts 会话 CRUD
- 状态: 执行中 | 已完成待验收 | 验收失败修复中（第N轮） | 阻塞

## 当前 Step 子计划
→ STEP-7-PLAN.md

## Task 进度
- [x] Task 7.1: api/providers.ts ✅ (commit: abc1234)
- [x] Task 7.2: api/presets.ts ✅ (commit: def5678)
- [ ] Task 7.3: api/sessions.ts ← 当前
- [ ] Task 7.4: api/modules.ts
- [ ] Task 7.5: system-prompt.ts + agent-runner.ts
- [ ] Task 7.6: api/chat.ts
- [ ] Step 验收

## 下一步动作
读取 STEP-7-PLAN.md 的 Task 7.3 部分，实现 sessions CRUD API。

## 失败记录（如有）
Task 7.3 第1轮验证失败：session 创建时未校验 preset_id 存在性，
外键约束报错。已修复，进入第2轮验证。
```

### 12.4 CURSOR.md 更新时机

| 事件 | 更新内容 |
|------|---------|
| Task 开始前 | 状态 → 执行中，写入"下一步动作" |
| Task 验证通过 | 标记 ✅ + commit hash，游标移到下一 Task |
| Task 验证失败 | 记录失败原因到"失败记录"，修复轮次 +1 |
| Step 子计划生成后 | 指向新的 STEP-N-PLAN.md |
| Step 验收通过 | Phase/Step 指向下一个，清空 Task 列表 |
| 3 轮修复仍失败 | 状态 → 阻塞，失败记录写明具体问题 |

### 12.5 子计划生成规则

**必须汇聚的上下文**（AI 生成 STEP-N-PLAN.md 时的检查清单）：

| 检查项 | 来源 |
|--------|------|
| 涉及哪些数据库表？完整字段定义 | 第四节 数据库设计 |
| 涉及哪些 API？完整接口定义 | 第五节 API 设计 |
| 涉及哪些页面/组件？交互设计 | 第六节 前端页面 |
| 涉及哪些业务规则？权限/scope/边界 | 第七节 核心机制 |
| 涉及哪些工具/Agent 逻辑？ | 第八节 AI Agent |
| 有哪些编码规范约束？ | 第九节 编码规范 |
| 环境变量/配置需要什么？ | 第十节 环境配置 |
| PLAN.md 实施计划中的验收标准 | 第十一节 |
| 已完成 Step 的关键决策（影响本 Step） | PROGRESS.md |

**不要照搬，要提炼**：只摘录与当前 Step 直接相关的内容，无关内容不要复制。
目标是让这份子计划在 **3000-8000 字**以内，AI 一次读完即可完整理解。

### 12.6 上下文管理策略

**为什么需要管理上下文**：
- Claude Code **不能**自己清空上下文重启新会话
- 自动压缩（接近上限时系统自动触发）会丢失实施细节
- `/compact` 可手动触发压缩，释放空间但同样丢失细节
- 因此，所有关键信息必须写入文件，不能仅存在于对话上下文中

**Step 间自动 /compact**：
每完成一个 Step 的集成验收后，执行 `/compact` 压缩上下文。原因：
- 一个 Step 的实施细节（调试过程、中间错误）对下一个 Step 没有价值
- 真正需要保留的信息已写入 CURSOR.md + PROGRESS.md + git history
- 压缩后释放上下文空间，让后续 Step 有足够的"工作内存"
- 这样一个会话可以跑更多 Step，减少开新窗口的频率

**上下文不够时**：
用户开新窗口 → AI 读 CURSOR.md → 读 STEP-N-PLAN.md → 无缝继续，无需用户解释任何背景。

### 12.7 自动执行主循环

```
┌─────────────────────────────────────────────────────────────┐
│                    自动执行主循环                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ① 读 CURSOR.md → 定位当前 Phase/Step/Task                  │
│     │                                                       │
│     ├─ 无 STEP-N-PLAN.md？→ 读 PLAN.md → 生成子计划         │
│     │   → 更新 CURSOR.md → 用户确认                          │
│     │                                                       │
│  ② 读 STEP-N-PLAN.md → 找到当前 Task                        │
│     │                                                       │
│  ③ 执行 Task → 写代码 → 自测                                │
│     │                                                       │
│     ├─ 通过 → git commit → 更新 CURSOR.md → 回到 ③ 下一Task │
│     └─ 失败 → 修复 → 更新 CURSOR.md（轮次+1）→ 再验证       │
│         └─ 3 轮失败 → 更新 CURSOR.md（状态:阻塞）→ 暂停     │
│                                                             │
│  ④ 所有 Task 完成 → Step 集成验收                            │
│     │                                                       │
│     ├─ 通过 → 更新 PROGRESS.md → 删除 STEP-N-PLAN.md        │
│     │   → 更新 CURSOR.md（指向下一 Step）                    │
│     │   → /compact 压缩上下文                                │
│     │   → 回到 ① 开始下一 Step                               │
│     └─ 不通过 → 定位问题 Task → 修复 → 再验收                │
│                                                             │
│  ⑤ Phase 所有 Step 完成 → 归档 PROGRESS-PHASE-N.md          │
│     → 回到 ① 开始下一 Phase                                  │
│                                                             │
│  ────────── 上下文不够了？──────────                          │
│                                                             │
│  用户开新窗口 → AI 读 CURSOR.md → 无缝继续（无需用户解释）    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 12.8 用户介入节点

| 节点 | 是否必须 | 说明 |
|------|---------|------|
| Step 子计划确认 | **建议是** | 防止 AI 误解设计。信任度高时可改为"生成后直接执行，事后审查" |
| 3 轮修复仍失败 | **是** | AI 能力边界，需要人工判断 |
| 前端 UI 验收 | **是** | AI 无法看到浏览器渲染结果 |
| 开新窗口 | **偶尔** | 上下文极端膨胀时，AI 会提示用户开新窗口 |

### 12.9 与现有机制的关系

| 现有机制 | 不变/调整 |
|----------|----------|
| Phase → Step → Task 三级结构（10.5 节） | **不变** |
| Task 拆分规则（10.5 节） | **不变**，Task 拆分从 STEP-N-PLAN.md 而非 PLAN.md |
| git commit 规范（10.5 节） | **不变** |
| 自测机制（10.5 节） | **不变** |
| PROGRESS.md 维护规则（10.5 节） | **不变** |
| 并行执行/子代理（10.5 节） | **不变**，子代理各自读 STEP-N-PLAN.md 中自己的 Task 部分 |
| 新窗口恢复流程（10.5 节） | **已调整**：优先读 CURSOR.md，减少对完整 PLAN.md 的依赖 |
| Phase 归档机制（10.5 节） | **不变** |

---

## 十三、流程图

### 用户旅程（整体）

```
首次使用：
  注册 → 登录 → 配置 AI Provider（API Key + 模型）→ 验证通过
  │
  ▼ 日常使用：
  新建对话 → 描述需求（或上传文档）→ AI 生成 Mock 模块
  │           → 测试通过 → 种子数据生成 → 完成
  │
  ├── 在模块列表查看已生成的模块
  ├── 在模块详情页测试接口 / 管理数据 / 查看文档
  ├── 前端项目配置代理 { '/mock': 'http://localhost:3000' }
  ├── 需求变更时 → 对话修改 → AI 增量修改 + 自动测试
  │
  ▼ 真实接口就绪后：
  前端改代理目标 → 完成切换，无需改代码
```

### 新建模块

```
用户: "生成订单管理接口"
  │
  ▼  AI 理解需求，确定字段和端点
  │
  ├── write_file("order/_meta.json")
  ├── write_file("order/schema.sql")         ← 写入后自动执行建表
  ├── write_file("order/controller.ts")
  ├── write_file("order/test.ts")            ← AI 根据需求编写测试用例
  │
  ├── run_test("order")
  │     ├── 创建记录              ✅
  │     ├── 查询详情-数据一致性    ✅
  │     ├── 列表分页              ✅
  │     ├── 更新记录              ✅
  │     ├── 删除记录              ✅
  │     └── 业务逻辑验证          ✅
  │
  ├── manage_data("bulk_generate", "order", 20)
  ├── write_file("order/_context.md")
  ├── write_file("order/api-doc.md")
  │
  └── 输出: "✅ 订单管理接口生成完成！6 个测试全部通过。" + [download:order/api-doc.md]
```

### 测试失败 → 修复循环

```
run_test("order") → 2 passed, 1 failed
  │
  ▼  失败: "状态不能反向流转 — 期望 success=false，实际 success=true"
  │
  ├── read_file("order/controller.ts")      ← AI 读取业务代码
  ├── read_file("order/test.ts")            ← AI 读取测试代码
  │
  ▼  AI 判断：controller 没有实现状态校验（业务代码问题）
  │
  ├── write_file("order/controller.ts")     ← 补充状态流转校验逻辑
  │
  ├── run_test("order") → 3 passed, 0 failed ✅
  │
  └── 继续后续流程

  如果第 2 轮仍失败 → 告知用户具体错误，停止
```

### 修改模块

```
用户: "把 status 改成 orderStatus"
  │
  ├── read_file("order/_meta.json")
  ├── read_file("order/controller.ts")
  ├── read_file("order/schema.sql")
  │
  ├── write_file("order/schema.sql")        ← ALTER TABLE（自动执行）
  ├── write_file("order/controller.ts")     ← 改字段引用
  ├── write_file("order/_meta.json")        ← version +1
  ├── write_file("order/test.ts")           ← 更新测试中的字段名
  │
  ├── run_test("order")                     ← 全量测试
  ├── write_file("order/_context.md")        ← 更新上下文
  ├── write_file("order/api-doc.md")        ← 更新 API 文档
  │
  └── "✅ 已将 status 改为 orderStatus"
```

### 文件上传 → 生成模块

```
用户: 拖拽 "订单接口文档.pdf" 到输入框
  │
  ▼ ① 前端
  use-upload.ts 预校验（大小、类型）→ POST /api/upload
  │
  ▼ ② 后端
  file-parser.ts 解析 PDF → 提取文本
  → 返回 { fileId, preview: "订单管理接口\n字段: orderNo..." }
  │
  ▼ ③ 前端显示附件预览
  用户输入: "按照这个文档生成 Mock 接口" → 发送
  │
  ▼ ④ 后端 chat.ts
  将文档文本拼入 user message → 发给 AI
  │
  ▼ ⑤ AI 理解文档内容
  ├── 如果文档有明确的字段/路径/格式定义 → 严格按文档实现
  ├── 如果文档只有模糊描述 → AI 自行设计并确认
  │
  ▼ ⑥ 按【新建模块】流程继续
```

### 数据管理

```
前端 ModuleDetailPage → Tab 3: DataTable
  ├── 查看   → GET    /api/data/order?page=1&pageSize=20
  ├── 编辑   → PUT    /api/data/order/5  { orderStatus: "paid" }
  ├── 添加   → POST   /api/data/order    { ... }
  ├── 删除   → DELETE /api/data/order/5
  ├── 批量删除 → POST /api/data/order/batch-delete  { ids: [1,2] }
  ├── 批量生成 → POST /api/data/order/bulk-generate  { count: 50 }
  └── 清空   → POST   /api/data/order/clear
```

### 认证流程

```
登录：POST /api/auth/login { username, password }
  → 验证密码（bcryptjs.compare）
  → 签发 JWT（jose.SignJWT，过期时间从 .env 读取）
  → 返回 { token, user: { id, username, role } }

鉴权：请求 Header: Authorization: Bearer {token}
  → auth.ts 中间件解析 JWT
  → 失败 → 401 { success: false, message: 'Token 无效或已过期' }
  → 成功 → 将 user 注入 request.user，继续

前端 token 管理：
  → 登录成功后存入 localStorage
  → use-api.ts 拦截器自动附带到 Header
  → 收到 401 响应 → 清除 token → 跳转登录页
  → 安全说明：localStorage 存 JWT 有 XSS 风险，但 MockForge 是内部开发工具不面向公网，可接受。
    markdown-it 渲染已通过 @shikijs/markdown-it 内置 XSS 防护。
```

---

## 十四、风险与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| AI 生成代码有语法错误 | 中 | run_test 发现 → AI 自修复（最多 2 轮） |
| 动态 import 内存泄漏 | 中 | import 新版本后删除旧版本缓存条目 |
| 低配模型质量差 | 中 | 骨架固定 = 填空式生成，降低难度 |
| SQLite ALTER TABLE 限制 | 低 | 改字段名时重建表（AI 在 schema.sql 中处理） |
| better-sqlite3 同步阻塞 | 低 | MockForge 并发量小可接受；必要时可用 worker 模式 |
| AI Provider API Key 失效/余额不足 | 中 | agent-runner 捕获并返回友好提示，前端显示错误 + 引导用户检查配置 |
| 上传文件积累占满磁盘 | 中 | node-cron 定时清理过期文件（24h） |
| 用户接口文档和默认骨架不一致 | 高 | System Prompt 明确"文档 > 骨架"优先级 |
| 多用户并发操作 | 低 | 按用户隔离（不同用户操作不同目录/表），同一用户并发 write_file 用简单的 Promise 队列串行化 |
