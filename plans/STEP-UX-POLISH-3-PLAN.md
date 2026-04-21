# STEP-UX-POLISH-3 计划

## 背景

用户反馈的 8 个问题（合并整理，轮询问题按用户要求暂缓）：

| # | 问题 | 类型 | 优先级 |
|---|------|------|--------|
| 1 | 字符级打字机输出（目前整行 burst） | UX | **P0 核心** |
| 2 | 已用时计时切换页面后从 1s 重新开始（bug） | Bug | P0 |
| 3 | 进行中横线动画不好看，只要 loading + 时间 | UX | P0 |
| 4 | 思考中不展示具体内容（防泄漏代码结构） | Safety | P0 |
| 5 | AI 完成后输出用户友好摘要，不提项目内部细节 | Content | P1 |
| 6 | 模块状态机：创建中/编辑中/就绪；生成中禁止点击 | Feature | P1 |
| 7 | 会话一直"进行中"无法自愈（超时熔断） | Bug | P1 |
| 8 | 文档支持下载 + 一键复制 | Feature | P1 |
| — | 会话列表轮询 | 架构 | **DEFERRED** |

---

## Task 1 — 字符级打字机效果（核心）

**问题**：后端 flush 时批量推送整段 text，前端一次性追加，视觉上"一行一行"出现。

**目标**：ChatGPT/Claude 风格的逐字符出现，自适应速率。

### 方案

**两层 buffer**：
```
server push text event → pendingChars 队列（原始字符）
                                ↓
                 rAF 节流器每 15ms 取 N 个字符
                                ↓
                         displayedContent
                                ↓
                       markdown-it 渲染 → v-html
```

**自适应速率**：
- 队列 ≤ 20 字符：慢速（约 60 字符/秒，每 tick 1 字）
- 队列 21-200：正常（约 180 字符/秒，每 tick 3 字）
- 队列 > 200：快速（约 600 字符/秒，每 tick 10 字）
- 流结束（`done`/`aborted` 事件）：队列剩余立即 flush 全部

**历史消息不应用打字机**：
- `streamDone === true` → 直接展示完整 content
- 只对 **正在流** 的消息应用

### 性能优化

- Markdown 重渲染 throttle 到 50ms 一次（即 20fps），独立于取字 tick
- 很长（>2000 字）消息：仅对尾部未完成段落做打字机，前面 markdown 已渲染完整 block 不重算

### 实现位置

- 新增 `src/client/composables/use-typewriter.ts`
- `MessageBubble.vue` 的 `renderedContent` 基于 `displayedContent` 而非 `props.content`
- 监听 `props.content` 变化 → 把新增部分推入 pendingChars 队列
- `streamDone` flip true 时立即 flush

### 测试

- 手动：切到 chat 页，发 `__fake__` 消息，观察字符逐个出现
- Playwright 可加一条：验证 500ms 内 displayed 长度少于最终，1500ms 后等于最终

---

## Task 2 — 计时器基于消息开始时间（修 bug）

**问题**：`MessageBubble` 组件在路由切换时销毁重建，`startTs = Date.now()` 重置到当前时间。

### 方案

- **后端** `messages` 表新增 `started_at` 字段（已有 `created_at`，但 `started_at` 语义更准确 = runner 开始处理该 message 的时刻）
  - `ChatRunner` 创建 assistant message 时写入 `started_at = now()`
  - 迁移：alter table 加字段，默认回填为 `created_at`
- **事件流** `user` / `assistant` 事件 payload 带上 `startedAt` 时间戳
- **客户端** StreamEvent 消息对象加 `startedAt: number`
- **MessageBubble** 计时改为：
  ```ts
  const elapsedSec = computed(() => {
    if (!props.startedAt) return 0;
    return Math.floor((now.value - props.startedAt) / 1000);
  });
  // now 每秒更新（onBeforeUnmount 清理）
  ```
  组件重挂载时 `startedAt` 从 props 来，不重置。

### 影响范围

- `schema.ts` / database migration
- `chat-runner.ts` 写入时
- `chat.ts` 事件 payload
- `stores/chat.ts` DisplayMessage 类型
- `MessageBubble.vue` 计时逻辑

---

## Task 3 — 去掉进行中动画横线

**改动**：仅 CSS，无逻辑变化。

- 删除 `.progress-track` + `.progress-bar` 元素
- 删除 `@keyframes progress-indeterminate`
- 保留 Loader2 图标 + "进行中..." + 已用时

**最终形态**：
```
⟳  进行中...                   12s
```

---

## Task 4 — 思考中只展示状态

**安全需求**：AI 的思考内容包含文件路径/表名/代码片段，对用户是内部细节泄漏。

### 方案

- MessageBubble 保留 `hasThinking` / `isThinking` / `thinkingComplete` 状态
- 保留思考徽章："思考中..." / "已完成思考"
- **删除** 可折叠展开的思考内容区（`thinking-body` div）
- **删除** `renderedThinking` computed
- 后端仍持久化 thinking 到 DB（将来管理员工具可读，不影响用户视图）
- 思考徽章不可点击展开（纯显示）

---

## Task 5 — AI 完成摘要约束（system prompt）

**需求**：AI 任务结束时，在最后一段 text 里给用户一句话的成果摘要，**不提文件名/表名/代码结构**。

### 方案

编辑 `src/server/agent/system-prompt.ts` 追加约束：

```
## 输出语言规范
- 任务完成后，用一句自然语言总结交付物。禁止提及：
  - 具体文件名（如 _meta.json, controller.ts）
  - 数据库表名、字段名的英文 identifier
  - 代码结构、技术栈细节
- 允许提及：接口数量、业务字段的中文名、模块的功能说明
- 示例：
  ✓ "已为你创建订单管理模块，包含 5 个接口（列表、详情、创建、更新、删除），数据字段含订单号、金额、状态、创建时间等。"
  ✗ "已写入 _meta.json、schema.sql、controller.ts 等 6 个文件，通过 run_test 验证全部接口。"
```

**影响**：仅影响新生成的模块。已有的 user/order 模块文档不变，用户可通过对话让 AI 重新总结。

---

## Task 6 — 模块状态机

### 数据层

- `modules.status` 枚举扩展：`creating | editing | active | error`（原先只有 active）
- 迁移：已有记录默认 active

### 后端

- `ChatRunner.startRun()` 前：
  - 解析用户意图（创建新模块 / 编辑已有模块）
  - 若新建 → insert modules 记录 status='creating'
  - 若编辑已有 → update modules set status='editing'
- `ChatRunner.finalize(status)`：
  - status='done' → update modules set status='active'
  - status='error' → update modules set status='error', 存 errorMessage
  - status='aborted' → 回滚到上次稳定 status（若从未成功则删除记录）

### 前端

- ModulesPage 卡片增加状态徽章：
  - `creating` → 蓝色 "创建中..." + Spinner + `pointer-events: none` + 降透明度
  - `editing` → 黄色 "编辑中" + 可点击，详情页顶部加黄色横条提示
  - `active` → 绿色 "就绪"（或无徽章，跟现状）
  - `error` → 红色 "失败" + 错误 icon + 点击查看错误详情
- 列表项点击事件：`creating` 状态阻止跳转并 toast 提示

### 风险

- 如何判断"用户意图是创建还是编辑"？方案：让 AI 在 system prompt 里要求，首次 tool_call 必须是 `set_module_state('creating'|'editing', moduleName)`，由后端拦截更新 DB。
- **简化方案**：检测 `write_file` 的路径，若路径是新模块目录 → creating；若模块已存在 → editing。这个逻辑在 chat-runner hook 里判断。

---

## Task 7 — 会话运行超时熔断 + 状态同步

**问题**：会话显示"进行中"长达 80s+，可能是后端卡死或前端状态不同步。

### 后端

- `ChatRunner` 加总超时（默认 3 分钟，可配置）：
  - `run()` 启动时 `setTimeout(forceFinalize, TIMEOUT)`
  - 正常结束时 clearTimeout
  - 超时触发 → `finalize('timeout')` + 记录 event 'timeout'
- 启动时清理：`database.ts` 已有清理 running 状态的僵尸记录（Step-Chat-Resumable 场景4）— 扩展为检查 `updated_at` 超过 3min 的 running 记录也一并 reset

### 前端

- ChatPage mount 时：
  - 对所有 `runStatus === 'running'` 的 session：
    - 若最后活动时间 > 3min 前 → 客户端认为已 timeout，显示 "疑似超时" + "重新拉取"按钮
  - 点进来的 session：`GET /api/chat/stream?afterSeq=lastSeq` 主动同步一次

### 测试

- 手工：发一条消息，kill 后端进程，重启，观察状态
- 自动：手工构造 messages 表一条 runStatus='running' + updated_at=很早，验证 UI 提示

---

## Task 8 — 文档下载 + 复制 + OpenAPI 导出

### Documentation Tab 顶部工具栏

```
[📋 复制全文]  [📥 下载 Markdown]  [📥 下载 OpenAPI JSON]
```

### 实现

- **复制**：`navigator.clipboard.writeText(docContent)` + toast "已复制"
- **下载 MD**：
  ```ts
  const blob = new Blob([docContent], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `${moduleName}-api-doc.md` });
  a.click();
  URL.revokeObjectURL(url);
  ```
- **OpenAPI 导出**：
  - 读 `moduleData.meta` (含 entities / endpoints)
  - 转换成 OpenAPI 3.0 JSON：
    - `info`: { title: displayName, version: 1 }
    - `paths`: 从 endpoints 映射
    - `components.schemas`: 从 entities.fields 映射（type 映射：string→string, integer→integer 等）
  - 下载为 `${moduleName}-openapi.json`

详细映射规则见 PLAN.md §Step 21。

---

## Task 顺序 + 粗略工时

| 顺序 | Task | 工时 | 依赖 |
|------|------|------|------|
| 1 | Task 3 去动画横线 | 10min | 无 |
| 2 | Task 4 隐藏思考内容 | 15min | 无 |
| 3 | Task 8 文档下载/复制 | 30min | 无 |
| 4 | Task 2 计时器 startedAt | 1h | DB 迁移 |
| 5 | Task 1 打字机效果 | 1.5h | 无 |
| 6 | Task 5 system prompt | 10min | 无 |
| 7 | Task 7 超时熔断 | 1h | DB 状态字段 |
| 8 | Task 6 模块状态机 | 2h | DB 迁移 + 后端 hook + UI |

**合计**：约 6-7 小时。

**建议分 2 批交付**：
- **Batch A（3-4h）**：Task 1/2/3/4/5/8（UX + 内容层，核心打字机 + bug 修复 + 安全）
- **Batch B（3h）**：Task 6/7（架构层，需要 DB 迁移 + 跨模块 hook）

---

## 测试策略

### 新增 Playwright 测试

| Test | 覆盖 |
|------|------|
| T01 打字机按字符追加 | Task 1：500ms 内 displayed < final，1500ms 后 =final |
| T02 计时器切页后不重置 | Task 2：等 2s → 切到 /modules → 切回 → 读 elapsed ≥ 2 |
| T03 横线动画不存在 | Task 3：`.progress-bar` 元素不存在 |
| T04 思考内容不暴露 | Task 4：thinking 徽章可见，但 thinking-body 不在 DOM |
| T05 文档复制按钮 | Task 8：点击后 toast 出现 |
| T06 文档下载 MD | Task 8：拦截 download 事件，验证文件名和 content-type |
| T07 模块 creating 禁点击 | Task 6：mock 一个 status=creating 的模块，验证 pointer-events |

### 回归

- 所有现有 202 测试保持全绿
- 打字机改动不影响 chat-resumable 的 5 大场景

---

## 风险点

1. **打字机性能**：超长消息（>3000 字）重渲 markdown 可能卡顿
   - 应对：throttle + 分段渲染（已完成 block 不重算）
2. **startedAt 迁移**：已有 messages 记录无此字段
   - 应对：迁移默认用 `created_at` 回填
3. **模块状态机的 creating/editing 判断**：AI 可能绕过约定
   - 应对：基于 write_file 路径的启发式判断（副作用小）
4. **超时熔断误判**：AI 正常生成 3 分钟以上的大模块可能被误杀
   - 应对：超时阈值改配置（env），默认放宽到 5 分钟

---

## 不做 / 暂缓

- 会话列表轮询改 SSE push（用户明确延后）
- AI 约定 "我将执行 N 步"的真进度条（过度设计）
- 思考内容的管理员查看工具（用户未要求）

---

## 用户决策（已确认）

- [x] **整体方案同意**
- [x] **一次做完 Batch A + B，不允许偷工减料**
- [x] **模块状态：AI + 后端共同判断** — 新增 agent tool `set_module_intent`，AI 开工前声明 `(moduleName, operation)`，后端对照 DB 实际状态纠偏
- [x] **超时阈值 5 分钟**

### 模块状态机最终设计

```
AI 收到用户请求
   ↓
系统提示要求：第一个动作必须是 set_module_intent({moduleName, operation})
   ↓
后端 tool handler:
  1. 读 DB，查模块是否存在
  2. 纠偏：
     - AI 声明 'create' + DB 已存在  → 改为 'edit'（log warn）
     - AI 声明 'edit'  + DB 不存在   → 改为 'create'
  3. insert/update modules.status = 'creating' | 'editing'
  4. emit user event → 前端列表徽章立即更新
   ↓
AI 继续其余 write_file / run_test
   ↓
ChatRunner.finalize:
  - 'done'    → status='active'
  - 'error'   → status='error', errorMessage
  - 'timeout' → status='error', '生成超时'
  - 'aborted' → 若 status 是 creating 从未成功 → 删除; 否则回 active
```
