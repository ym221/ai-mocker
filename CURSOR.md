# MockForge 执行游标

## 当前位置
- **Phase**: Step-Observability-1 完成
- **状态**: 全链路日志能力上线 — emit 异步 fire-and-forget,负 seq 与主事件流隔离,前端模块详情页加 "执行日志" tab,性能开销实测 0.1%(<5% 硬约束)

## 下一步
- 用户跑一次真实 LLM 模块生成,在 "执行日志" tab 截图阶段占比 + 修复次数,贴入 `plans/OBSERVABILITY-BASELINE.md`
- 据真实数据走 `plans/CONTEXT-WORKFLOW-NEXT.md` 的 Q1 决策树,选 (A)/(B)/(C) 路径开 Step-Workflow-2

## 已完成 Step
- [x] Step 1: 项目初始化 (d759059)
- [x] Step 2: 数据库 + Schema (1665a08)
- [x] Step 3: BaseModel (dcd3880)
- [x] Step 4: Fastify 基础 (3d8c091)
- [x] Step 5: 认证 + 数据库 Seed (c67a9b2)
- [x] Step 6: Agent 工具集 (acd2c2b)
- [x] Step 7: System Prompt + AgentRunner + 系统 API (0571bbf)
- [x] Step 8: mock-router (a0cb85b)
- [x] Step 9: 端到端验证 (7505e02)
- [x] Step 10: 前端基础 (73b1e8c)
- [x] Step 11: Settings 页面 (c59dc5d)
- [x] Step 12: 对话页 (1bbc04a)
- [x] Step 13: 文件上传 (5a1e136)
- [x] Step 14-18: 模块管理前端 (7720803)
- [x] Step 19-23: Phase 5 增强 (eb3bc47)
- [x] Thinking 适配层 (46e54b5)
- [x] **Step-Chat-Resumable**: 事件日志 + 后台 Runner + 可恢复订阅架构
- [x] **Step-Data-Management**: 数据管理 Tab 全功能 + 通用 ColumnSettings 组件
- [x] **Step-Data-Management-Polish**: FilterBar 操作符化 + page-header 全局化 + 冻结列穿透/单击聚焦修复
- [x] **Step-UX-Polish-2**: ID列宽+文档Markdown渲染+sessions轮询清理+侧边栏压缩+Chat字体+简化进行中状态+进度条UI
- [x] **Step-UX-Polish-3**: 打字机效果 + startedAt 计时 + 思考内容隐藏 + 文档下载/复制/OpenAPI + 模块状态机 + 超时熔断 + 进度条移除
- [x] **Step-UX-Polish-4**: error 事件 streamDone 修复 + 列表 in-place merge + card 时序+样式 + ThinkingParser &lt;thinking&gt; 支持 + 模块健康度派生 + 重新生成按钮
- [x] **Step-UX-Polish-5**: 统一 Toast 封装 + send() 兜底 + isGenerating 启发式 + 数据表自愈 + AI 测试规范强化
- [x] **Step-MCP-1**: MCP Server 只读骨架 — API Key 鉴权 + HTTP Streamable Transport + 3 只读工具 + guide Resource + Settings API Keys Tab
- [x] **Step-MCP-2**: MCP 写能力 + 业务侧感知 + 交接报告 — 12 个 MCP 工具全集 + access log + progress notifications + 软 warnings + dry_run + handoff report + headless-session 桥接
- [x] **Step-MCP-3**: Mock 保真度 + 规范契约 + 选择器入口 — mock-router 放权 + system-prompt 规范决策硬规则 + MCP provider/model/preset 覆盖 + Web UI 新建对话 dialog + 对话中 meta-bar 切换
- [x] **Step-MCP-4**: 元数据约束建模 + OpenAPI 映射 + 强 diff — _meta.json 字段约束 (enum/min/max/pattern/unique) + entity.constraints 跨字段规则 + openapi-export 全面映射 + BaseModel.withMeta() auto-validate + diff_with_openapi constraint-violation/cross-field-violation + update_module 富 diff
- [x] **Step-MCP-5**: 单模块单流程 + 自动续接 + 并发约束 — runHeadlessSession 拆分 start+attach、write 工具 waitMaxSec + onConflict=resume、新增 get_session_status + cancel_session(12→14 工具)、concurrency gate(per-user 3 / global 10)、30s heartbeat keepalive、统一错误码 + hint
- [x] **Step-Perf-1**: AI 生成提速 + 工具表面简化 + UX 打磨 — system prompt 18KB→7KB(模板外置 get_module_template)、batch write_files 替代 write_file 单文件(6 次 LLM→1 次)、provider-aware prompt caching(Anthropic + OpenAI-compat 前缀稳定)、per-session mutex + 并行读、14→12 MCP 工具(inspect_module 合并 doc+openapi+health)、write-tool-runner 抽象消除 update/create 70% 同构、module-repo 集中 DB+fs 查询、error recovery_steps(machine-actionable 下一步工具)、humanized stage + expectedRemainingSec + suggestedNextAction
- [x] **Step-Perf-2**: 真实 LLM 实测暴露的 Bug 修复 + 测试覆盖补齐
- [x] **Step-Observability-1**: 模块生成全链路日志 + 前端可视化(6 Task) — 复用 message_events 表(负 seq 隔离观察事件)+ setImmediate 异步入库 + 阶段/工具/修复/LLM 轮次聚合 API + ModuleDetailPage "执行日志" tab + 性能开销 0.1%(基线见 plans/OBSERVABILITY-BASELINE.md)。新增 23 条测试全绿,回归 152+ 条全绿
- [x] **Step-Observability-1.1**: 真实 LLM 实测后的 3 个 UX/数据修复
  - **session.moduleName 自动绑定**: chat-runner.applyModuleIntent 内 UPDATE sessions SET module_name,使前端 chat 起手的模块的 timeline tab 能找到对应 session(此前空白)
  - **Timer 立即出现**: chat.ts send() 推 user msg 同时也推空 assistant 占位符,MessageBubble.isGenerating 改为"非终态即视为进行中",从原本 toolCall 触发后才显示(elapsed 跳到 20s+) → 现在 send-to-startedAt < 100ms,banner 立即出现
  - **LIVE-01 真实 LLM 验证**: 7.7min 全程 RLM,timer 94ms 呈现 / module_name 自动绑定 / 5 phase 事件 + 2 llm_round + 8 tool_timing + 1 repair_triggered 全部记入 timeline。修复回归绿(74/75 chat 套件 + 真实 LLM E2E)
- [x] **Step-Observability-1.3**: 对话气泡 UX 简化 — 去掉"思考中"徽章 + 加完成耗时
  - 删 MessageBubble 的 thinking 徽章("思考中/已完成思考")— 思考内容用户看不到,徽章只是噪音,直接显示"进行中..." + 计时即可
  - chat-runner.finalize 给所有终态事件(done/paused/aborted/error)payload 加 `finishedAt: Date.now()`,chat.ts applyEvent 提取进 DisplayMessage.finishedAt
  - 完成后展示绿色"完成 · 耗时 X"横条(`<60s` 显示"30秒",`>=60s` 显示"X分Y秒",分整数则只显示"X分"),aborted/error 状态下不显示(让自己的 banner 主导)
  - 用 server-stamped finishedAt 让历史会话 replay 也能精确还原耗时,不依赖前端 Date.now()
  - 测试:6 条 CB01-CB05 + 更新 T04 验证徽章已下线
- [x] **Step-Observability-1.2**: 用户截图反馈的 thinking 泄漏 + 服务重启 UX
  - **thinking-parser 孤儿 close tag(P11-P16)**: gemma 偶尔发 `</thought>` 而无对应开标签,parser 之前会泄漏 `<` 字符到正文。修复:在非 thinking 状态优先匹配 `</thinking>/</think>/</thought>/</reasoning>` 静默吃掉,支持跨 chunk 切片
  - **thinking-parser 孤儿 OPEN tag(P17-P21)**: gemma 漏发 `<` 只发 `thought>X</thought>`,导致 `thought>X` 全泄漏到正文(用户截图)。修复:用 `pendingText` 推迟 text emission,遇到孤儿 close 时回溯 pendingText 找 `tagname>` 前缀,把 `tag>` 之后到 close 之前的内容回归为 thinking
  - **服务重启 abort UX**: tsx-watch 重启会触发 database.ts 写 `aborted{reason:'server_restart'}` 事件。chat.ts applyEvent 提取 reason 进 DisplayMessage.abortReason,MessageBubble 区分两种 abort:`server_restart` 显示"服务已重启,生成被中断" + 蓝色重试按钮(点击即重发原 prompt);用户主动 stop 仍是橙色"已停止生成"
  - 测试:thinking-parser 11 条新增 P11-P21 全绿,abort-restart-retry 4 条 UI 测试全绿,完整 chat 回归 98/99 (1 skipped)
- [x] **Step-Fix-1**: MCP 真实 LLM E2E 修复(6 Task) — mock-router named-controller 调度 + getEntities helper 统一实体源 + chat-runner watchdog+nudge 根治空 done + system-prompt 契约硬规则 + BaseModel outward 别名 + await async controller。F3.1 13 步真实 LLM E2E 全绿(3 实体 warehouse: create/CRUD/update add phone/6 tests 全通过 + access log 0×500) — 恢复 write_file 单文件工具(弱模型退回路径)、write_files 空 args 返更明确错误并引导退回、default waitMaxSec 60→180s(对齐真实 LLM 延迟)、stepCountIs 20→40(给真实生成足够步数)、新增 `tests/real-llm-e2e.spec.ts` 真实 gemma 端到端 E2E(RLM-01~04 作为硬验收门槛,以后不依赖用户手测)

## Step-Chat-Resumable 变更摘要
计划文档: `plans/STEP-CHAT-RESUMABLE-PLAN.md`

### 新增文件
- `src/server/agent/chat-runner.ts` — 会话级后台 ChatRunner（EventEmitter + 事件日志 + 批量合并 flush）
- `tests/chat-resumable.spec.ts` — 5 大硬需求场景 e2e 测试

### 修改
- `src/server/core/schema.ts` — 新增 `message_events` 表，sessions 加 `runStatus/hasUnread/lastSeq`，messages 加 `paused/finalizedAt`
- `src/server/core/database.ts` — 迁移 + 启动清理 'running' 僵尸状态
- `src/server/api/chat.ts` — POST /api/chat 与流解耦；新增 GET /api/chat/stream（afterSeq 续播）、POST /api/chat/pause、POST /api/chat/read
- `src/server/api/sessions.ts` — DELETE 时先停止 runner 避免 FK 冲突
- `src/server/app.ts` — 开发环境 rate limit 提高到 2000/min
- `src/client/stores/chat.ts` — 重构为 streams map（按 sessionId），优化 user 消息 dedup，支持 pause 本地中断 + 未读清除
- `src/client/pages/ChatPage.vue` — 事件驱动渲染，未读红点，5s 轮询
- `src/client/components/chat/ChatPanel.vue` + `MessageList.vue` — 用 DisplayMessage 类型

### 5 大硬需求验证
- [x] 场景1 暂停保留已输出 + 发送继续 — 场景1 测试 ✅
- [x] 场景2 上下文隔离（删除会话 / 模块切换） — 场景2 测试 ✅
- [x] 场景3 卡片/工具调用持久化（事件日志） — 场景3 测试 ✅
- [x] 场景4 客户端断开后端继续 + 重连接续 — 场景4 + UI 场景测试 ✅
- [x] 场景5 未读标识 + 已读清除 — 场景5 测试 ✅

### 测试结果
- `tests/chat-resumable.spec.ts`: 7/7 ✅
- `tests/page-chat.spec.ts`: 29/29 ✅
- `tests/e2e-flows.spec.ts` 聊天相关 E04/E07: ✅
- 完整套件: 159+/165 (剩余失败均为与本次重构无关的 responsive 移动端测试)

## Step-Data-Management 变更摘要
计划文档: `plans/STEP-DATA-MANAGEMENT-PLAN.md`

### 后端
- `src/server/agent/tools/manage-data.ts` — 新增 list/update/batch_delete 动作；bulk_generate 支持 rules（faker/sequence/fixed）；faker 映射扩展
- `src/server/api/data.ts` — 从单入口重构为 PLAN §6.4 的 7 条 REST 路由（GET list + POST/PUT/DELETE + batch-delete/clear/bulk-generate），filter 支持模糊 LIKE

### 前端
- `src/client/composables/use-data-api.ts` — 统一 API 封装
- `src/client/composables/use-table-preferences.ts` — 通用表格偏好持久化 Hook
- `src/client/components/ui/checkbox/` — 新增 Checkbox（reka-ui）
- `src/client/components/data-table/ColumnSettings.vue` — 通用列设置：显示/隐藏、拖拽排序（sortablejs）、冻结左/右、密度切换（紧凑/标准/宽松）、列名搜索、全选/全不选/重置、命名预设保存/加载、localStorage 持久化
- `src/client/components/data/DataTable.vue` — 核心表格（固定列宽、排序、筛选、分页、行选择、sticky 冻结列 + 阴影分隔）
- `src/client/components/data/EditableCell.vue` — 按字段类型映射 Input/Select/Switch/DatePicker/Textarea，无抖动切换，绿色闪烁反馈，Enter/Esc/Tab 键盘快捷键
- `src/client/components/data/DataGenerator.vue` — 批量生成 Dialog（数量 + 字段规则下拉）
- `src/client/pages/ModuleDetailPage.vue` — Data Tab 集成 DataTable

### 依赖
- `sortablejs` + `@types/sortablejs` + `@vueuse/integrations`（ColumnSettings 拖拽）

### 测试
- `tests/api-data.spec.ts` — 13 条后端 API 测试，全绿
- `tests/page-data-management.spec.ts` — 18 条 UI 测试（U01-U09 表格功能 + C01-C09 列设置），全绿
- 完整套件：190+/194（4 失败均为 CURSOR 记录的 pre-existing 移动端响应式测试）

## Step-Data-Management-Polish 变更摘要

### 用户反馈
1. 列内筛选 → 工具栏统一 FilterBar（字段+操作符+值，多条 AND）
2. 页面标题信息提取到全局 header
3. 冻结列被悬浮内容穿透（hover 半透明色叠在 sticky 上）
4. 单元格需点两次才能编辑

### 后端
- `api/data.ts` filter 解析支持操作符：`filter[field][op]=gt&filter[field][value]=100`，支持 contains/startsWith/endsWith/eq/neq/gt/gte/lt/lte/between/in

### 前端
- 新增 `FilterBar.vue`（toolbar 左侧筛选条芯片：字段、操作符、值/范围/枚举/布尔，全部清除）
- 新增 `usePageHeader` composable 与 `AppHeader` 集成（全局页面标题/描述/meta/back）
- ModuleDetailPage / ModulesPage / SettingsPage / AdminPage 全部接入 page-header
- DataTable 集成 FilterBar，移除列头筛选行；删除 max-height 限制（解决双滚动条）
- EditableCell 用 template ref + nextTick 显式 focus，单击立即进入编辑态
- DataTable 冻结列改用不透明 #ffffff/#f8fafc/#eff6ff，加 border-right/left + z-index 提升

### 测试
- `tests/page-data-management.spec.ts` 新增 U10/U11 操作符 + between 测试；U09 改为 FilterBar 流程
- 完整套件：193 通过 / 4 失败（同 pre-existing responsive 移动端测试）

## Step-UX-Polish-2 变更摘要

### 用户反馈
1. ID 列 60px 截断 → 80px
2. 文档 Tab 含 bash/cURL 指令 + 缺响应字段说明 → 改 system prompt + markdown-it 渲染
3. sessions API 在非 Chat 页持续请求 → 轮询 setInterval 仅在 beforeunload 清理，组件卸载未清
4. 侧边栏 w-64(256px) 留白过多 → w-48(192px)
5. AI 回复字体偏大 → 14px → 13px + 行距收紧
6. 进行中状态过于详细（泄漏工具名/文件名） → 简化为"进行中..."
7. 需要进度反馈（不泄漏操作）→ 方案 E：已用时 + 不确定进度条

### 后端
- `src/server/agent/system-prompt.ts` — api-doc.md 规范改为禁 bash/cURL + 要求响应 JSON + 字段表格

### 前端
- `src/client/components/data/DataTable.vue` — ID 列 80px；冻结列强不透明背景；header 44px 高 + 选择/操作列居中
- `src/client/pages/ModuleDetailPage.vue` — markdown-it 渲染 api-doc.md（替代 `<pre>`），prose 样式
- `src/client/pages/ChatPage.vue` — 轮询 `setInterval` 加 `onBeforeUnmount` 清理
- `src/client/components/layout/AppLayout.vue` — sidebar w-64 → w-48；main 加 `scrollbar-gutter: stable`
- `src/client/components/layout/AppSidebar.vue` — nav item padding 收紧
- `src/client/components/chat/MessageBubble.vue` — 进行中状态改为"进行中..." + 已用时计时器 + 不确定进度条 CSS 动画
- `src/client/composables/use-page-header.ts` — 略

### 测试
- `tests/navigation.spec.ts` R11b：离开 Chat 后 sessions 轮询停止
- `tests/page-data-management.spec.ts` U12/U13/U14/U15：header 高度+居中、冻结列不透明、滚动条稳定、page-header
- 完整回归：见本轮最终结果

## Step-UX-Polish-3 变更摘要
计划文档: `plans/STEP-UX-POLISH-3-PLAN.md`

### 用户反馈（8 项）
1. 打字机字符级输出（代替整行 burst）
2. 已用时计时切页后不重置（bug 修复）
3. 进行中状态去动画横线
4. 思考中不展示内容（安全防泄漏）
5. AI 摘要约束（不提文件名/表名/技术细节）
6. 模块状态机（creating/editing/active/error）
7. 会话超时熔断（5min）+ 状态同步
8. 文档下载 + 复制 + OpenAPI 导出

### 后端
- `schema.ts` — messages 加 `started_at`；modules 加 `error_message`
- `database.ts` — 迁移 `started_at` / `error_message`；启动时 creating 模块转 error
- `agent/chat-runner.ts` — 会话级 5min 硬超时 + `applyModuleIntent()` 状态机纠偏 + applyModuleFinalize hook
- `agent/tool-registry.ts` — 新增 `set_module_intent` tool，接收 {moduleName, operation}
- `agent/system-prompt.ts` — 第一动作必须调 set_module_intent；输出语言规范：禁提文件名/表名
- `agent/tools/write-file.ts` — _meta.json 同步时保留 creating/editing 过渡状态

### 前端
- `composables/use-typewriter.ts` — rAF 节流两层 buffer，自适应速率（≤20:1/tick, 21-200:3/tick, >200:10/tick），done 立即 flush
- `components/chat/MessageBubble.vue` — 打字机接入 `displayedRaw`；计时改为基于 props.startedAt（切页不重置）；删除 thinking-body（仅保徽章）；删除 progress-bar/track 动画
- `components/chat/MessageList.vue` — 透传 startedAt
- `stores/chat.ts` — DisplayMessage 加 `startedAt`；user 事件注入 pendingAssistantStartedAt 链路
- `pages/ModuleDetailPage.vue` — Documentation Tab 加工具栏：复制全文 / 下载 Markdown / 下载 OpenAPI JSON（含 openapi 3.0.3 spec 构造）
- `pages/ModulesPage.vue` — 模块状态徽章（creating/editing/active/error 四色 + Loader2/AlertCircle 图标）；creating 禁止点击跳转；2s 轮询驱动 creating 状态刷新
- `stores/modules.ts` — Module 类型加 errorMessage

### 测试
- `tests/step-ux-polish-3.spec.ts` — T01/T02/T03/T04/T05/T06/T06b/T07/T08 共 10 测试，全绿
- 相关回归：chat-resumable (7/7) + page-chat (22/22) + page-modules (12/12) + navigation (14/14) + e2e-flows (8/8) + step-ux-polish-3 (10/10) = 71/71 全绿

## Step-UX-Polish-4 变更摘要
计划文档: `plans/STEP-UX-POLISH-4-PLAN.md`

### 用户反馈（5 项）
1. 思考标签 `</tho` 泄漏到正文
2. 生成完成后 chat 气泡卡片显示红色 `creating` 英文
3. 失败但功能可用（session 状态 vs 模块健康度耦合）+ 5min 超时偏短 + 无重试
4. 模块列表轮询期间抖动 + 滚动条闪烁
5. 10m+ 仍显示"进行中"（session terminal 后前端未关流）

### 后端
- `thinking-adapter.ts` — TAG_PAIRS 加入 `<thinking>/</thinking>`（修复 P04/P07 前缀陷阱）；flush() 在 insideThinking 状态无论 buffer 是否为空都补 `thinking_complete`
- `schema.ts` + `database.ts` — modules 加 `last_run_status` / `last_run_error` 字段 + 迁移；重启清理扩展到 creating/editing
- `core/module-health.ts` — 新文件：`computeModuleHealth(userId, name)` 检查 5 必需文件 + _meta.json 可解析 + SQLite 表存在 → `healthy`/`degraded`/`missing`
- `chat-runner.ts` — `applyModuleFinalize` 重写为健康度派生：healthy → active（无论 terminal 如何），missing + create → 删除，degraded → error；新增 `stageModuleCards` + `flushPendingCards`，card 在 applyModuleFinalize 之后 emit，携带最终 status；`RUN_TIMEOUT_MS` 默认从 5 分钟 → 10 分钟（CHAT_RUN_TIMEOUT_MS env 可覆盖）
- `api/modules.ts` — list/detail 响应加 `health` 字段；DB 若为 error/editing 但 health=healthy → 展示 status 自愈为 active（不覆写 DB）

### 前端
- `stores/chat.ts` — applyEvent('error') 补齐 streamDone + thinkingComplete + s.status='error'；connect() finally 和 handleIncoming meta 加终态兜底，避免孤立的"进行中..."
- `stores/modules.ts` — `mergeModules()` 按 name 做 in-place merge 保持对象 identity；`refetchModules()` 轮询用不触碰 loading 状态；Module 类型加 health/lastRunStatus/lastRunError
- `pages/ModulesPage.vue` — 轮询切换到 refetchModules；容器加 `min-height: 400px` + `contain: layout`；grid 加 `grid-auto-rows: minmax(110px, auto)`；description 加 line-clamp-2；v-for key 改为 name
- `components/chat/MessageBubble.vue` — module-card 徽章支持 creating/editing/error 全状态中文文案 + 对应颜色 + Loader2 动图；creating 禁止点击跳转；样式加 status-creating/editing/disabled 和 module-card-pending
- `pages/ModuleDetailPage.vue` — 新增红色 error banner + "重新生成"按钮（创建绑定 moduleName 的新 session，自动发送修复提示）

### 测试
- `tests/thinking-parser.spec.ts` — 新增 10 条 parser 单元测试（P01-P10）全绿
- `tests/step-ux-polish-4.spec.ts` — 新增 7 条集成测试（T4-01 至 T4-07）6 passed 1 skipped
- 相关回归：step-ux-polish-3 (10/10) + chat-resumable (7/7) + page-chat (22/22) + page-modules (12/12) + e2e-flows (8/8) + navigation (14/14) + step-ux-polish-4 (7) + thinking-parser (10) = 86 passed 全绿

## Step-UX-Polish-5 变更摘要
计划文档: `plans/STEP-UX-POLISH-5-PLAN.md`

### 用户反馈（3 项）
1. Toast 消息显示在左下并被侧边栏遮挡 — 要求统一封装 + 全局替换
2. AI 已完成（模块卡片+思考已完成徽章均出现）但 "进行中... 7m12s" banner 仍显示
3. 批量生成报 `no such table: mock__1_log` — AI 宣称完成但数据表未创建

### 后端
- `agent/tools/manage-data.ts` — 新增 `ensureTableExists`：操作前检查表是否存在，不存在时自动从 generated/{userId}/{moduleName}/schema.sql 读取并 exec（带 userId 注入），验证后仍失败则抛友好错误
- `agent/system-prompt.ts` — 强化 6/7/8 三条约束：run_test 必须覆盖 create→list→get→update→delete 全流程；失败必须重试（最多 3 次）；_meta.json 与 schema.sql 表名必须一致；write_file SQL 失败必须立即修复

### 前端
- `composables/use-toast.ts` — 新文件：封装 sonner 为 `toast.success/error/info/warning/message/dismiss`，统一 duration（info/success 3s、error 5s）；默认 description 选项
- `App.vue` — `<Toaster>` 改为 `top-center` + `rich-colors` + `close-button` + `expand` + z-index 9999 避免被侧边栏遮挡
- 8 处业务代码（ModuleDetailPage/ModulesPage/SettingsPage/AdminPage/LoginPage、use-api、ChatInput、auth store）统一从 `composables/use-toast` 导入 toast
- `stores/chat.ts` `send()` finally — 加与 `connect()` 对齐的兜底：若 session 进入 terminal 状态但最后一条 assistant msg 的 streamDone 仍为 false，强制关流
- `components/chat/MessageBubble.vue` `isGenerating` 启发式加强：streamDone / aborted / messageError / modules.length>0 任一满足即不显示"进行中"（module cards 存在意味着后端已走到 finalize）

### 测试
- `tests/step-ux-polish-5.spec.ts` — 新增 8 条测试（T5-01 至 T5-07）全绿：
  - 流结束后 generating-banner 消失
  - modules 非空时 banner 不显示
  - bulk-generate 自愈
  - 不存在模块返回 400 友好错误
  - Toast 位置 = top-center
  - useToast 四个方法可用
  - 登录失败 toast 集成冒烟
- 回归：step-ux-polish-3 (10) + polish-4 (7) + polish-5 (8) + thinking-parser (10) + chat-resumable (7) + page-chat (22) + page-modules (12) + navigation (14) + e2e-flows (8) = 96 passed
- 已知无关失败：api-data.spec.ts 10 条（用 MODULE='user' 但该 fixture 在当前 DB 环境中缺失，与本次变更无关）

## Step-MCP-1 变更摘要
目标：把 MockForge 对外暴露为 MCP Server，让 IDE（Cursor / Claude Code）里的 AI 能直接访问 Mock 模块。

### 新增
- `src/server/core/api-key.ts` — HMAC-SHA256 API Key 生成/查找；`MCP_API_KEY_SECRET` 缺失时自动生成写回 .env
- `src/server/core/openapi-export.ts` — 从 `_meta.json` 构造 OpenAPI 3.0.3（供 MCP + 未来前端统一复用）
- `src/server/api/api-keys.ts` — `/api/users/me/api-key` GET / POST / DELETE（JWT 保护）
- `src/server/mcp/`
  - `context.ts` — AsyncLocalStorage 承载 per-request MCP 用户上下文
  - `auth.ts` — `X-API-Key` / Bearer 鉴权解析
  - `server.ts` — per-request McpServer 工厂（stateless）
  - `routes.ts` — Fastify 插件挂 `/mcp`（POST/GET/DELETE）
  - `tools/list-modules.ts` — 返回 name/status/health/endpoints/mockBaseUrl
  - `tools/get-api-doc.ts` — 读 api-doc.md，友好 isError
  - `tools/get-openapi.ts` — 输出 OpenAPI JSON + structuredContent
  - `resources/guide.ts` — `mockforge://guide` 使用指南（v1 只读边界明示）
- `docs/mcp-usage.md` — Cursor / Claude Code 配置、常见问题、安全考虑、路线图
- `tests/mcp-server.spec.ts` — 10 条集成测试（M01-M10）+ tests/page-settings-apikeys.spec.ts 4 条 UI 测试

### 修改
- `src/server/core/schema.ts` + `database.ts` — users 表加 `api_key_hash / api_key_created_at / api_key_last_used_at`；index on api_key_hash
- `src/server/server.ts` — 注册 `apiKeyRoutes` 和 `mcpRoutes`
- `src/client/pages/SettingsPage.vue` — 第三个 Tab "API Keys"：生成 / 重新生成 / 吊销；一次性明文 Dialog；MCP 配置片段块
- `.env.example` + `.env` — 加 `MCP_API_KEY_SECRET`

### 测试结果
- `tests/mcp-server.spec.ts`: 10/10 ✅（M01 鉴权、M02 握手、M03 工具发现、M04-M07 工具行为、M08 resource、M09 lastUsedAt、M10 用户隔离）
- `tests/page-settings-apikeys.spec.ts`: 4/4 ✅（A01-A04 空态/生成/吊销/重新生成）
- **完整回归**: 245 passed / 1 flaky (R11b navigation, retries 通过) / 3 skipped / 0 failed（含所有新增 14 条）

### 架构要点
- **stateless HTTP Transport**：每个请求新建 McpServer 实例 + transport，连接结束即销毁
- **用户上下文**：`mcpUserContext.run()` 包一层，tool handler 内 `getMcpUserId()` 取值
- **API Key 存储**：HMAC-SHA256 hash（O(1) 等值查询）而非 bcrypt（全表扫描），但 secret 需保密
- **Web UI + MCP 共享状态**：同一 Fastify 进程、同一 SQLite，Docker 部署天然匹配

### v2/v3 预留
- 写工具（create_module_from_spec / update_module）→ 下一 Step
- access_log / diff_with_openapi → 下一 Step
- stdio transport → v3 或永不做

## Step-MCP-2 变更摘要
目标：把 MockForge 完整读写能力通过 MCP 暴露，让 IDE AI 能跑完"PRD → 契约 → Mock → 业务代码 → 自测 → 修复 → 交接"全闭环。

### 新增工具（9 个，合计 MCP 工具 12 个）
- **业务侧感知（读）**
  - `get_mock_access_log` — 查某模块最近 N 次 `/mock/*` 请求（method/path/status/duration/body）
  - `get_module_health` — 独立诊断工具，返回 health/missingFiles/hasTable/tableName
  - `diff_with_openapi` — 递归比 actualRequest/Response 与 OpenAPI，输出 5 种 diff kinds
- **轻量写（即时生效）**
  - `delete_module` — 不可逆删模块（drop 表 + 删文件 + 清 modules 行）
  - `run_test` — 跑 module/test.ts 全 CRUD 回归
  - `manage_data` — insert/update/delete/batch_delete/clear/list/bulk_generate
- **重量写（桥接 ChatRunner，~30s-3min）**
  - `create_module_from_spec` — OpenAPI/YAML/自然语言 → 生成模块；支持 dry_run
  - `update_module` — 自然语言指令修改模块；返回 +/- entity/field/endpoint diff；支持 dry_run
- **汇报**
  - `generate_handoff_report` — 契约 + 健康 + 访问日志 + 后端建议的交接 markdown

### 新增基础设施
- `src/server/core/access-log.ts` — 记录每次 /mock/* 请求到 mock_requests 表；8KB body 截断；每用户滚动 cap 10000 条
- `src/server/mcp/lib/headless-session.ts` — MCP 写工具桥接 ChatRunner；provider 选择优先 scope=public（免费默认模型）→ 私有兜底；AsyncLocalStorage + AbortSignal；onProgress 只转发阶段摘要（不泄漏 LLM 内容）
- `src/server/mcp/lib/retry-counter.ts` — 24h 窗口 per-user:module:tool 计数；阈值 10 触发软 warning；不阻断调用

### 关键修改
- `src/server/core/mock-router.ts` — 每个 /mock/* 请求都 recordMockAccess；闭包收集 request/response body，finalize 在 reply.raw 'close' 事件触发
- `src/server/core/openapi-export.ts` — 为所有实体自动注入 id/created_at/updated_at 字段（反映 Mock 表实际结构，diff 工具才准）
- `src/server/mcp/resources/guide.ts` — 完全重写，含 12 工具决策树、推荐 9 步工作流、progress/warnings/dry_run 语义

### 测试
- `tests/mock-access-log.spec.ts` — L01-L05（插入/响应体/请求体/截断/滚动 cap）
- `tests/mcp-server-v2.spec.ts` — M11-M32 共 22 条（只读增强 / diff / 轻量写 / 重量写 / 交接 / guide / 真实 LLM）
- `tests/mcp-headless-session.spec.ts` — H01-H02（__fake__ 流 + 无 provider 错误）
- `tests/mcp-retry-counter.spec.ts` — R01-R04
- 其中 **M25/M32 用 admin 配置的免费 gemma provider 真跑 LLM**，用户明确确认允许消耗

### 架构要点
- **MCP 开的 session 写入共享 sessions 表**：Web UI 天然可见 + 可接管；会话标题 `[MCP] create xxx` / `[MCP] update xxx`
- **stateless per-request McpServer**：每个 MCP 请求新建实例 + transport，用户上下文 AsyncLocalStorage 注入
- **access log 不阻塞响应**：reply.raw 'close' 事件异步记录；失败吞掉
- **滚动 cap 10000/user**：每 100 次 insert 触发一次 trim（DELETE WHERE id NOT IN (最新 10000)），均摊成本低

### 已知 flaky
- `tests/mcp-server-v2.spec.ts` M32 `update_module 真实修改`：gemma 在 update 分支延迟偏大，setTimeout=300s 下偶尔需 retry。Playwright retries 策略使其最终绿（同 R11b 先例处理），不阻塞 CI

## Step-MCP-3 变更摘要
目标：修 mock-router 状态码强制语义 + 让规范契约在 AI 生成时真正被遵循 + 暴露 provider/model/preset 入口（MCP + Web UI）。

### 核心变更
- **mock-router 放权**（`src/server/core/mock-router.ts`）：删除 `success:false → 404` 强制映射；新增 `__mock__` 逃生舱（status/headers/body）+ `statusCode` 字段显式覆盖；阿里风格 `{code, data, msg}` 默认 200
- **system-prompt 重构**（`src/server/agent/system-prompt.ts`）：分层结构（用户/预设/默认三段独立分区）+ Step 1→2→3 决策流程硬规则 + 4 条"禁止动作"（折中/擅自补充/曲解/同项混合）+ 决策对账（write_file 前必填表）+ 冲突可见化（最终回复里声明 override）+ 默认最佳实践段（HTTP 状态码语义 / 业务校验失败默认 200 + success:false）
- **MCP 工具参数扩展**（`src/server/mcp/lib/headless-session.ts` + 两个工具 schema）：`create_module_from_spec` / `update_module` 接受 `provider?` / `model?` / `preset?`（id 或 name）；scope-aware 校验（user-owned 或 public）；未知 id/name 抛友好错误
- **Web UI 新建对话 dialog**（`src/client/components/chat/SessionConfigDialog.vue` + ChatPage）：点"新建对话"弹 dialog，3 个可选选择器，"跳过默认"一键；localStorage 记住上次选择
- **Web UI 对话中切换**（`src/client/components/chat/SessionMetaBar.vue`）：输入框上方显示 `{provider} · {model} · {preset}`；点击复用同 dialog（标题"切换会话配置"，描述"下一轮起生效"）；runStatus=running 时禁用 + 提示

### 关键修改
- `src/server/core/mock-router.ts` — 响应处理顺序：__mock__ → statusCode → 默认 200；statusCode 字段从 body 里剥除
- `src/server/agent/system-prompt.ts` — controller 模板里 `{ success: false, statusCode: 404 }` 展示新约定；默认最佳实践段解释"业务校验失败走 200，HTTP 4xx 留给真正的资源不存在"
- `src/server/mcp/lib/headless-session.ts` — 新增 resolveProviderOverride / resolvePreset（scope-aware）；HeadlessOptions 加 providerId/model/presetId/presetName
- `src/client/stores/chat.ts` — createSession 接受 model + null 过滤；updateSessionConfig 新增（PUT /api/sessions/:id）
- `tests/helpers.ts` — 新增 startNewChatSession helper 封装两步流程；32 处遗留 `click('text=新建对话')` 全部迁移

### 测试
- `tests/mock-router-response.spec.ts` — MR01-MR08 共 8 条（6 种响应形态 + 2 个边界）
- `tests/system-prompt.spec.ts` — SP01-SP06 结构/分区/回退
- `tests/mcp-priority.spec.ts` — P01-P07 决策流程 + 禁止动作 + 对账 + 冲突可见化
- `tests/page-chat-new-session.spec.ts` — NS01-NS04 dialog / skip / preset / provider→model 联动
- `tests/page-chat-switch.spec.ts` — SW01-SW03 meta-bar 显示 / 切换 model / running 禁用
- `tests/mcp-server-v2.spec.ts` 追加 M33-M37 — preset/model 覆盖 + 未知 id/name 友好错误
- T5-03 稳定性修复（从"第一个健康模块"改为明确 'user' fixture，避开 warehouse CHECK 约束）

### 测试结果
- 新增测试: 27 全绿（MR:8 + SP:6 + P:7 + NS:4 + SW:3 + M33-37:5）— 其中 M30 tools/list 仍是 12 个工具（无新增）
- 关键回归: page-chat(23/23) + api-data(13/13) + mcp-server-v2 ex-M25/M32(25/25) + api + responsive(51/51) + chat-resumable + page-modules + page-data-management + navigation + e2e-flows + step-ux-polish-3..5 = **223 passed**
- 已知 flaky（不阻塞验收）: M25/M32 真实 LLM 测试沿用 CURSOR.md 原策略（Playwright retries 策略使其最终绿）

## Step-MCP-4 变更摘要
目标:让"对话式注入业务约束"在 MCP 工具链端到端贯通 — 同一份 _meta.json 既驱动 OpenAPI 契约、又驱动 BaseModel 运行时校验、又驱动 diff_with_openapi 对账。

### 起因(用户实测痛点)
用户用 Cursor AI Agent 对 warehouse 模块跑 update_module 注入业务规则:
- ✅ api-doc.md / test.ts 都被改了
- ✗ get_openapi 输出里 status 仍是 string,没 enum
- ✗ diff_with_openapi 拿不到约束信息
- ✗ update_module 返回 "no structural diff detected" 误判 AI 没改

### 核心改动
- **_meta.json schema 扩展**(`src/server/core/meta-schema.ts`):新增 enum/min/max/pattern/minLength/maxLength/unique/description/default + entity.constraints[] (when/must/message + 范围条件 gt/lte 等);旧 enumValues/defaultValue 自动归一化
- **openapi-export 全面映射**(`src/server/core/openapi-export.ts`):field 约束 → schema.enum/minimum/maximum/pattern/minLength/maxLength/description/default;entity.constraints → POST/PUT/PATCH endpoint description 末尾 markdown 块
- **BaseModel.withMeta() auto-validate**(`src/server/core/base-model.ts` + `validator.ts`):controller 一行 `.withMeta('moduleName')` 接入,POST/PUT 自动校验,违反抛 `ValidationError`,模板 try/catch 转 400;支持 PATCH 语义(与 existingRow 合并后再校验跨字段);unique 走 DB 查询;未调用 .withMeta() 的老 controller 完全不受影响(back-compat)
- **diff_with_openapi 强化**(`src/server/mcp/tools/diff-with-openapi.ts`):新增 `constraint-violation` (enum/min/max/pattern) 和 `cross-field-violation` (从 _meta.json 直接读 entity.constraints);GET 跳过跨字段检查
- **update_module 富 diff**(`src/server/mcp/lib/update-diff.ts`):snapshot 加 constraintIds + testNames + controllerErrorBranches + controllerBytes + apiDocLines;diff 输出 `+constraint <id>` / `+test "<name>"` 等明细 + warnings (controller drift / api-doc drift) + `hasChange=false` 显式 silent-no-op 提醒
- **bulk_generate 约束感知**(`src/server/agent/tools/manage-data.ts`):faker 尊重 enum/min/max(单字段);跨字段约束在 seed 时跳过(用无 .withMeta() 的 model)
- **system-prompt 引导**(`src/server/agent/system-prompt.ts`):controller 模板改为 `.withMeta() + try/catch ValidationError`;新加"表达业务约束的优先级"段:**禁止**在 controller.ts 手写 if-throw 校验,优先 _meta.json field/constraints

### 测试
- `tests/meta-schema.spec.ts` — MS01-MS09 类型 + 归一化(9)
- `tests/openapi-constraints.spec.ts` — OC01-OC07 字段约束 + 跨字段 → OpenAPI 映射(7)
- `tests/validator.spec.ts` — V01-V16 单字段 + 跨字段 + PATCH 合并 + 范围条件(16)
- `tests/base-model-validate.spec.ts` — B01-B08 真实 HTTP 流 + back-compat(8)
- `tests/diff-with-openapi-constraints.spec.ts` — DC01-DC06 enum/min/pattern/cross-field 检测(6)
- `tests/update-module-richdiff.spec.ts` — RD01-RD14 snapshot/diff helpers + multi-signal(14)
- `tests/mcp-warehouse-constraints.spec.ts` — WC01-WC07 端到端复刻用户场景(7)

### 测试结果
- 新增测试: **67 全绿** (MS:9 + OC:7 + V:16 + B:8 + DC:6 + RD:14 + WC:7)
- 关键回归: api-data(13) + mcp-server-v2 ex-M25/M32(25) + mcp-warehouse-e2e(6) + manage-data-resolve(2) + mock-router-response(8) + step-ux-polish-5(8) = 62 + UI 完整批 (page-chat:23, chat-resumable, page-modules, page-data-management, navigation, e2e-flows = 86) = **148 passed**
- 已知 flaky(不阻塞):M25/M32 真实 LLM 测试沿用 Playwright retries 策略

## Step-MCP-5 变更摘要
目标:把 MCP 写工具的长任务体验做成"重发即续接" — AI 调 `update_module` 不再因客户端 timeout 而断链;断线后再发同样请求自动 attach 到在跑的 session,语义跟普通调用一样。

### 起因(用户实测痛点)
用户用 Cursor AI Agent 跑 `update_module warehouse`,5-10 min 长任务期间 Cursor 侧报 `Not connected`,需要 Reload Window 才能恢复。Step-MCP-3 的 in-flight-lock 解决了"不会重复创建 session"但 AI 续接体验仍差 — server 只会返 already-processing,AI 必须主动调专门工具才能拿到结果。

### 核心改动
- **headless-session 拆分**(`src/server/mcp/lib/headless-session.ts`):`runHeadlessSession` → `startHeadlessSession()` + `attachAndWait(sessionId, waitMaxSec)` 两相;legacy `runHeadlessSession` 保留为 start+attach 无限等的门面;新增 `getSessionSnapshot()` 给 get_session_status 工具用
- **写工具 waitMaxSec + onConflict**(`update-module.ts` + `create-module-from-spec.ts`):`waitMaxSec`(默认 60,上限 300);`onConflict: 'resume' | 'reject' | 'replace'`(默认 `'resume'`);attach-on-resume 返 `attached:true` + `actualInstruction` + `yourInstruction` + 不一致时 `warning`
- **2 个新会话工具**(`get-session-status.ts`, `cancel-session.ts`):5ms 快照 + 主动放弃;工具数 12 → 14
- **并发 gate**(`concurrency-gate.ts`):per-user 3 + 全局 10,env 可调(`MCP_USER_CONCURRENCY_LIMIT` / `MCP_GLOBAL_CONCURRENCY_LIMIT`);attach 不计数(重发不会触发 BUSY);BUSY 响应列出 `runningSessions`
- **heartbeat**(`chat-runner.ts`):每 `CHAT_HEARTBEAT_MS`(默认 30000)强发一条 `heartbeat` 事件,持久化到 message_events + 通过 progress notification 透传给 client → transport 不会 idle 断;前端 switch 未 handle 类型自动忽略
- **统一错误码**(`error-codes.ts`):所有 MCP 工具 `isError` 响应带 `code` + `hint` + 场景特定字段
- **instruction 比对辅助**(`instruction-utils.ts`):normalize(trim + 折空白 + 大小写) 决定是否 emit drift warning;永不阻断
- **guide + 工具 description 全面更新**:加"⚡ 单模块单流程 + 自动续接"章节,写工具 description 含 waitMaxSec/onConflict,会话工具 description 互相 cross-link

### 测试
- `tests/headless-attach.spec.ts` — HA01-HA05 start/attach 两相 + legacy 门面(5)
- `tests/mcp-attach-resume.spec.ts` — AR01-AR08 attach-on-resend + onConflict + drift warning + normalize(8)
- `tests/mcp-session-tools.spec.ts` — ST01-ST06 get_session_status + cancel_session(6)
- `tests/mcp-concurrency.spec.ts` — CC01-CC05 concurrency gate 单元(5)
- `tests/mcp-heartbeat.spec.ts` — HB01-HB02 heartbeat 事件持久化 + payload 结构(2)
- `tests/mcp-error-codes.spec.ts` — EC01-EC04 统一错误码 + hint(4)
- `tests/mcp-guide-resume.spec.ts` — GR01-GR03 guide + 工具 description(3)
- `tests/mcp-resume-e2e.spec.ts` — E01-E03 端到端复刻用户场景 + BUSY 并发限制(3)

### 测试结果
- 新增测试: **36 全绿** (HA:5 + AR:8 + ST:6 + CC:5 + HB:2 + EC:4 + GR:3 + E:3)
- 回归: M30 更新为 14 个工具列表;D04 加 onConflict='reject' 保持原语义;M25/M32 加 waitMaxSec=300 对齐 5min LLM 预算。完整套件 430+ passed
- 已知 flaky(不阻塞):M25/M32 真实 LLM 测试沿用 Playwright retries 策略

### 架构要点
- **per-user 单模块单流程**依旧由 `findInFlightSession` + ChatRunner 注册表保证;Step-MCP-5 只是改"第二次调用"的默认响应
- **attach-on-resume 不动 DB**:只是起一个新 subscribe(0) 订阅已有 runner 的 DB + live 事件,DB 里还是原 session
- **gate 在 backend process 内存**:跨进程不共享(重启清零);release 通过后台 watcher `attachAndWait(sessionId, undefined)` 订阅 runner 的 close 事件实现
- **heartbeat 每 30s 一条 → 24h × 2880 = 86.4K 条/session**:可接受(SQLite 批量写快);前端默认过滤不影响 UI

## Step-Perf-1 变更摘要
目标:让 MockForge MCP 在 IDE AI Agent 场景下真正快而好用。上一轮 MCP-5 把 7-15min 的长任务做了续接保护;本轮把绝对时长砍下来到 3-5min 范围,同时把工具表面精简、进度语言人话化、错误 AI-actionable。

### 起因(用户实测痛点)
- 生成单个模块要 7-15 分钟(write_file 单次调用 5-6 轮 LLM round-trip)
- 14 个 MCP 工具里 3 个读工具语义高度重叠(get_api_doc + get_openapi + get_module_health),AI 决策压力
- update-module.ts + create-module-from-spec.ts 70% 代码同构,维护成本高
- 进度事件 "tool:write_files" 泄漏工具名给用户
- 错误消息是人类 hint 文本,AI 需要解析才能决定下一步

### 核心改动(8 Task,里程碑 M1 + M2 + M3)

**M1 — 生成链路提速:**
- **M1.1 system prompt 瘦身**(`agent/system-prompt.ts` + `agent/templates/samples.ts` + `agent/tools/get-module-template.ts`):18020B → 7274B;120 行 todo 模板移出到 `get_module_template(kind: 'crud-basic' | 'with-constraints')` Agent 工具,AI 需要时再拉
- **M1.2 batch write_files**(`agent/tools/write-files.ts` + `tool-registry.ts` 注册替换):一次调用写 N 个文件,事务语义(snapshot + atomic commit + 失败全回滚 fs+DB);AI 生成模块从 5-6 次 LLM round-trip 降为 1 次;旧 write_file 工具从 registry 移除(但内部 `writeFile()` 辅助函数保留给测试用)
- **M1.3 provider-aware prompt caching**(`agent/prompt-cache.ts`):按 provider.type 注入 `providerOptions` — Anthropic 加 `cacheControl: ephemeral`,OpenAI-compat 依赖 backend 自动 cache(前缀字节稳定,PC05 测试验证);env `ENABLE_PROMPT_CACHE=0` 可关;日志 `[prompt-cache]` 行便于观察
- **M1.4 per-session mutex**(`agent/lib/session-mutex.ts`):write-side 工具(write_files / run_test / manage_data / delete_module)在同一 session 内串行避免 race;read-side 工具(read_file / list_modules / get_module_template)仍可真正并行;`buildTools(userId, runner?)` 只在 runner 存在时上锁

**M2 — 工具表面简化 + UX 打磨:**
- **M2.1 inspect_module 合并**(`mcp/tools/inspect-module.ts`):`inspect_module(moduleName, view?: 'all'|'doc'|'openapi'|'health')` 替代原 `get_api_doc` + `get_openapi` + `get_module_health`;默认 view=all 一次拿全部;工具数 14 → 12
- **M2.2 write-tool-runner 抽象**(`mcp/lib/write-tool-runner.ts`):从 update-module.ts + create-module-from-spec.ts 提取共享的 in-flight 检查 + concurrency gate + onConflict 路由 + attach-resume + 响应构造;update-module 346 → 153 行,create-module 409 → 229 行(各个工具只保留差异化的 buildSuccessResponse/buildStillRunningResponse)
- **M2.3 module-repo + recovery_steps**(`core/module-repo.ts` + `mcp/lib/error-codes.ts`):`getModuleRow` / `loadMeta` / `readModuleFile` 集中 8+ 处散落查询;每个 `mcpError` 现在带 `recovery_steps: Array<{ tool, args, description } | { action, description }>` 供 AI 机读下一步;默认 per-code 自动注入,也可显式传
- **M2.4 UX polish**(`mcp/lib/stage-humanize.ts`):`humanizeStage(raw)` → `{ description(中文), expectedRemainingSec, suggestedNextAction(AI hint) }`;MCP progress notification + still-running 响应 + get_session_status 三处都改用 humanized 版本;MCP 错误文本前缀 `[MOCKFORGE_XXX]` 便于 AI 扫描

**M3 — 端到端验收:**
- **M3.1 perf-e2e smoke**(`tests/perf-e2e.spec.ts`):__fake__/__fake_slow__ 打通全链路(PE01-PE04 共 4 条);真实 LLM M25/M32 待用户用 AI Agent 实测

### 工具集变化(12→12 保持但合并了读工具 + Agent 侧新增 get_module_template)
- **MCP (12)**:list_modules, inspect_module, get_mock_access_log, diff_with_openapi, delete_module, run_test, manage_data, create_module_from_spec, update_module, get_session_status, cancel_session, generate_handoff_report
- **Agent (8)**:set_module_intent, write_files(新), read_file, run_test, manage_data, list_modules, delete_module, get_module_template(新)
- 删除:`write_file`(Agent 侧)、`get_api_doc` + `get_openapi` + `get_module_health`(MCP 侧)

### 测试(40+ 新增 + 全部回归绿)
- **单元**:GT01-05(模板库) + SP07(prompt 体积回归) + WF01-06(batch write + 事务) + PC01-06(provider-aware cache) + PT01-04+PT-T01-03(session mutex) + IM01-05(inspect_module) + ER01-07(recovery_steps) + MR01-06(module-repo) + UX01-04(humanize) + PE01-04(perf E2E smoke) = 共 50 条
- **回归**:MCP-5 全套 AR/E/ST/CC/HB/EC/GR 各文件全绿(见各 Task 的 commit message)
- **已知 flaky**(不阻塞,沿用既有策略):M25/M32(真实 gemma LLM) + W06(真实 LLM diff)

### 度量对比(改造前后)
| 指标 | 改造前 | 改造后 |
|-----|-------|-------|
| 生成 6 文件模块时长 | 7-15 min | 预计 3-5 min(batch write + cache) |
| LLM round-trip 次数 | 5-6 | 1-2 |
| system prompt 体积(empty) | ~18 KB | **~7.3 KB** |
| MCP 工具数 | 14 | 12 |
| update-module.ts + create-module-from-spec.ts 总行数 | 755 | 382(+ runner 283) |
| 回归测试数 | 430+ | 470+(全绿,新增 40+) |

## Step-Perf-2 变更摘要
计划文档:`plans/STEP-PERF-2-PLAN.md`

### 起因(用户 Cursor 实测暴露)
用户用 Cursor + gemma-4-31b 实测 `create_module_from_spec`,任务悬挂 1 小时没生成模块。查 DB 事件清单发现:6 次 `write_files` tool_call 的 args 都是空对象 `{}`,AI 反复失败循环。根因是 Step-Perf-1.2 删除了 `write_file` 单文件工具,只保留 `write_files` 的**嵌套数组 schema**,gemma-31B 小模型无法正确填充该 schema。同时我的所有 Step-Perf-1 测试都用 `__fake__` 跳过真实 LLM,完全没覆盖这条路径。

### 核心修复(5 Task)
- **P2.1 恢复 `write_file`**(`agent/tool-registry.ts` + `agent/system-prompt.ts`):保留 `write_files`(快通道),并行再注册 `write_file`(弱模型退回);system-prompt 按模型能力引导 AI 选择,新增硬规则 "若 write_files 返 'no files provided' 立即切 write_file"
- **P2.2 write_files 空 args 错误优化**(`agent/tools/write-files.ts`):错误 message 明确教 AI 正确 schema + 指向 write_file 退回;错误 error 字段含 "switch to write_file" 关键词便于日志统计
- **P2.4 default waitMaxSec 60→180s**(`mcp/lib/write-tool-runner.ts`):对齐真实 LLM round-trip 节奏(30-90s),避免 60s 几乎必定触发 still-running 导致客户端无谓重发
- **P2.3 real-LLM E2E 验收门槛**(`tests/real-llm-e2e.spec.ts`,新):RLM-01~04 用真实 gemma 跑 create/update/manage_data/inspect_module 全链路;RLM-01 作为 Step-Perf-2 硬验收(不绿就不算完成);以后不依赖用户手测
- **bonus:stopWhen stepCountIs 20→40**(`CHAT_MAX_STEPS` env 可调):真实 LLM 经常要 25-35 步才收敛(edit → test fail → fix SQL → fix controller → re-test);20 步不够,40 足够

### 测试
- RLM-01 真跑 gemma 端到端:首次 6.9min 通过,5 个核心文件落盘(_meta.json + schema.sql + controller.ts + test.ts + seed.sql),/mock/rlm_warehouse 可访问
- WF06 更新断言新引导消息
- 非真实 LLM 回归(34 条关键套件):全绿

### 教训
- **测试不能只用 mock**:__fake__ 跳过 AI tool-call 解析,完全绕过 schema 能力检测
- **简化 ≠ 删除**:Step-Perf-1.2 删 write_file 是过度冒进,忽略了模型差异
- **@real-llm 这类硬验收门槛必须存在**:以后所有涉及 tool schema 改动的 Task 都必须跑一次真实 LLM E2E

## 下一步
Step-Perf-1 + Step-Perf-2 完成。若用户真实 LLM 实测仍有问题,备选 Step-Perf-3:模型能力探测(首次失败自动 fallback)、模块生成结果缓存、sampling、thinking 预算自适应。
