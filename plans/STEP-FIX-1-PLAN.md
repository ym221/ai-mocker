# Step-Fix-1: MCP 真实 LLM E2E 修复计划

## 背景

2026-04-24 用户通过 MCP（localhost:3000/mcp，X-API-Key）完整跑了一次 `仓储管理` 生成测试，暴露 4 类问题。本计划针对每一类给出最小闭环修复，并以"**同一条 MCP 调用再跑一遍全绿**"作为硬验收门槛，不通过不算完。

**测试现场证据**：
- 首次 `create_module_from_spec` → 会话 e248d5a7 thinking → set_module_intent → heartbeat × 3 → done，**零 write_file/write_files 调用**，160s，无任何文件生成
- 第二次同参重试 → auto-resume 走通，落盘 4 文件（缺 `api-doc.md`），health=degraded
- 所有 15 个 `/mock/warehouse/*` endpoint 均 500：`Controller error: ctrl.create is not a function`
- `manage_data update` 报 `no such column: updated_at`
- `update_module` 自然语言指令同样 thinking → heartbeat → done，`hasChange: false`

---

## 根因清单（已溯源到 file:line）

### R1 — mock-router 不支持多实体派发
`src/server/core/mock-router.ts:194-214` 按 `endpoint.type` 硬编码查 `ctrl.list/getById/create/update/remove`。单实体模块可用，**多实体模块无法区分 Warehouse / Item / InventoryRecord**。AI 按合理直觉生成了 `listWarehouse/listItems/listInventory` 具名导出（并写进 `_meta.endpoints[].controller`），但 router 根本不读 `.controller` 字段。

### R2 — `_meta.json` 实体源不统一
AI 生成的 `_meta.json` 同时含顶层 `entity`（Warehouse）+ `entities[]`（Item、InventoryRecord）。但框架侧 5+ 处（`openapi-export.ts:85`, `manage-data.ts:105`, `run-test.ts:27`, `base-model.ts:82`, `module-health.ts:41`）只读 `entities[]`，Warehouse 成了孤儿 → OpenAPI 全部 `$ref: Item`、`manage_data` 找不到 Warehouse、健康度只认 `entities[0].tableName`。

### R3 — schema.sql 缺时间戳列
BaseModel 在 `update/insert` 时自动写 `updated_at`（见 `manage_data update` 报错 `no such column: updated_at`），但 AI 生成的 `schema.sql` 没声明该列。Prompt 未强制。

### R4 — "done-but-empty" 静默成功
`chat-runner.ts:811` 流正常结束就无条件 `finalize('done')`，不检查是否真有 write 类工具调用落盘。LLM 只思考不动手也算"完成"。结果：MCP 工具返回 `status:"created"` / `hasChange:false`，用户侧只能靠 inspect 再发现问题。

### R5 — system-prompt 缺关键契约声明
`system-prompt.ts:187` 只说"controller 必须命名导出 list/getById/create/update/remove 不能 default export"，但：
- 没说多实体怎么命名 / 多实体 router 如何派发
- 没列 5 个必需文件（含 `api-doc.md`）
- 没要求 `schema.sql` 必含 `created_at/updated_at` 列
- 没给一个最小可运行 sample

---

## 修复方案

### F1 — 框架层（让已生成的 warehouse 模块无需重新生成就能跑起来）

#### F1.1 · mock-router 支持 `endpoint.controller` 显式派发
**改**：`src/server/core/mock-router.ts:193-215`
**做法**：调度优先级改为：
1. 若 `endpoint.handler` 或 `endpoint.controller`（别名）存在且 `ctrl[name]` 是 function → 调用 `ctrl[name](body, query, params)`
2. 否则按 `endpoint.type` fallback 到 `ctrl.list/getById/create/update/remove`（原行为，单实体模块完全不受影响）
3. 都没有 → 明确 500 且 hint 到 inspect_module

**验证**：单实体模块回归（api-data.spec.ts、mock-router-response.spec.ts）全绿；多实体 warehouse 能直接调通。

#### F1.2 · `_meta.json` 实体源统一化 — 新增 `getEntities(meta)` helper
**改**：
- 新增 `src/server/core/meta-entities.ts`：`getEntities(meta): Entity[]` —— 先用 `meta.entities` 若为空数组/缺失就把 `meta.entity` 包成单元素数组返回；同时提供 `getPrimaryTableName(meta)` 给 health 用
- 替换：`openapi-export.ts`, `manage-data.ts`, `run-test.ts`, `base-model.ts`, `module-health.ts` 中所有 `meta.entities` 直接读改为 helper 调用

**验证**：warehouse `_meta.json`（含 entity + entities）被完整识别出 3 个实体；单实体历史模块无回归。

#### F1.3 · chat-runner watchdog + auto-nudge（根因修复，非兜底）

"done-but-empty" 不能发生。思路：stream 自然结束时若 `moduleIntent ∈ {create,update}` 且本轮零 write tool_call → **注入 synthetic system-nudge 并 resume stream**，最多 2 次。两次后仍空才 finalize('error')。绝不进 finalize('done')。

**改**：`src/server/agent/chat-runner.ts` 的 stream 循环尾部（line ~800-811）

伪码：
```ts
const didWrite = this.collectedToolCalls
  .some(c => c.name === 'write_file' || c.name === 'write_files');
const mustWrite = this.moduleIntent?.operation === 'create'
                || this.moduleIntent?.operation === 'update';
if (mustWrite && !didWrite) {
  if (this.nudgeCount < MAX_NUDGE) {     // MAX_NUDGE = 2
    this.nudgeCount++;
    this.appendEvent('system_nudge', { reason: 'no-write-after-intent', attempt: this.nudgeCount });
    this.pendingMessages.push({
      role: 'system',
      content: `你已声明 moduleIntent=${this.moduleIntent.operation}，但本轮未调用任何 write_file / write_files。`
             + `现在必须立即调用 write_files 或多次 write_file 写入 5 个必需文件：`
             + `_meta.json、schema.sql、controller.ts、test.ts、api-doc.md。`
             + `不允许只说不做。若你认为无需改动，显式调用 set_module_intent({operation:'none'}) 取消意图。`
    });
    continue;  // 重启 streamText 循环，复用 currentMessageId / affectedModules
  } else {
    this.finalize('error', {
      message: '模型连续 3 轮未产出任何文件（moduleIntent 已声明但无 write 调用）；'
             + '建议换更强模型或简化 spec'
    });
    return;
  }
}
this.finalize('done');
```

**smooth 保障**：
- 单次 nudge 仅注入系统消息并 resume，对 MCP 客户端完全透明（`still-running` 窗口内自动续接；超窗口返回 status="still-running" 让 MCP auto-resume 接管）
- `get_session_status.recentEvents` 里能看到 `system_nudge` 事件 + attempt 计数，前端/MCP 可见诊断信号
- progress notification 的 stage 用 `nudging` 文案（humanizeStage 里加"框架提示模型落地"），不泄漏 internal

**验证**：
- `tests/chat-runner-empty-done.spec.ts`：__fake__ provider 分别模拟 "空 1 轮 → 第 2 轮写文件"（期望 done）、"空 3 轮"（期望 error）
- 回归 `chat-resumable.spec.ts`（nudge 复用 currentMessageId，不能破坏续接）

### F2 — Prompt 层（让下一次生成产出正确结构）

#### F2.1 · system-prompt 补齐契约
**改**：`src/server/agent/system-prompt.ts`
**补的条款**（逐条带硬示例）：

1. **5 个必需文件清单**（置顶）：`_meta.json`、`schema.sql`、`controller.ts`、`test.ts`、`api-doc.md`。**少一个即视为失败**。
2. **schema.sql 硬规则**：每张表必须含 `created_at TEXT DEFAULT CURRENT_TIMESTAMP` 和 `updated_at TEXT DEFAULT CURRENT_TIMESTAMP` 两列，否则 BaseModel.update 会报 `no such column: updated_at`。
3. **_meta.json 实体规则**：始终把所有实体写进 `entities[]` 数组。**禁用**顶层 `entity` 字段（保留读侧兼容但生成侧不再使用）。
4. **controller 契约（多实体场景新增）**：
   - 单实体（entities.length===1）：命名导出 `list/getById/create/update/remove`（现状）
   - 多实体：为每个实体导出具名函数 `list<Entity>/get<Entity>ById/create<Entity>/update<Entity>/remove<Entity>`，并在 `_meta.json` 的每条 endpoint 里显式写 `"controller": "list<Entity>"` 等字段
   - 给一个 30 行的多实体 controller sample + 对应 `_meta.endpoints` 片段
5. **空工具调用自检**：若计划不调用 `write_file`/`write_files` 就别回复任何模块创建相关内容（拉住 "done-but-empty" 的源头）

#### F2.2 · 收紧 `set_module_intent` 语义
**改**：`src/server/agent/system-prompt.ts` + 工具 description
**做法**：文档化 "`set_module_intent` 之后必须紧接着调用 `write_files` 或多次 `write_file`"；工具 description 里明说"此工具只声明意图，不代表已完成"。

### F3 — 真实 LLM E2E 验收（硬门槛，不过不算完）

#### F3.1 · MCP 端到端复跑（用户提供的同一套 MCP 调用）
**前置**：先 `delete_module({moduleName:"warehouse"})` 清场。
**完整跑一遍**：
1. `list_modules` → modules=0 ✓
2. `create_module_from_spec({moduleName:"warehouse", waitMaxSec:300, spec: 仓储管理 3 实体 spec})` → status=created，15 endpoints 全返回 ✓
3. `inspect_module({view:"health"})` → health=**healthy**, missingFiles=[] ✓
4. `inspect_module({view:"openapi"})` → 3 个 schema（Warehouse/Item/InventoryRecord）均存在，endpoint 引用正确 schema ✓
5. HTTP 直连 `/mock/warehouse/` POST/GET/PUT/DELETE：CRUD Warehouse 200 ✓
6. HTTP 直连 `/mock/warehouse/items` 同上 ✓
7. HTTP 直连 `/mock/warehouse/inventory` 同上 ✓
8. `manage_data insert/update/list/delete` 三个实体各一轮，全 success ✓
9. `run_test` → passed === total（全绿） ✓
10. `update_module({instruction:"给 Warehouse 加 phone 字段（字符串，可选）"})` → diff 应报 `+field Warehouse.phone`，hasChange=true ✓
11. 再 `run_test` → 全绿 ✓
12. `get_mock_access_log` → 无 500 ✓
13. `generate_handoff_report` → 成功输出 markdown ✓

**任何一步不通过 → 回到 F1/F2 迭代修复 → 重跑 1-13**，直到 100% 通过才算完成。

#### F3.2 · 单元/集成回归（非真实 LLM）
必跑绿：
- `tests/api-data.spec.ts`（13）
- `tests/mock-router-response.spec.ts`（8）
- `tests/mcp-server-v2.spec.ts` 去掉 M25/M32（真实 LLM 的）
- `tests/mcp-warehouse-constraints.spec.ts`
- `tests/mcp-warehouse-e2e.spec.ts`
- 新增 `tests/chat-runner-empty-done.spec.ts`（F1.3）
- 新增 `tests/meta-entities.spec.ts`（F1.2）
- 新增 `tests/mock-router-named-controller.spec.ts`（F1.1）

---

## Task 切片与验证

| Task | 改动文件 | 自测 | Commit |
|------|---------|------|--------|
| F1.1 | `core/mock-router.ts` + 新测试 | unit + mock-router-response 回归 | `Step-Fix-1.1: mock-router named controller dispatch` |
| F1.2 | 新 `core/meta-entities.ts` + 5 处替换 | unit + api-data + mcp-warehouse 回归 | `Step-Fix-1.2: unify entity resolution via getEntities()` |
| F1.3 | `agent/chat-runner.ts` + 新测试 | nudge 单元 + chat-resumable 回归 | `Step-Fix-1.3: chat-runner watchdog + auto-nudge` |
| F2.1 | `agent/system-prompt.ts` + sample | system-prompt.spec + sp 体积回归 | `Step-Fix-1.4: system-prompt contract reinforcement` |
| F2.2 | `agent/tool-registry.ts` description | mcp-guide-resume 回归 | `Step-Fix-1.5: tighten set_module_intent semantics` |
| F3.1 | 无代码（验收） | MCP 手跑 13 步 | `Step-Fix-1.6: real-LLM E2E passed` |

---

## 不做 / 明确边界

- ❌ 不动前端 Vue 文件（此轮纯后端 + prompt）
- ❌ 不重构 write-tool-runner / concurrency-gate（Step-MCP-5 已稳定）
- ❌ 不加模型能力探测（Step-Perf-3 的范围）
- ❌ 不引入新数据库迁移（`_meta.json` 结构兼容即可）

---

## 风险与回滚

- F1.1 router 改动涉及核心请求路径 → mock-router-response.spec 全绿 + 手测一个旧单实体模块
- F1.3 guard 若误判 → operation 检查 + 仅空 tool_calls 双条件，不动普通 chat
- F2.1 prompt 变大可能影响体积硬规则（SP07）→ 保持新增 <2KB

回滚：每个 Task 独立 commit，任一出问题单独 revert 不影响其余。

---

## 完成定义（DoD）

1. F1.1 ~ F2.2 所有 Task 代码 commit
2. F3.2 所有列出测试全绿
3. **F3.1 的 13 步 MCP 真实 LLM 全流程第一次就通过**（不允许"retry 才绿"）
4. `PROGRESS.md` 追加 Step-Fix-1 变更摘要
5. `CURSOR.md` 游标推到 "ALL COMPLETE (Step-Fix-1)"
6. 本计划文件删除
