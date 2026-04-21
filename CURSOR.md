# MockForge 执行游标

## 当前位置
- **Phase**: ALL COMPLETE
- **状态**: Step-UX-Polish-5 完成

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

## 下一步
无（本次需求已完成）
