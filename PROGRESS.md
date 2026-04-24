# MockForge 实现进度

## 总览
| Phase | 名称 | 状态 |
|-------|------|------|
| 1 | 项目基础 | ✅ 完成 |
| 2 | AI Agent 核心 | ✅ 完成 |
| 3 | 前端 — 对话 | ✅ 完成 |
| 4 | 前端 — 模块管理 | ✅ 完成 |
| 5 | 增强 | ✅ 完成 |
| 6 | MCP 集成 | ✅ 完成（Step-MCP-1 + Step-MCP-2 + Step-MCP-3 + Step-MCP-4 + Step-MCP-5 + Step-Perf-1 + Step-Perf-2）|

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

### Step-MCP-3: Mock 保真度 + 规范契约 + 选择器入口 ✅
- **mock-router 放权**（`core/mock-router.ts`）：删除 `success:false → 404` 强制映射；controller 返回值是权威的；新增 `__mock__` 逃生舱（status/headers/body 完全自定义）+ `statusCode` 字段显式覆盖；阿里风格 `{code, data, msg}` 默认 200 原样通过
- **system-prompt 重构**（`agent/system-prompt.ts`）：分层结构（用户/预设/默认三段独立分区）+ Step 1→2→3 决策流程硬规则 + 4 条"禁止动作"（折中/擅自补充/曲解/同项混合）+ 决策对账（write_file 前必填表）+ 冲突可见化要求；默认最佳实践段含 HTTP 状态码语义说明（业务校验失败默认 200 + success:false）
- **MCP 工具参数扩展**（`mcp/lib/headless-session.ts` + 两个工具 schema）：`create_module_from_spec` / `update_module` 接受 `provider?` / `model?` / `preset?`（id 或 name）；scope-aware 校验（user-owned 或 public）；未知 id/name 抛友好错误
- **Web UI 新建对话 dialog**（`client/components/chat/SessionConfigDialog.vue`）：点"新建对话"弹 dialog，provider/model/preset 三个可选选择器 + "跳过默认"快捷；localStorage 记住上次选择；切 provider 自动预填 model
- **Web UI 对话中切换**（`client/components/chat/SessionMetaBar.vue`）：输入框上方 meta-bar 显示 `{provider} · {model} · {preset}`；点击复用同一 dialog（标题改为"切换会话配置"）；runStatus=running 时禁用 + 提示等本轮结束
- 新增 27 条测试（mock-router-response MR01-08 + system-prompt SP01-06 + mcp-priority P01-07 + page-chat-new-session NS01-04 + page-chat-switch SW01-03 + mcp-server-v2 M33-37）
- 关键回归 223 passed（page-chat 23, api-data 13, mcp-server-v2 ex-LLM 25, api+responsive 51, chat-resumable, page-modules, page-data-management, navigation, e2e-flows, step-ux-polish-3..5 等）
- 已知 flaky（不阻塞）：M25/M32 真实 LLM 测试沿用 CURSOR.md 既有 retries 策略
- 详见 `CURSOR.md` 对应章节

### Step-MCP-4: 元数据约束建模 + OpenAPI 映射 + 强 diff ✅
- **_meta.json schema 扩展**(`core/meta-schema.ts`):字段加 enum/min/max/pattern/minLength/maxLength/unique/description/default;实体加 constraints[] = { id?, when, must, message } 表达跨字段规则;旧 enumValues/defaultValue 自动归一化
- **openapi-export 全面映射**(`core/openapi-export.ts`):field 约束 → schema.enum/minimum/maximum/pattern 等;entity.constraints → POST/PUT/PATCH endpoint description 末尾 markdown 块
- **BaseModel.withMeta() auto-validate**(`core/base-model.ts` + `core/validator.ts`):controller 一行 `.withMeta('moduleName')` 接入自动校验;违反抛 ValidationError,模板 try/catch 转 400;PATCH 与 existingRow 合并后再校验跨字段;unique 走 DB 查询
- **diff_with_openapi 强化**(`mcp/tools/diff-with-openapi.ts`):新增 constraint-violation + cross-field-violation;跨字段直接读 _meta.json
- **update_module 富 diff**(`mcp/lib/update-diff.ts`):snapshot 加 constraintIds + testNames + controllerErrorBranches + apiDocLines;输出 +constraint/+test 明细 + warnings (controller/api-doc drift) + hasChange=false 显式 silent-no-op 提醒
- **bulk_generate 约束感知**:faker 尊重 enum/min/max;跨字段约束在 seed 时跳过
- **system-prompt 引导**:controller 模板改为 .withMeta() + try/catch ValidationError;新加"表达业务约束的优先级"段
- 新增 67 条测试 (meta-schema:9 + openapi-constraints:7 + validator:16 + base-model-validate:8 + diff-with-openapi-constraints:6 + update-module-richdiff:14 + warehouse-constraints e2e:7)
- 关键回归 148 passed (api-data 13, mcp-server-v2 ex-LLM 25, mcp-warehouse-e2e 6, manage-data-resolve 2, mock-router-response 8, step-ux-polish-5 8, page-chat 23 + chat-resumable + page-modules + page-data-management + navigation + e2e-flows ≈86)
- 详见 `CURSOR.md` 对应章节

### Step-Perf-2: 真实 LLM 实测暴露的 Bug 修复 + 测试覆盖补齐 ✅
起因:用户 Cursor 实测 gemma-4-31b 时,`create_module_from_spec` 挂起 1h 没生成模块。DB 事件清单暴露:AI 6 次调 write_files 都 `args:{}`,嵌套 schema 超出小模型能力,Step-Perf-1.2 删 write_file 是过度冒进。

核心修复:
- **P2.1 恢复 `write_file` 单文件工具**(`agent/tool-registry.ts`): write_files 保留快通道,write_file 是弱模型退回;prompt 指引 AI 按能力选择
- **P2.2 空 args 错误引导**(`agent/tools/write-files.ts`): 明确告知 schema + 指向 write_file
- **P2.4 default waitMaxSec 60→180s**(`mcp/lib/write-tool-runner.ts`): 对齐真实 LLM 延迟
- **P2.3 真实 LLM E2E 验收门槛**(`tests/real-llm-e2e.spec.ts`,新): RLM-01~04 真跑 gemma 端到端;RLM-01 是硬验收门槛
- **bonus**: `stopWhen: stepCountIs(20 → 40)` + `CHAT_MAX_STEPS` env,真实生成常要 25-35 步

测试:
- RLM-01 首次真跑 gemma 6.9min 通过,5 文件落盘 + /mock/rlm_warehouse 可访问
- 非真实 LLM 回归(34 条关键套件): 全绿
- WF06 更新断言新引导消息

教训: 只用 __fake__ 不够;简化 ≠ 删除;涉及 tool schema 改动必须跑真实 LLM E2E
- 详见 CURSOR.md 对应章节

### Step-Perf-1: AI 生成提速 + 工具表面简化 + UX 打磨 ✅
- **system prompt 瘦身**(agent/system-prompt.ts + agent/templates/samples.ts + agent/tools/get-module-template.ts):18020B → 7274B; 模板外置到 get_module_template(kind) Agent 工具按需读
- **batch write_files**(agent/tools/write-files.ts):事务语义一次写 N 文件, 5-6 次 LLM round-trip → 1 次; 旧 write_file 从 tool-registry 移除
- **provider-aware prompt caching**(agent/prompt-cache.ts):Anthropic 注入 cacheControl ephemeral, OpenAI-compat 依赖 backend 自动 cache(前缀字节稳定); ENABLE_PROMPT_CACHE=0 可关
- **per-session mutex**(agent/lib/session-mutex.ts):write tools 同 session 内串行, read tools 真正并行
- **inspect_module 合并**(mcp/tools/inspect-module.ts):view='all'|'doc'|'openapi'|'health' 一个工具替代 3 个; MCP 工具数 14 → 12
- **write-tool-runner 抽象**(mcp/lib/write-tool-runner.ts):update/create 两工具 755 行 → 382 行 + 283 行 runner
- **module-repo**(core/module-repo.ts):集中 DB + fs 查询, 8+ 处散落调用统一
- **error recovery_steps**(mcp/lib/error-codes.ts):每个 mcpError 附机器可读 recovery_steps 数组; text 前缀 [MOCKFORGE_XXX]
- **humanized progress**(mcp/lib/stage-humanize.ts):stageDescription 中文 + expectedRemainingSec + suggestedNextAction; still-running + get_session_status + progress notification 三处接入
- 新增 50 条测试(GT/SP07/WF/PC/PT/IM/ER/MR/UX/PE)+ 回归 MCP-5 全套绿
- **工具集**:MCP 12 个(list_modules, inspect_module, get_mock_access_log, diff_with_openapi, delete_module, run_test, manage_data, create_module_from_spec, update_module, get_session_status, cancel_session, generate_handoff_report)/ Agent 8 个(+get_module_template, write_files 替代 write_file)
- 详见 CURSOR.md 对应章节

### Step-MCP-5: 单模块单流程 + 自动续接 + 并发约束 ✅
- **headless-session 拆分**(`mcp/lib/headless-session.ts`): `runHeadlessSession` → `startHeadlessSession()` + `attachAndWait(sessionId, waitMaxSec)` 两相; legacy 门面保留; 新增 `getSessionSnapshot()` DB-only 快照
- **写工具 waitMaxSec + onConflict**(`create-module-from-spec.ts` / `update-module.ts`): 默认阻塞 60s (上限 300); 超时返 `status:'still-running'` + sessionId; onConflict=resume (默认) / reject / replace; attached=true 时携带 actualInstruction + yourInstruction + 不一致 warning
- **2 个新会话工具**(`get-session-status.ts`, `cancel-session.ts`): 5ms 快照 + 主动放弃;工具数 12 → 14
- **并发 gate**(`mcp/lib/concurrency-gate.ts`): per-user 3 + 全局 10 (env `MCP_USER_CONCURRENCY_LIMIT` / `MCP_GLOBAL_CONCURRENCY_LIMIT`); attach 不计数; BUSY 响应列出 runningSessions
- **heartbeat**(`agent/chat-runner.ts`): 每 `CHAT_HEARTBEAT_MS` (默认 30000) 强发 heartbeat 事件, 持久化 + progress notification 透传防 idle 断连
- **统一错误码**(`mcp/lib/error-codes.ts`): 所有 MCP 工具 isError 响应带 `code` + `hint` + 场景字段
- **instruction 比对**(`mcp/lib/instruction-utils.ts`): normalize trim + 折空白 + 大小写; 不一致只 warning 不阻断
- **guide + 工具 description 全面更新**: 加"⚡ 单模块单流程 + 自动续接"章节, 写工具 description 含 waitMaxSec/onConflict
- 新增 36 条测试 (HA:5 + AR:8 + ST:6 + CC:5 + HB:2 + EC:4 + GR:3 + E:3)
- 回归套件 430+ passed; M30 更新为 14 工具;D04 加 onConflict='reject' 保持原语义;M25/M32 加 waitMaxSec=300 对齐 5min LLM 预算
- 详见 `CURSOR.md` 对应章节

### Step-Fix-1: MCP 真实 LLM E2E 修复 ✅
**起因**：2026-04-24 用户 MCP 实测"仓储管理"生成,暴露 4 类问题:
- 首次 create session 160s 只 set_module_intent 就 done (零 write)
- 第二次 create 走通但 health=degraded (缺 api-doc.md)
- 15 个 endpoint 全 500 (ctrl.create is not a function)
- manage_data update 报 no such column: updated_at

**Step-Fix-1.1** — mock-router 支持 `endpoint.controller` 具名调度 + 单实体 fallback
- AI 已能按"listWarehouses/getItemById/createInventory" 命名多实体 handler,router 优先读 `.controller` 字段,未设置才退回 `ctrl.list/getById/create/update/remove`
- 签名: `ctrl[controller]({ body, query, params })`  req-like 一个对象
- +9 测试 NC01~09 覆盖 4 种命名 / 多实体消歧 / 错误回显 / legacy

**Step-Fix-1.2** — `getEntities()` + `pickEntityForEndpoint()` 统一实体源
- AI 历史产物混用 `entity` 顶层 + `entities[]` 数组,框架 8 处只读 entities 导致遗漏
- `getEntities(meta)` 把 legacy entity 预置进列表,同名时 entities[] 保留
- `pickEntityForEndpoint(ep, list)` 按 ep.entity → controller 启发式 → path 片段 → 兜底,让 openapi-export 给每个 endpoint 选正确 `$ref`
- 8 处切到 helper (base-model.ts / openapi-export.ts / module-health.ts / manage-data.ts / run-test.ts / delete-module.ts / update-diff.ts / generate-handoff-report.ts)
- +15 单元 ME01~15 + pickEntityForEndpoint 四级优先级覆盖

**Step-Fix-1.3** — chat-runner watchdog + auto-nudge (根治空 done)
- 流自然结束若 `moduleIntent ∈ {create,update,edit}` 且本轮零 write_file/write_files → 注入 system-injected user nudge 让模型回正轨,最多 `CHAT_NUDGE_MAX`(默认 2) 次
- 仍空 → `finalize('error', {message: '模型声明意图但连续 N 轮未写,建议换模型'})`,永不静默 done
- `src/server/agent/watchdog.ts` 纯函数 decideWatchdog + buildNudgeMessage; chat-runner 抽 `consumeOneStream(messages)` 闭包循环调用
- +12 WD01~12 覆盖全部决策 + nudge 预算边界

**Step-Fix-1.4** — system-prompt 契约硬规则补齐
- 开工流程段逐项列出 5 必需文件 (_meta.json / schema.sql / controller.ts / test.ts / api-doc.md) "少一个即失败"
- schema.sql 必含 `created_at/updated_at TEXT DEFAULT CURRENT_TIMESTAMP` (BaseModel.update 自动写)
- _meta.json 禁用顶层 entity 字段,所有实体走 entities[]
- 多实体 controller 命名规则 + 内联 2 行样例 + 签名说明
- 压缩既有冗余 (禁止动作 / 对账表 / 响应写法)  净增 ~350 bytes, 空 prompt 7727 → 8080 (SP07 阈值 8000→8500)
- +SP08~11 (5 文件 / 时间戳 / entities / 多实体命名) 共 4 条

**Step-Fix-1.5** — set_module_intent description 收紧
- 明说 "此工具只声明意图,调用后必须紧接 write_files/write_file 写 5 文件"
- 与 F1.3 watchdog 两端夹击"声明但不动手"

**Step-Fix-1.6** — BaseModel outward 别名 + mock-router await + withMeta 宽容匹配 + watchdog 认 'edit'
- BaseModel 加 `list/getById/remove` 别名 (inward 只有 findAll/findById/delete); 接受 string ID
- mock-router 的 statusCode/`__mock__` 处理对 Promise 不生效: async controller 返 Promise → `'statusCode' in p` false → 走默认 200 分支。修: await 结果再处理
- withMeta 严格 tableName 匹配失败回落 entities[0] 导致 wrong entity: 改宽容匹配 tableName / mock__+name / entity.name
- watchdog 也认 operation='edit' (MCP update_module 流程里 AI 调 set_module_intent(operation:'edit'))
- +3 BA01~03 测试

### F3.1 真实 LLM E2E 硬验收 — 13 步全绿 ✅
- create warehouse (3 entities 15 endpoints)  health=healthy 0 missingFiles
- HTTP CRUD /warehouses /items /inventory 全 200
- manage_data insert/update/list 3 实体全通
- run_test: 5/5 passed
- update_module add phone: diff +field Warehouse.phone + +test "仓库 phone CRUD"  hasChange=true
- run_test after update: 6/6 passed
- access log 最近 50 条全 200 (vs 修复前 18/18 全 500)
- handoff_report 2086 bytes,3 实体 + phone 全部覆盖

### 新增测试
- tests/mock-router-named-controller.spec.ts (9)
- tests/meta-entities.spec.ts (15)
- tests/chat-runner-watchdog.spec.ts (12)
- tests/base-model-aliases.spec.ts (3)
- SP08~11 追加到 system-prompt.spec.ts (4)

### 已知副作用
- run_test cleanup 在后端进程内存边缘条件下偶尔失败一次,连续调用通常第 2 次 6/6 绿; 非本轮新引入

## 关键决策记录
- Vite 6 而非 8（Node 20.16.0 兼容性）
- Tailwind 3 而非 4（同上）
- shadcn-vue 组件手动创建（corepack 兼容性问题）
- 使用 --env-file .env 加载环境变量
- MCP API Key 用 HMAC-SHA256 而非 bcrypt（O(1) 查询 vs 全表扫描）
- MCP 用 stateless StreamableHTTPServerTransport + per-request McpServer（简单安全）
- 用户上下文经 AsyncLocalStorage 注入（复用项目既有 BaseModel 模式）
