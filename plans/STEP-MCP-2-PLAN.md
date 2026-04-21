# Step-MCP-2: MCP 写能力 + 业务侧感知 + 交接报告（完整剩余工作）

> 状态：待执行
> 目标：把 MockForge 的"读写全能力"通过 MCP 暴露给 IDE AI，完成你最初设想的整条闭环：
> PRD → 契约 → Mock → 业务代码 → 自测 → 修复 → 交接报告
> 预估：2-3 天

---

## 一、范围

本 Step 一次性吃掉 Step-MCP-1 之后所有剩余工作。划分为三组能力：

### 组 A：写工具（让 MCP 端 AI 能创建/改动 Mock）
- `create_module_from_spec` — 基于 OpenAPI / 自然语言 spec 生成模块
- `update_module` — 修改已有模块（加字段、改逻辑、补端点）
- `delete_module` — 删模块
- `run_test` — 跑模块的 test.ts 回归
- `manage_data` — insert / bulk_generate / delete / clear 数据
- `get_module_health` — 诊断模块健康度

### 组 B：业务侧感知（让 MCP 端 AI 能"看见" Mock 被怎么用）
- **mock-router 补 access log 写入**（前置：mock_requests 表现在是空壳）
- `get_mock_access_log` — 查某模块最近 N 次 /mock/* 请求
- `diff_with_openapi` — 把实际请求/响应与契约 diff，输出差异点

### 组 C：增强与收尾
- **MCP progress notifications**（create/update 长任务用）
- **软 warnings**（retry counter，成本失控防呆）
- **dry_run** 参数（create/update 支持预览）
- `generate_handoff_report` — 基于 sessions + access_log + 契约输出交接 markdown
- `update_module` / `create_module_from_spec` 创建的 session **在 Web UI 可见并可接管**（天然由共享 sessions 表实现）
- guide Resource 更新描述（移除 "v1 只读" 语，加新工具决策树）
- docs/mcp-usage.md 更新
- **完整回归全绿**

### 本 Step **不做**
- stdio transport（Docker 场景 HTTP 已足够，永不做）
- 细粒度 API Key 权限（读/写/admin 分级 — 留 v3 或按需求再评）

---

## 二、核心架构决策

### 2.1 headless session 机制（create/update 的基础设施）

MCP 端 AI 触发生成时，我们**不起一个新的独立进程/独立流**，而是：

1. MCP 工具内部 **INSERT 一条新 sessions 行**（title 形如 `[MCP] create order`，userId = 当前 MCP 用户，providerId = 用户配置的第一个 provider，model = 默认）
2. 调 `ChatRunner.getOrCreate(sessionId).start({ userId, userContent })`
3. 用 `subscribe(afterSeq=0)` 订阅事件流，**同步等到 `done` / `error` / `paused` 事件再返回**
4. 期间通过 MCP progress notifications 向 client 推送阶段进度（thinking / tool_call / card）

效果：
- Web UI **天然能看到这个 session**（共享 sessions 表），可点进去看 AI 怎么做的，也可以暂停、接管
- MCP client 等待 3-10 分钟，全程有进度反馈，超时就按 MCP 协议的重连策略处理

关键 helper 放在 `src/server/mcp/lib/headless-session.ts`：

```ts
export async function runHeadlessSession(opts: {
  userId: number;
  userContent: string;
  title: string;
  onProgress?: (seq: number, type: string, payload: any) => void;
  signal?: AbortSignal;
}): Promise<{ sessionId: string; status: 'done'|'error'|'paused'; events: StreamEvent[] }>
```

### 2.2 progress 事件映射

ChatRunner 已有的 StreamEvent → MCP notification:

| StreamEvent.type | MCP progress payload | 何时推 |
|------------------|----------------------|--------|
| `thinking` | `{stage: 'thinking', chars: N}` | 每批 flush |
| `text` | `{stage: 'writing', chars: N}` | 每批 flush（不泄漏内容） |
| `tool_call` | `{stage: 'tool', tool: toolName}` | 调用工具时 |
| `card` | `{stage: 'module_update', moduleName, status}` | 模块卡片事件 |

**不原样转发 text/thinking 内容**，只转发阶段摘要（保持 v1 "不泄漏文件名/表名"的约束一致）。

### 2.3 软 warnings / retry counter

内存中维护 `Map<"userId:moduleName", { count: number; firstAt: number }>`，每次 update_module 成功 +1，24h 内超过 10 次则在返回里带：

```json
{
  "structuredContent": { ...normal output },
  "warnings": [
    { "code": "HIGH_RETRY_COUNT", "message": "此模块 24h 内已改 11 次，建议人工检查是否陷入错误循环" }
  ]
}
```

**不硬阻断**，只提示。counter 进程重启清零（可接受）。

### 2.4 dry_run 语义

`create_module_from_spec({ spec, dry_run: true })` → 不起 ChatRunner，返回计划预览：

```json
{
  "structuredContent": {
    "plan": {
      "moduleName": "order",
      "entities": [...],
      "endpoints": [...],
      "filesToWrite": ["_meta.json","schema.sql","controller.ts","test.ts","api-doc.md"]
    }
  }
}
```

纯函数解析 spec，不动 DB / FS。AI 预览确认后再 `dry_run: false` 正式跑。

### 2.5 mock_requests 写入（access log 基础）

在 `src/server/core/mock-router.ts` handler 执行后：

```ts
const start = Date.now();
const response = await handler(...);  // 已存在
const duration = Date.now() - start;

db.insert(mockRequests).values({
  userId, moduleName, method, path,
  statusCode: response.status ?? 200,
  durationMs: duration,
  requestBody: JSON.stringify(bodySafe),
  responseBody: JSON.stringify(response.body).slice(0, 8000), // 截断防炸
}).run();
```

注意：
- 只记录 `/mock/*` 路由，不记录 `/api/*` 或 `/mcp`
- 响应 body 截断到 8KB
- 容错：记录失败不影响业务响应（try/catch 吞掉）

---

## 三、Task 拆分（13 个）

每个 Task 独立 commit；每个 Task 自测通过 + 单元/集成测试覆盖后才进下一个。

### Task 2.1 — mock-router 补 access log 写入（**前置**）

**文件**：`src/server/core/mock-router.ts`

**内容**：
- handler 外包 try/finally 测 duration
- finally 里 `db.insert(mockRequests)`，异常 swallow
- requestBody 对 multipart/binary 做安全处理（跳过 / 标记 "<binary>")
- 响应 body 截断 8KB

**验收**：
- `curl http://localhost:3000/mock/user` → 查 `mock_requests` 表看到新行
- 一个新 spec 测试 `tests/mock-access-log.spec.ts`：发 5 个不同请求，验证表里有 5 条记录、字段齐全
- 完整回归通过（确认不破坏现有 /mock/* 行为）

**commit**：`Step-MCP-2.1: record /mock/* requests to access log`

---

### Task 2.2 — `get_mock_access_log` + `get_module_health`

**文件**：
- `src/server/mcp/tools/get-mock-access-log.ts`
- `src/server/mcp/tools/get-module-health.ts`
- 更新 `src/server/mcp/tools/index.ts`

**`get_mock_access_log` schema**：
```
input:  { moduleName: string, limit?: number (default 20, max 100), sinceMinutes?: number }
output: { logs: Array<{method, path, statusCode, durationMs, requestBody, responseBody, createdAt}>, total: number }
```
按 `created_at DESC` 排序，limit clamp 到 100。

**`get_module_health` schema**：
```
input:  { moduleName: string }
output: { health: 'healthy'|'degraded'|'missing', details: {...}, missingFiles: string[] }
```
直接包装 `core/module-health.ts` 的 `computeModuleHealth`。

**验收**：集成测试 2 条。

**commit**：`Step-MCP-2.2: get_mock_access_log + get_module_health MCP tools`

---

### Task 2.3 — `diff_with_openapi`

**文件**：`src/server/mcp/tools/diff-with-openapi.ts`

**Schema**：
```
input: {
  moduleName: string,
  actualRequest?: { method: string, path: string, body?: object },
  actualResponse?: { statusCode?: number, body?: object }
}
output: {
  aligned: boolean,
  diffs: Array<{
    path: string,  // e.g. "response.data.items[0].createdBy"
    kind: 'missing-in-actual'|'missing-in-spec'|'type-mismatch'|'status-mismatch',
    spec?: any,
    actual?: any
  }>
}
```

**实现**：
- 读模块 OpenAPI（复用 `buildOpenApi`）
- 匹配 actualRequest.method + path → 找到对应 operation
- 递归对比 response schema vs actualResponse.body（字段存在性 + 类型 family）
- 纯函数，无副作用

**验收**：单元测试 5 条（匹配成功/失败/字段缺失/类型不匹配/status 不匹配）。

**commit**：`Step-MCP-2.3: diff_with_openapi MCP tool`

---

### Task 2.4 — 轻量写工具：`delete_module` / `run_test` / `manage_data`

**文件**：
- `src/server/mcp/tools/delete-module.ts`
- `src/server/mcp/tools/run-test.ts`
- `src/server/mcp/tools/manage-data.ts`

全部是**直接包装** `src/server/agent/tools/` 下对应实现（换成从 `getMcpUserId()` 取 userId）。

**manage_data schema**（对齐 agent 实现）：
```
input: {
  action: 'insert'|'bulk_generate'|'delete'|'clear'|'list'|'update'|'batch_delete',
  moduleName: string,
  data?: object, count?: number, id?: number, entityName?: string
}
```

**验收**：每个工具 1-2 条集成测试，共 5 条。

**commit**：`Step-MCP-2.4: delete_module / run_test / manage_data MCP tools`

---

### Task 2.5 — headless session helper

**文件**：`src/server/mcp/lib/headless-session.ts`

**内容**：
- `runHeadlessSession({ userId, userContent, title, onProgress, signal })`：
  1. 选 provider（用户的第一个 active provider；无则抛错）
  2. `db.insert(sessions)` 新行，`runStatus='running'`, `title=title`
  3. `ChatRunner.getOrCreate(sessionId).start({ userId, userContent })`
  4. `for await (const ev of runner.subscribe(0))`：
     - 若 `onProgress` 在：调它（传 seq/type/payload）
     - 收集到 events 数组
     - 命中 done/error/paused 就 break
  5. 返回 `{ sessionId, status, events }`
- 处理 AbortSignal（client 取消时 runner.pause）
- 超时控制沿用 runner 的 10min RUN_TIMEOUT_MS

**验收**：单元测试 1 条（mock 一个极简 runner 验证事件循环）+ 集成测试 1 条（跑真实小 spec 验证 10s 内完成）。

**commit**：`Step-MCP-2.5: headless session helper for MCP`

---

### Task 2.6 — `create_module_from_spec`（含 progress + dry_run）

**文件**：`src/server/mcp/tools/create-module-from-spec.ts`

**Schema**：
```
input: {
  spec: string,  // 可以是 OpenAPI JSON 字符串 / YAML / 纯自然语言描述
  moduleName?: string,  // 不填则由 AI 从 spec 推断
  dry_run?: boolean (default false)
}
output: {
  moduleName: string,
  status: 'created'|'would-create',
  sessionId: string,   // dry_run 时为空
  endpoints: string[],
  apiDoc: string,       // 前 500 字预览
  mockBaseUrl: string,
  warnings?: Warning[]
}
```

**实现**：
- dry_run：解析 spec（json/yaml/纯文本分发），返回预览结构
- 正式跑：
  - 拼 userContent = "根据下面的 API 规范生成一个 Mock 模块。模块名：xxx\n\n{spec 内容}"
  - 调 `runHeadlessSession`，把 `{stage, ...}` 通过 `_meta.progressToken` 触发的 MCP progress notification 推给 client
  - 等 done 事件后读生成的 `_meta.json` / `api-doc.md` 返回摘要
  - retry counter 接入

**MCP progress 接入细节**：
- ToolCallback 的第二个参数 `extra` 里有 `sendNotification` 方法（MCP SDK 2025 协议），用它推 `notifications/progress`
- 参照 SDK 文档 progress token 机制

**验收**：
- 集成测试：dry_run 返回计划、正式跑生成模块、模块通过 `list_modules` 看得到
- Web UI 手测：MCP 发起的 session 在 ChatPage 可见

**commit**：`Step-MCP-2.6: create_module_from_spec with progress notifications + dry_run`

---

### Task 2.7 — `update_module`（同 2.6 机制）

**文件**：`src/server/mcp/tools/update-module.ts`

**Schema**：
```
input: {
  moduleName: string,
  instruction: string,   // 自然语言改动描述
  dry_run?: boolean
}
output: { moduleName, status: 'updated'|'would-update', sessionId, diff: string[], warnings? }
```

**实现**：同 2.6，但初始 userContent = "修改已有模块 {moduleName}：{instruction}"，且需先校验模块存在。

**diff 字段**：比较 update 前后的 `_meta.json`（字段新增 / 端点新增 / 字段删除），返回 string[] 摘要。

**验收**：集成测试 2 条（小 diff 场景 + dry_run）。

**commit**：`Step-MCP-2.7: update_module`

---

### Task 2.8 — retry counter 软 warnings

**文件**：
- `src/server/mcp/lib/retry-counter.ts`（新）
- 接入 `create-module-from-spec.ts` / `update-module.ts`

**逻辑**：
- 进程内存 Map，key = `${userId}:${moduleName}:${tool}`
- `increment(key)`、`shouldWarn(key)`（24h 内 >= 10 次）
- `reset(key)`（模块被删除时调）

**验收**：单元测试 3 条（无 warn → warn → 重置）。

**commit**：`Step-MCP-2.8: retry counter + soft warnings`

---

### Task 2.9 — `generate_handoff_report`

**文件**：`src/server/mcp/tools/generate-handoff-report.ts`

**Schema**：
```
input: { moduleName: string }
output: { moduleName, markdown: string }
```

**markdown 内容模板**（按 ANALYSIS-AI-DEV-WORKFLOW.md 5.2 ④ 的结构）：
```
# {moduleName} Mock 交接报告

## 契约概要
（从 _meta.json + OpenAPI 提取：端点清单、核心字段）

## 模块健康状态
{health report}

## 访问日志摘要（最近 50 次）
| 方法 | 路径 | 状态 | 耗时 | 时间 |
...

## 检测到的契约偏差
（基于 mock_requests 与 OpenAPI 做快速 diff，列出 3-5 条最常见偏差）

## 后端交接建议
（根据偏差 + endpoints 列出后端需确认/实现的点）
```

**实现**：组合 `readModuleMeta` + `buildOpenApi` + `computeModuleHealth` + `mock_requests` 查询 + `diff_with_openapi` 批量。纯计算，无副作用。

**验收**：集成测试 1 条（造几条访问记录后生成报告，断言包含关键 section）。

**commit**：`Step-MCP-2.9: generate_handoff_report`

---

### Task 2.10 — 更新工具索引 + guide Resource

**文件**：
- `src/server/mcp/tools/index.ts`
- `src/server/mcp/resources/guide.ts`

**guide 更新要点**：
- 移除 "v1：只读" 字样
- 把可用工具表扩到 11 个
- 加工作流决策树：
  ```
  开始需求
    → list_modules（看有无复用的）
    → (没有) create_module_from_spec → get_openapi → 写业务代码
    → 跑业务测试 → 失败？
        → get_mock_access_log（看 Mock 收到什么）
        → diff_with_openapi（定位契约偏差）
        → 根因定位后：
           - Mock 错 → update_module
           - 业务错 → 自己改
        → 回到跑测试
    → 测试过 → generate_handoff_report → 交给后端
  ```

**验收**：引用的 11 个工具全部可在 `tools/list` 看到。

**commit**：`Step-MCP-2.10: expose all tools + updated guide resource`

---

### Task 2.11 — 集成测试套件补齐

**文件**：`tests/mcp-server-v2.spec.ts`（新文件，保持与 mcp-server.spec.ts 分开）

**覆盖用例**（共 ~15 条）：
- Access log：`M11` mock-router 记录请求、`M12` get_mock_access_log 返回正确顺序/字段
- Health：`M13` get_module_health healthy 场景、`M14` missing 场景
- Diff：`M15` aligned 场景、`M16` 字段缺失、`M17` status 不匹配
- 轻量写：`M18` delete_module（两步：先建 dummy 模块再删）、`M19` run_test 通过、`M20` manage_data bulk_generate
- Create：`M21` dry_run 返回 plan、`M22` 正式跑生成模块并可 list（**需要真实 provider，环境变量**；无 AI key 时 skip）
- Update：`M23` dry_run、`M24` 正式跑（同上）
- Handoff report：`M25` 含所有 section

**策略**：
- 依赖 LLM 的测试（M22/M24）用 `test.skip(!process.env.DEFAULT_AI_API_KEY, ...)` 门控
- 其他所有测试必须绿

**验收**：本 Spec 全绿（或 skip 明确说明）。

**commit**：`Step-MCP-2.11: integration tests for MCP v2`

---

### Task 2.12 — 更新 docs/mcp-usage.md

**内容**：
- 移除"v1 只读"说明
- 增加"典型完整工作流"章节：从 PRD 到交接报告的端到端示例
- 新增 11 个工具的完整参考
- 新增"进度反馈"说明（progress notifications）
- 新增"成本控制"说明（软 warnings）
- 新增"交接报告"示例

**验收**：文档自洽，引用工具与实际一致。

**commit**：`Step-MCP-2.12: update MCP usage docs`

---

### Task 2.13 — 集成验收 + 完整回归 + CURSOR/PROGRESS 更新

1. 跑完整 Playwright 套件，所有测试 100% 绿（除已知 flaky R11b、responsive 移动端）
2. **端到端手测**：
   - IDE 里用 MCP 真实跑一次 `create_module_from_spec` → `get_openapi` → `get_mock_access_log` → `update_module` → `generate_handoff_report` 全流程
   - 过程中 Web UI 能看到 MCP 开的 session
3. 更新 `CURSOR.md`：加 Step-MCP-2 章节
4. 更新 `PROGRESS.md`：Phase 6 加 Step-MCP-2 标记完成
5. 删除 `plans/STEP-MCP-2-PLAN.md`

**commit**：`Step-MCP-2: acceptance, full regression, progress bookkeeping`

---

## 四、关键风险与预案

| 风险 | 预案 |
|------|------|
| ChatRunner 桥接时 subscribe 事件流被 flaky 处理打断 | headless-session 实现里做重试 + 明确 timeout；单元测试 mock 事件流验证循环 |
| MCP progress notifications SDK 文档少 | Task 2.6 先做 spike：发一个假 progress，确认 Cursor/Claude Code 能收到；收不到就退化到"最终一次性返回"，但保证不卡住 |
| 创建模块依赖真实 LLM，测试可能不稳定 | **用户已确认直接使用 admin 配置的免费模型（gemma-4-31b-it），测试不 skip，真实跑** |
| mock_requests 表爆炸（长期堆积） | **用户已确认：按用户滚动 cap 最新 10000 条**。Task 2.1 里每次插入后 trim 超出部分 |
| retry counter 进程重启丢失 | 可接受。文档说明 |

## 五、CLAUDE.md 协议遵守

- 每个 Task 独立 commit，Task 内失败最多 3 轮自修，超出暂停报告
- Task 2.13 之前**不宣布 Step 完成**；其中完整回归 100% 绿是硬门槛
- Step 完成后：删除子计划 + 更新 CURSOR/PROGRESS + `/compact`
- 遇到范围外需求（如 stdio transport 临时要加）→ 停，先扩计划再动手
