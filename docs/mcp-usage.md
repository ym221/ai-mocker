# MockForge MCP 使用指南

> 面向开发者：想让 IDE（Cursor / Claude Code / Zed）里的 AI 助手通过 MCP 协议直接操作 MockForge，自动化从需求到 Mock 到测试到交接的整条流水线。

---

## 1. 背景

MockForge 通过 Model Context Protocol（MCP）对外暴露**12 个工具 + 1 个使用指南资源**，让 IDE 里的 AI 助手能够：

- **读**：列模块、用 `inspect_module` 一次拿 doc+openapi+health、查 Mock 访问日志
- **写**：从规格生成模块（`create_module_from_spec`）、修改模块（`update_module`）、跑测试、造数据、删模块
- **诊断**：把实际请求与 OpenAPI 对比（diff）
- **会话**：查询在跑 session 的状态、主动放弃（Step-MCP-5 新增）
- **交接**：为后端团队生成 Markdown 交接报告

写工具默认**阻塞最多 60s**；超时仍在跑就返 `still-running` + sessionId（带 `stageDescription` + `expectedRemainingSec` + `suggestedNextAction`），调用方重发同参数即可 **attach-on-resend** 继续等。Step-Perf-1 后:system prompt 瘦身 60%、`write_files` 批量写盘让模块创建从 7-15min 降到预期 3-5min、provider-aware prompt caching 降 token 成本、humanized 进度让 AI 读得懂。详见 §14 / §15。

MCP 服务与 Web UI **跑在同一进程**，共享同一份 SQLite。IDE AI 开的会话 **Web UI 能看见并接管**。

---

## 2. 准备

### 2.1 启动 MockForge

- **本地开发**：`pnpm dev`
- **Docker 部署**：`docker compose up -d`

服务监听 `http://localhost:3000`，MCP 端点为 `POST /mcp`。

### 2.2 生成 API Key

1. 登录 Web UI → **Settings → API Keys**
2. 点 **生成 API Key**，在弹窗里立即复制（形如 `mf_xxxxx`）
3. 关闭弹窗后无法再次查看；丢失请重新生成（旧 Key 立即失效）

> ⚠ API Key 等同账户密码。生产部署建议加反向代理 + HTTPS。

---

## 3. IDE 配置

### Cursor / Claude Code

在 `~/.cursor/mcp.json` 或项目 `.mcp.json`：

```json
{
  "mcpServers": {
    "mockforge": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "X-API-Key": "mf_your_api_key_here"
      }
    }
  }
}
```

重启 IDE。AI 会自动读取 `mockforge://guide` 资源，知道怎么用这 12 个工具。

### 远程部署

把 URL 换成你的服务器地址。每个团队成员生成自己的 Key，互不影响。

---

## 4. 工具全集（v2）

### 读（6 个）

| 工具 | 用途 |
|------|------|
| `list_modules` | 列出当前用户的全部模块（name / status / health / endpoints / mockBaseUrl） |
| `get_api_doc` | 读 `api-doc.md`（人类可读） |
| `get_openapi` | 读 OpenAPI 3.0.3 JSON（机器可读） |
| `get_mock_access_log` | 查最近 N 次 `/mock/*` 的真实请求 + 响应 |
| `get_module_health` | 诊断模块健康（5 文件 + _meta + SQLite 表） |
| `diff_with_openapi` | 对比实际请求/响应 vs 契约，输出结构化 diff |

### 写（3 个轻量，即时生效）

| 工具 | 用途 |
|------|------|
| `manage_data` | insert / update / delete / batch_delete / clear / list / bulk_generate |
| `run_test` | 跑模块 `test.ts` 的全 CRUD 回归 |
| `delete_module` | **不可逆**删除模块 |

### 写（2 个重量，触发 AI 生成 ~30s-3min）

| 工具 | 用途 |
|------|------|
| `create_module_from_spec` | 从 OpenAPI / YAML / 自然语言创建模块。支持 `dry_run` 预览。可选 `provider`/`model`/`preset` 覆盖会话级默认 |
| `update_module` | 用自然语言指令修改模块。支持 `dry_run` 预览。可选 `provider`/`model`/`preset` 覆盖会话级默认 |

### 汇报（1 个）

| 工具 | 用途 |
|------|------|
| `generate_handoff_report` | 生成交接 Markdown（契约 + 健康 + 访问日志 + 后端建议） |

### Resource

| URI | 用途 |
|-----|------|
| `mockforge://guide` | 给 AI 读的详细使用指南 + 决策树 |

---

## 5. 典型完整工作流

这是你最初设想的那条闭环，现在通过 MCP 全自动：

```
① 收到 PRD / 接口文档

② AI 在 IDE 里：
   → mockforge.create_module_from_spec({ spec })
   ← 拿到 mockBaseUrl（如 http://localhost:3000/mock/order）

③ AI 在业务代码里配代理，把 /api/order 打到 mockBaseUrl

④ AI 写业务代码
   → mockforge.get_openapi({ moduleName: 'order' })
   ← 生成 TypeScript 类型 + 请求客户端

⑤ AI 写业务测试，跑测试

⑥ 测试失败？AI 自动诊断：
   → mockforge.get_mock_access_log({ moduleName })
   ← 看业务代码真的发了什么、Mock 真的返回了什么
   → mockforge.diff_with_openapi({ moduleName, actualRequest, actualResponse })
   ← 得到 diff 列表

⑦ 根据 diff 分类处理：
   - missing-in-actual → 业务字段没传 → 改业务代码
   - missing-in-spec → 契约漏字段 → mockforge.update_module({ instruction })
   - type-mismatch → 看谁对改谁
   - status-mismatch → 改 Mock 或业务

⑧ mockforge.run_test({ moduleName })  ← 验证改动

⑨ 回 ④ 直到全绿

⑩ mockforge.generate_handoff_report({ moduleName })
   ← 把 Markdown 给后端团队
```

---

## 6. 长任务的进度反馈

`create_module_from_spec` 和 `update_module` 背后要跑 LLM，可能要 30 秒到 3 分钟。MCP 协议的 `progress notifications` 在执行期间推送 4 种阶段摘要：

- `thinking: {chars: N}` — AI 在思考（不泄漏内容）
- `writing: {chars: N}` — AI 在写文本
- `tool: {tool: 'write_file' | ...}` — AI 在调内部工具
- `module_update: {moduleName, status}` — 模块状态变化

Cursor / Claude Code 会把这些显示成"进行中"提示，不阻塞你做别的事。

---

## 7. 成本控制（软 warnings）

短期（24h）内对同一模块调 `update_module` 超过 10 次，返回会带：

```json
{
  "structuredContent": { ... },
  "warnings": [
    {
      "code": "HIGH_RETRY_COUNT",
      "message": "This module has been modified N times in the last 24h..."
    }
  ]
}
```

**不阻断**，只提示 AI 可能陷入错误循环。计数器进程重启清零（可接受）。

---

## 8. dry_run 预览

`create_module_from_spec` 和 `update_module` 都支持 `dry_run: true`：

```json
// create dry_run
{
  "structuredContent": {
    "moduleName": "order",
    "status": "would-create",
    "plan": {
      "kind": "openapi-derived",
      "entities": [{ "name": "order", "fields": ["orderNo","amount"] }],
      "endpoints": ["GET /orders", "POST /orders"]
    }
  }
}

// update dry_run
{
  "structuredContent": {
    "moduleName": "order",
    "status": "would-update",
    "instruction": "加一个 createdBy 字段",
    "currentEndpoints": ["GET /orders", ...]
  }
}
```

AI 可先预览，和用户确认后再不带 `dry_run` 正式跑。

---

## 9. 交接报告示例

`generate_handoff_report({ moduleName: 'order' })` 返回的 Markdown 大致结构：

```markdown
# 订单管理 Mock 交接报告

> 用户: 1 · 模块: order · 生成时间: 2026-04-21T...

## 契约概要
- Base Path: /mock/order
- 状态: active
- 端点清单
  - GET /mock/order/
  - POST /mock/order/
  - ...

### 实体与字段
**order**:
| 字段 | 类型 | 必填 |
|------|------|------|
| order_no | string | 是 |
| amount | number | 是 |
| ...

## 模块健康状态
- health: healthy
- 表: mock__order — 存在

## 访问日志摘要（最近 50 次）
共 127 条请求，状态码分布：`200×121, 400×4, 500×2`

| 端点 | 次数 | 平均耗时 (ms) |
| GET /mock/order/ | 78 | 12.3 |
| ...

### 错误请求（4xx/5xx）
...

## 后端交接建议
- 实现上述端点，响应结构遵循 { success, message, data } 信封...
- 列表端点按 { list, total, page, pageSize } 结构返回...
- 所有实体默认带 id / created_at / updated_at 三个字段
- ⚠ 注意：业务代码在测试期间产生了 4xx/5xx 请求，请核对...
```

直接粘给后端，对方就知道要实现什么、哪里有坑。

---

## 10. 常见问题

### 401 Unauthorized
- API Key 有没有带前后空白
- Key 是否已被吊销 / 重新生成（旧 Key 立即失效）
- Settings 页"上次使用"字段应该有更新

### 连不上 / ECONNREFUSED
- `curl http://localhost:3000/api/health` 应返回 `{"success":true,"data":"ok"}`
- Docker：确认容器端口映射（`docker ps`）

### AI 没调工具
- IDE 的 MCP 状态面板确认 mockforge 是 connected
- 在第一轮对话里明确引导："请先调 mockforge.list_modules 看看我有哪些模块"
- AI 应该已经通过 `mockforge://guide` 资源知道怎么用了

### create/update 花了 5 分钟还没回
- 正常。gemma/claude 在复杂模块上 2-5 分钟是常态
- 在 Web UI 的 Sessions 页能看到这条 `[MCP] create xxx` 会话的实时进度
- 想中断？Web UI 里点"暂停"即可

### Mock 返回 404 但模块我明明建了
- 跑 `get_module_health`，可能模块是 degraded（文件不全 / 表丢）
- 或者 moduleName 大小写错了（是区分大小写的）
- 尝试 `run_test` 看错在哪

---

## 11. 安全考虑

- **API Key = 账户全权限**，泄漏后他人可以 create/update/delete 你的任意模块
- Key 以 HMAC-SHA256 hash 存储；若服务器端 `MCP_API_KEY_SECRET` 丢失，所有 Key 会失效（等同强制吊销）
- `generate_handoff_report` 包含访问日志的完整请求/响应（已截断 8KB），**若日志里可能有 PII 数据，交出报告前自行检查**
- 生产部署建议加反向代理 + HTTPS，不要把 `/mcp` 公网裸露

---

## 12. 规范契约与模型切换（Step-MCP-3）

### 12.1 mock-router 不再强制 404

**旧行为**（已移除）：controller 返 `{ success: false }` 时被映射成 404。
**新行为**：mock-router 是透明传输层，controller 返回值是权威的：

| controller 返回 | HTTP 状态 |
|----------------|---------|
| `{ success: true, data }` | 200 |
| `{ success: false, message }` | **200**（业务校验失败，默认） |
| `{ success: false, message, statusCode: 422 }` | 422 |
| `{ success: false, statusCode: 404 }` | 404 |
| `{ code: 0, data, msg }`（阿里风格） | 200 |
| `{ __mock__: { status: 303, headers: { Location }, body: null } }` | 303（逃生舱） |

`statusCode` 字段会被 mock-router 消费（不会出现在 response body）。`__mock__` 逃生舱可完全自定义响应，包含重定向 / 文件下载 / 自定义 header 等。

### 12.2 规范决策流程（AI 遵循的硬规则）

对**每一项规范**（响应信封 / 字段命名 / 分页参数 / 状态码策略 / 错误码体系 等），AI 按以下优先级**独立**决策：

1. **用户本次 spec/instruction 明确提及** → 无条件按用户
2. **项目预设里有** → 按预设
3. **否则** → 最佳实践默认

禁止折中、禁止擅自补充、禁止曲解、禁止同项混合。AI 在生成前必须在 thinking 里填"决策对账表"；若用户和预设冲突，最终回复末尾会出现"已优先采用你的指令（忽略 preset.X）"的声明。

### 12.3 provider / model / preset 覆盖

`create_module_from_spec` / `update_module` 可选参数：

```jsonc
{
  "spec": "...",
  "provider": 2,              // 使用 id=2 的 provider（覆盖自动选择）
  "model": "gpt-4o-mini",     // 覆盖 provider 默认模型
  "preset": "aliyun-style"    // 按名字锁定预设；或传数字 id
}
```

用法场景：
- IDE 里的 AI 明确要用"阿里风格"（snake_case + `{code, data, msg}`）生成时：`preset: 'aliyun-style'`
- 想换一个更便宜/更快的模型临时跑：`provider: X, model: 'gpt-4o-mini'`
- 不传 → 沿用自动选择（scope=public 免费 provider 优先），与 MCP-2 行为一致

### 12.4 Web UI 的选择器

- 新建对话按钮现在会弹 dialog，可选 provider / model / preset，或直接"跳过默认"用系统选择
- 对话输入框上方的 meta-bar 显示"{provider} · {model} · {preset}"，点击可中途切换；生成进行中会禁用，等本轮结束即可改
- 所有选择都存 localStorage，下次预填

---

## 13. 业务约束建模(Step-MCP-4)

### 13.1 _meta.json 字段级约束

每个字段都可以加约束;运行时 (BaseModel) + 契约 (OpenAPI) + 对账 (diff_with_openapi) 三处自动同步。

```jsonc
"fields": [
  {
    "name": "sku", "type": "string", "displayName": "SKU",
    "required": true, "unique": true,
    "pattern": "^[A-Z0-9-]{3,32}$"
  },
  {
    "name": "qty", "type": "integer", "displayName": "数量",
    "required": true, "min": 0, "max": 100000
  },
  {
    "name": "status", "type": "string", "displayName": "状态",
    "enum": ["in_stock", "low_stock", "out_of_stock"],
    "default": "in_stock"
  }
]
```

| 约束 | 字段 | 例 |
|------|------|----|
| 必填 | `required: true` | sku |
| 枚举 | `enum: [...]` | status |
| 数值范围 | `min` / `max` | qty 0-100000 |
| 字符串长度 | `minLength` / `maxLength` | code 3-32 |
| 字符串格式 | `pattern` (正则) | sku ^[A-Z0-9-]{3,32}$ |
| 唯一性 | `unique: true` | sku |
| 默认值 | `default` | status='in_stock' |

旧字段 `enumValues` / `defaultValue` 仍然兼容(新代码统一读 `enum` / `default`)。

### 13.2 entity.constraints 跨字段规则

```jsonc
"constraints": [
  {
    "id": "qty-zero-status",
    "when": { "qty": 0 },
    "must": { "status": "out_of_stock" },
    "message": "数量为 0 时,状态必须为 out_of_stock"
  },
  {
    "id": "low-stock",
    "when": { "qty": { "gt": 0, "lte": 10 } },
    "must": { "status": "low_stock" },
    "message": "数量 ≤10 (>0) 时必须 low_stock"
  }
]
```

`when` / `must` 中每个条件可以是字面值(等于),或 `{ eq, neq, gt, gte, lt, lte, in }` 范围对象。

### 13.3 三处自动同步

**1. 运行时**(`BaseModel.withMeta()`): controller 用 `new BaseModel('mock__x').withMeta('moduleName')`,POST/PUT 时自动校验,违反抛 `ValidationError`,模板 try/catch 转 `{ success:false, message, statusCode: 400 }`。

**2. OpenAPI** (`get_openapi`):
- field.enum → `schema.enum`
- field.min/max → `schema.minimum/maximum`
- field.pattern → `schema.pattern`
- entity.constraints → POST/PUT/PATCH endpoint description 末尾 markdown 块

**3. 对账** (`diff_with_openapi`): 喂入实际请求,新增 diff kinds:
- `constraint-violation`: enum/min/max/pattern 单字段违反
- `cross-field-violation`: 跨字段 when/must 不满足

### 13.4 update_module 富 diff

旧版只识别 entity/field/endpoint 增删;现在的 diff 还包含:
- `+constraint <id>` / `-constraint <id>`
- `+test "<name>"` / `-test "<name>"`
- warnings: `controller.ts changed (bytes ±N, error-branches ±M)` / `api-doc.md ±N lines`
- 显式 `hasChange=false` + 提示文字: AI 没真改任何东西时立即可见

### 13.5 优先级

AI 在生成时遵循的硬规则:
1. **优先**把字段约束写进 `_meta.json` field
2. **跨字段规则** 写进 `entity.constraints`
3. **复杂业务流转** (状态机、关联) 才在 controller.ts 手写

不允许在 controller.ts 重复写 if-throw 校验代码 — 那会导致 OpenAPI 看不到约束、对账工具检测不到违反。

---

## 14. 单模块单流程 + 自动续接（Step-MCP-5）

> 背景:AI Agent 跑 `update_module` 时,客户端 transport 常在 5-10min 的长任务里 timeout,旧方案需要用户重新开 IDE。Step-MCP-5 把这个体验改成**"重发即续接"** — AI 重新调 `update_module` 就自动 attach 到在跑的 session,语义跟普通调用一样。

### 14.1 新参数:`waitMaxSec` + `onConflict`

`create_module_from_spec` / `update_module` 新增两个参数:

- **`waitMaxSec`** (默认 60,上限 300):本次调用最多阻塞多久。到期仍在跑 → 返 `{ status:"still-running", sessionId, stage, elapsedSec }`,runner 在后台继续跑。
- **`onConflict`** (默认 `'resume'`):
  - `'resume'` — 有 in-flight 就 attach 上去(默认行为,95% 场景最舒服)
  - `'reject'` — 有 in-flight 就返 `MOCKFORGE_ALREADY_PROCESSING`
  - `'replace'` — 有 in-flight 就 cancel 旧的 + 启新

### 14.2 典型流程

```text
// 新建 / 修改模块 — 一行调用即完成 (or 续接)
r = update_module({ moduleName: 'warehouse', instruction: '...' })

if (r.status === 'updated') {
  // 成功,拿 diff / endpoints
} else if (r.status === 'still-running') {
  // 没完,直接再调一次同样的 — server 自动 attach 到同一 session
  r = update_module({ moduleName: 'warehouse', instruction: '...' })
}
```

### 14.3 客户端 timeout 的行为

AI(IDE client)的 HTTP transport 断了不影响 server 端。重发同参数 `update_module`:
- Server 检测到 in-flight session
- 默认 attach,返回 `{ attached: true, sessionId, status }`
- 持续直到拿到 `status:"updated"`

### 14.4 不同 instruction 重发的警告

默认 `'resume'` 下,对同一 moduleName 发不同 instruction 仍会 attach 到旧 session:

```jsonc
{
  "attached": true,
  "actualInstruction": "add a location field",   // 原始 instruction
  "yourInstruction":   "add a status field",     // 本次 instruction
  "warning": "Note: your instruction differs from what's actually executing..."
}
```

Normalize 后比较(trim + 折空白 + 大小写无关);不一致就 warning,**永远不阻断**。如果要"我改主意,一步到位",传 `onConflict: 'replace'` cancel 旧的启新。

### 14.5 会话工具 `get_session_status` + `cancel_session`

```jsonc
// 非阻塞 5ms 快照(不 attach)
get_session_status({ sessionId })
→ {
    status: 'running' | 'done' | 'error' | 'paused' | 'aborted',
    stage: 'writing controller.ts',
    elapsedSec: 145,
    lastEventSeq: 87,
    recentEvents: [...]
  }

// 主动放弃
cancel_session({ sessionId })
→ { status: 'aborted', wasLive: true, elapsedBeforeCancel: 145 }
```

### 14.6 并发限制

为避免 AI 误重试爆炸:
- **per-user**:3(环境变量 `MCP_USER_CONCURRENCY_LIMIT`)
- **全局**:10(环境变量 `MCP_GLOBAL_CONCURRENCY_LIMIT`)
- 超限返 `MOCKFORGE_BUSY`,响应里 `runningSessions` 列出在跑的 session 让 AI 自己决定
- **attach 不计数**(重发不会触发 BUSY)

### 14.7 心跳 keepalive

ChatRunner 启动后每 `CHAT_HEARTBEAT_MS` 毫秒(默认 30000,0 禁用)强发一条 `heartbeat` 事件,通过 MCP progress notification 透传给 client。主流 IDE client transport tolerate 60s idle,30s 留 50% 余量,保证长任务不会因 idle 断连。

### 14.8 统一错误码

所有工具的 `isError` 响应 `structuredContent` 现在都带 `code` + `hint`:

| Code | 场景 | Hint 举例 |
|------|------|----------|
| `MOCKFORGE_BUSY` | 并发超限 | 看 runningSessions,等 或 cancel_session |
| `MOCKFORGE_ALREADY_PROCESSING` | onConflict=reject 且有 in-flight | 改为 resume / replace |
| `MOCKFORGE_MODULE_NOT_FOUND` | moduleName 错 | list_modules 看清单 |
| `MOCKFORGE_SESSION_NOT_FOUND` | sessionId 错 | 检查 Key / sessionId |
| `MOCKFORGE_NO_PROVIDER` | server 没配 provider | Settings → Providers 配置 |
| `MOCKFORGE_VALIDATION_FAILED` | 参数 / 校验失败 | get_openapi 看契约 |
| `MOCKFORGE_WAIT_TIMEOUT` | 写工具非 done 终态 | 查 session,重试 |
| `MOCKFORGE_INTERNAL_ERROR` | server 内部错 | 查日志 |

---

## 15. 为什么变快了 (Step-Perf-1)

Step-MCP-5 解决了"断线续接"让长任务不再抓瞎,但 7-15 min 的绝对时长仍然劝退。Step-Perf-1 把绝对速度砍下来:

### 15.1 system prompt 瘦身 60%

原 18KB 的 system prompt 包含 120 行硬编码 todo 模块 6 文件模板。每次 LLM 调用都完整发送。瘦到 ~7KB,模板搬到 `get_module_template(kind: 'crud-basic' | 'with-constraints')` Agent 工具,AI 不熟悉时再按需拉。

**收益**:每 round 请求 payload ↓60%,transport 时间 ↓20-30%,token 成本同比例下降。

### 15.2 批量 write_files 替代单文件 write_file

**改造前**:AI 生成一个模块要 5-6 次 \`write_file\` tool-call(每次一个文件),= 5-6 次 LLM round-trip × ~60-90s/次 ≈ 7-9 分钟。

**改造后**:新工具 \`write_files({ files: [{path, content}, ...] })\` 一次调用写完 N 个文件,事务语义(failed rollback fs+DB),**5-6 次 round-trip → 1 次**。

\`\`\`ts
// AI 现在通常这样跑:
write_files({
  files: [
    { path: 'order/_meta.json', content: '...' },
    { path: 'order/schema.sql', content: '...' },
    { path: 'order/controller.ts', content: '...' },
    { path: 'order/test.ts', content: '...' },
    { path: 'order/api-doc.md', content: '...' },
  ]
})
// 一次返 { success, filesWritten: 5, perFile: [...] }
\`\`\`

**收益**:总时长 ↓60%,从 7-15 min → 预计 3-5 min。

### 15.3 Provider-aware Prompt Caching

按 provider.type 自动走不同缓存路径:
- **Anthropic**:注入 \`providerOptions.anthropic.cacheControl: { type: 'ephemeral' }\` 显式标记 system + tools 前缀
- **OpenAI-compat**(含 Doubao / DeepSeek):后端自动缓存匹配前缀;本代码库已保证 system + tools 前缀字节稳定(PC05 测试)

**Kill switch**:\`ENABLE_PROMPT_CACHE=0\` 环境变量一键关闭显式标记(后端自动缓存仍工作)。

**收益**:token 成本命中时 ↓70%,首 token 延迟 ↓30-50%。

### 15.4 MCP 工具合并 14 → 12

原 \`get_api_doc\` / \`get_openapi\` / \`get_module_health\` 三个读工具语义高度重叠;合并为 \`inspect_module(moduleName, view?)\`,view 可选 \`'all' | 'doc' | 'openapi' | 'health'\`(默认 all)。

\`\`\`ts
// 一次拿全部
inspect_module({ moduleName: 'order' })
// → { doc: { markdown }, openapi: { spec }, health: { status, missingFiles, ... } }

// 想窄
inspect_module({ moduleName: 'order', view: 'openapi' })
\`\`\`

**收益**:AI 选择工具更简单;一次 round-trip 拿全信息;guide 内容缩减。

### 15.5 Humanized 进度 + Machine-actionable 错误

- **进度**:MCP progress notification \`message\` 从 "tool:write_files" 变为"正在批量写入模块文件"(\`stage-humanize.ts\` 映射)
- **still-running 响应**:新增 \`stageDescription\`(中文)+ \`expectedRemainingSec\`(粗略预估)+ \`suggestedNextAction\`(AI-facing 英文动作建议)
- **错误文本前缀**:每条 mcpError text 以 \`[MOCKFORGE_XXX]\` 开头,AI 扫描分支更快
- **error recovery_steps**:每个错误 \`structuredContent\` 带 \`recovery_steps: Array<{ tool, args, description } | { action, description }>\` — AI 无需解析自然语言,直接按步骤调下一个工具

\`\`\`jsonc
// 示例:MODULE_NOT_FOUND 错误
{
  "code": "MOCKFORGE_MODULE_NOT_FOUND",
  "message": "Module 'foo' not found.",
  "hint": "Call list_modules to see available modules",
  "recovery_steps": [
    { "tool": "list_modules", "description": "列出所有可用模块" },
    { "tool": "create_module_from_spec", "args": { "moduleName": "foo", "spec": "<your-spec>" },
      "description": "用新 spec 创建 foo" }
  ]
}
\`\`\`

### 15.6 per-session Mutex + 并行读

AI 若同一轮 emit 多个 tool-call:
- **读类**(\`read_file\` / \`list_modules\` / \`get_module_template\` / \`inspect_module\`):真正并行
- **写类**(\`write_files\` / \`run_test\` / \`manage_data\` / \`delete_module\`):同 session 内串行(session-mutex),跨 session 互不阻塞

**收益**:读 / 诊断阶段可以 parallel 执行,跨 session 负载不增。

---

## 16. 模型选型建议 (Step-Perf-2)

MockForge 的 Agent tool schema 包含嵌套数组(如 `write_files({ files: [...]})`)。不同模型对嵌套 schema 的填充能力差异巨大:

| 模型 | write_files 能力 | 推荐用法 |
|-----|-----------------|---------|
| Claude Sonnet / Opus | ✅ 稳定 | 直接用 write_files 批量写 |
| GPT-4 / GPT-4o | ✅ 稳定 | 直接用 write_files 批量写 |
| Gemini Pro 1.5+ | ✅ 多数场景 | 直接用 write_files |
| DeepSeek V2 big | ✅ 稳定 | 直接用 write_files |
| **gemma-4-31B / DeepSeek small** | ⚠️ 易失败 | AI 会自动退回 write_file 单文件写 |
| **Qwen 7B / 小型本地模型** | ❌ 不推荐 | 可能完全无法正确填任何 tool schema |

系统已兼容弱模型:若 AI 调 `write_files` 拿到 "no files provided" 错误,会被提示切换 `write_file(path, content)` 单文件循环调用。虽然慢一些(5-6 次 LLM 往返代替 1 次),但能成功。

## 17. 路线图

| 版本 | 状态 | 能力 |
|------|------|------|
| Step-MCP-1 | ✅ | 只读工具 + API Key + guide |
| Step-MCP-2 | ✅ | 写工具 + 业务侧感知 + 交接报告 + progress notifications + 软 warnings + dry_run |
| Step-MCP-3 | ✅ | mock-router 放权 + 规范决策硬规则 + provider/model/preset 覆盖 + Web UI 选择器 |
| Step-MCP-4 | ✅ | _meta.json 约束建模 + OpenAPI 映射 + BaseModel auto-validate + diff 富化 |
| Step-MCP-5 | ✅ | 单模块单流程 + 自动续接 + 并发 gate + heartbeat + 统一错误码 |
| Step-Perf-1 | ✅ | system prompt 瘦身 60% + batch write_files + prompt caching + 工具合并 14→12 + humanized 进度 + recovery_steps |
| Step-Perf-2 | ✅(当前) | 恢复 write_file(弱模型退回) + default waitMaxSec 60→180s + stepCountIs 20→40 + 真实 LLM E2E 验收门槛 |
| 未来 | — | 模型能力探测(自动 fallback)、模块生成结果缓存、sampling、thinking 预算自适应、细粒度 Key 权限 |

更详细的设计和决策记录见 [`ANALYSIS-AI-DEV-WORKFLOW.md`](../ANALYSIS-AI-DEV-WORKFLOW.md) 和 `CURSOR.md` 的 Step-MCP-{1,2,3,4,5} / Step-Perf-{1,2} 章节。
