# STEP-CHAT-RESUMABLE-PLAN — 对话可恢复/可持久化/可后台执行 重构计划

> 目标：把当前"HTTP 流生命周期 = 生成生命周期"的强耦合架构，改造为"后台 Runner + 事件日志 + 可恢复订阅"的解耦架构，满足 5 项硬性需求：
> 1. 所有对话内容（含 thinking/卡片/工具调用/错误）全部持久化；暂停也保留已输出内容；可在原基础继续。
> 2. 上下文策略清晰：同会话沿用，切模块=新会话自动载入模块文档。
> 3. 富内容（卡片/图片/md）基于事件类型标记统一持久化。
> 4. 切换会话/切换页面再切回 — 状态不丢，未接收的内容无缝续播。
> 5. 客户端断开 → 后端继续执行完毕并持久化；再次打开显示"未读"红点；点回即看到完整回复。

---

## 一、架构总览

### 1.1 核心抽象

```
ChatRunner (per session, in-memory)
  ├── AbortController          — 控制当前 AI SDK 调用
  ├── EventEmitter             — 实时推送事件给所有订阅者
  ├── status: idle|running|paused|done|error
  ├── currentMessageId         — 当前正在写的 assistant 消息
  └── lastSeq                  — 事件序号游标

message_events 表 (append-only event log)
  ├── id, session_id, message_id, seq
  ├── type: thinking|text|tool_call|tool_result|card|image|md|error|done|aborted
  └── payload (JSON)

订阅协议 GET /api/chat/stream?sessionId&afterSeq=N
  ├── 阶段 1: 回放 DB 中 seq > N 的事件
  └── 阶段 2: 挂到 runner EventEmitter，接收实时事件
```

### 1.2 关键不变量
- **事件日志是唯一真相**：UI 显示、刷新恢复、重连续播全部基于 `message_events`。
- **Runner 生命周期 ⊥ HTTP 生命周期**：POST /api/chat 启动 runner 后立即返回 messageId；订阅走独立 GET 流。
- **事件单调递增 seq**：客户端用 `lastSeq` 实现 at-least-once 续播（幂等去重）。

---

## 二、数据库改动

### 2.1 新增表 `message_events`
```ts
export const messageEvents = sqliteTable('message_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  messageId: integer('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),           // 会话内单调递增
  type: text('type').notNull(),            // thinking|text|tool_call|tool_result|card|image|md|error|done|aborted|paused
  payload: text('payload').notNull(),      // JSON
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (t) => [
  uniqueIndex('msg_events_session_seq_unique').on(t.sessionId, t.seq),
]);
```

### 2.2 `sessions` 新增字段
```ts
runStatus: text('run_status').default('idle'),   // idle|running|paused|done|error
hasUnread: integer('has_unread').default(0),
lastSeq: integer('last_seq').default(0),
```

### 2.3 `messages` 新增字段
```ts
paused: integer('paused').default(0),       // 被用户暂停的 assistant 消息标记
finalizedAt: text('finalized_at'),          // runner 完成/中止的时间
```

> 旧字段（thinking / toolCalls / modules / messageError）保留兼容读取，但**新写入走事件日志**；后续一个清理 Step 再移除。

### 2.4 迁移
在 `src/server/core/database.ts` 添加 ALTER TABLE + CREATE TABLE 迁移。

---

## 三、服务端改动

### 3.1 新建 `src/server/agent/chat-runner.ts`（核心）
职责：
- 启动一次生成，把 `fullStream` 事件批量合并后 **同时** append 到 DB + emit 给 EventEmitter。
- 暴露 `pause()` / `abort()` / `subscribe(afterSeq)` / `getStatus()`。
- 全局单例 `Map<sessionId, ChatRunner>`。
- 空闲 30min 自动清理（paused 保留更久，如 24h）。

关键方法骨架：
```ts
class ChatRunner {
  async start(opts): Promise<{ messageId: number }>
  pause(): void                          // abort current AI call, status=paused
  subscribe(afterSeq: number): AsyncIterable<Event>
  static get(sessionId): ChatRunner | null
  static getOrCreate(sessionId): ChatRunner
}
```

文本合并策略：`text-delta` 在 runner 内按 200 字符或 50ms flush 成一条 `text` 事件，避免事件日志过碎。

### 3.2 改造 `src/server/api/chat.ts`
- `POST /api/chat` 不再直接流；变为：
  1. 写入 user 消息（含 events: type=user_content）。
  2. `ChatRunner.getOrCreate(sessionId).start(...)`。
  3. 立即返回 `{ messageId, startSeq }`，不 hold 连接。
- `POST /api/chat/pause` — 找到 runner 调用 `pause()`；若无 runner 返回 409。
- `POST /api/chat/continue` — 在现有 session 上以"继续"语义重新调用 start（见 §5）。
- `GET /api/chat/stream?sessionId&afterSeq=N` — SSE/NDJSON：
  ```
  1. 从 DB 回放 seq > N 的事件
  2. runner = ChatRunner.get(sessionId)
  3. if runner && running: 挂 EventEmitter 继续推送
  4. 客户端断开时移除订阅，但 runner 不中止
  ```

### 3.3 改造 `src/server/agent/agent-runner.ts`
- 去掉 `onFinish` 内的持久化（持久化改由 ChatRunner 在事件归集时做）。
- 纯粹返回 `{ fullStream, providerType, modelName }`，不再关心 DB。

### 3.4 已有 `ThinkingParser` 复用
在 ChatRunner 内用，解析出 `thinking` vs `text`。

---

## 四、上下文策略

| 场景 | 行为 |
|------|------|
| 同会话持续对话 | 全量 history + moduleContext（现状保留） |
| 同会话超出 token 预算 | 保留 system + 最近 N 轮 + 早期对话 summary（新增 summarizer — 可延后实现） |
| 用户在对话内切换模块 | 不允许（已是现状）；必须新建会话 |
| 删除会话新建同模块会话 | 全新上下文；自动从 `generated/<uid>/<module>/_context.md` 载入（现状保留） |
| "继续"指令（暂停后） | 把最后一条被 pause 的 assistant 消息（拼接其事件日志生成的 partial 文本）作为 assistant 历史，新 user message = "请继续"（或用户自行输入）。System prompt 附加一行提示："上次响应被用户中断，若用户要求继续，请在原基础接着输出。" |

---

## 五、暂停/继续语义详解

**暂停（pause）：**
1. 前端调 `POST /api/chat/pause`。
2. ChatRunner.abort() → AI SDK 抛 AbortError。
3. Runner 捕获，flush 所有未写事件 → append `{type: 'paused'}` → `messages.paused=1, finalizedAt=now`。
4. `sessions.runStatus='paused'`。
5. 前端 UI 显示"已暂停，输入消息继续"。

**继续（continue）：**
- 用户下一条 user 消息（任何内容）触发 `POST /api/chat` 时：
  - 后端检测到上一条 assistant 消息 `paused=1`：
    - 合并上次 partial assistant 文本进 history。
    - 本次 start 正常走（新 messageId）。
  - 或用户点击专门的"继续"按钮 → POST /api/chat/continue（等价，自动发空/默认继续文案）。

---

## 六、前端改动

### 6.1 `src/client/stores/chat.ts` 扩展
把 streaming 状态从组件搬到 store，按 sessionId 维护：
```ts
interface SessionStreamState {
  messages: ChatMessage[];
  lastSeq: number;
  status: 'idle'|'running'|'paused'|'done'|'error';
  subscription: ReadableStreamDefaultReader | null;
  hasUnread: boolean;
}
const streams = ref<Map<string, SessionStreamState>>(new Map());
```

动作：
- `connect(sessionId)` — 确保该会话有订阅；若已有则复用。
- `disconnect(sessionId)` — 关闭 reader（但**不取消服务端 runner**）。
- `send(sessionId, content)`、`pause(sessionId)`、`continueStream(sessionId)`。
- 路由切换时 **不** disconnect（或在全局 app.vue 层维持 N 个并行订阅）；至少保活当前活跃 session。

### 6.2 `ChatPage.vue` 重构
- 删除本地 `chatMessages`/`abortController`；读 `chatStore.streams.get(activeSessionId)`。
- 切 session：`chatStore.connect(id)` + 读该 session 的 messages。
- 切页面：`onBeforeUnmount` 不再 abort；store 自行维护。

### 6.3 未读徽章
- `sessions` 列表项展示红点基于 `session.hasUnread`。
- 点击 session → 调 `POST /api/sessions/:id/read` 清除。
- 轮询或 SSE（GET /api/sessions/stream）刷新未读状态（先用简单轮询 5s）。

### 6.4 富内容渲染
在 `MessageBubble.vue` 内基于事件类型 map 到组件：
```vue
<template v-for="ev in message.events">
  <ThinkingBlock v-if="ev.type==='thinking'" :text="ev.text" />
  <TextBlock v-else-if="ev.type==='text'" :text="ev.text" />
  <ToolCallBlock v-else-if="ev.type==='tool_call'" ... />
  <ModuleCard v-else-if="ev.type==='card' && ev.kind==='module'" ... />
  <MarkdownBlock v-else-if="ev.type==='md'" ... />
  <ImageBlock v-else-if="ev.type==='image'" ... />
  <ErrorBlock v-else-if="ev.type==='error'" ... />
</template>
```

---

## 七、协议定义（事件 envelope）

所有事件（持久化 + 流推送）统一结构：
```json
{"seq": 42, "type": "text", "payload": {"text": "..."}}
{"seq": 43, "type": "thinking", "payload": {"text": "..."}}
{"seq": 44, "type": "tool_call", "payload": {"callId": "...", "name": "...", "args": {...}}}
{"seq": 45, "type": "tool_result", "payload": {"callId": "...", "result": "..."}}
{"seq": 46, "type": "card", "payload": {"kind": "module", "data": {...}}}
{"seq": 47, "type": "md", "payload": {"content": "..."}}
{"seq": 48, "type": "image", "payload": {"url": "...", "alt": "..."}}
{"seq": 49, "type": "error", "payload": {"message": "..."}}
{"seq": 50, "type": "done", "payload": {}}
{"seq": 51, "type": "paused", "payload": {}}
```

前端只需维护一个线性事件列表即可无损还原历史 + 渲染新类型。

---

## 八、Task 拆分

### Task 1 — DB Schema & 迁移
- 新增 `message_events` 表
- `sessions`/`messages` 加字段
- 迁移脚本幂等
- **验收**：`pnpm dev` 启动无报错；sqlite 查 `PRAGMA table_info` 字段齐全。

### Task 2 — ChatRunner 核心实现
- `src/server/agent/chat-runner.ts`：状态机 + EventEmitter + DB 批写
- text-delta 合并（200 字符/50ms）
- pause / subscribe / finalize 全路径
- 单例注册表 + 空闲清理
- **验收**：单测或脚本直接调用 runner，观察事件写入 DB 且 seq 连续。

### Task 3 — API 重构
- `POST /api/chat` 改为启动 runner 后立即返回
- `GET /api/chat/stream` 新增
- `POST /api/chat/pause`、`POST /api/chat/continue`
- `POST /api/sessions/:id/read`
- **验收**：curl 能启动、断开订阅、重连续播；断开后 runner 不中止。

### Task 4 — 前端 Store 迁移
- `chat.ts` 增加 stream map 与 connect/disconnect/pause/continue
- 事件流解码 → 更新对应 session 的 messages/events
- **验收**：切 session、切页面再回来，流不中断，状态一致。

### Task 5 — ChatPage/ChatPanel/MessageBubble 重构
- 移除本地状态，全部读 store
- 事件驱动渲染
- 暂停按钮 / 继续按钮
- **验收**：Playwright e2e 覆盖：发送-暂停-继续-切换-切回-未读-删除。

### Task 6 — 未读徽章 + 轮询
- 会话列表 hasUnread 展示
- 打开 session 自动清除
- 5s 轮询 /api/sessions 刷新
- **验收**：开两个 tab；A 发起对话后切到 B；A 红点出现；回 A 红点消失。

### Task 7 — 清理旧字段（可选，延后）
- 确认事件日志稳定后，移除 `messages.thinking/toolCalls/modules/messageError` 旧写路径
- 保留读兼容 1~2 个版本

### Task 8 — Playwright 集成测试
覆盖 5 项硬需求：
1. 输出中途调暂停 — 已输出内容仍在 DB + UI；
2. 暂停后发"继续" — 衔接上文；
3. 发送后关闭 tab 再打开 — 看到完整回复 + 未读；
4. 流中切换 session 再切回 — 内容连续；
5. 删除会话 → 新建 → 选同模块 — 上下文纯净但模块文档载入。

---

## 九、风险与兜底

| 风险 | 兜底 |
|------|------|
| 多进程部署下 Map 注册表失效 | 计划仅单进程；若扩展，用 Redis Streams 替换 EventEmitter |
| 事件日志膨胀 | text 合并 + 定期压缩归档（超 7 天的事件合并为 1 条 snapshot） |
| Runner 内存泄漏 | 空闲超时清理 + done/error 即刻移除 |
| 重复 seq（并发 insert） | `unique(session_id, seq)` 约束 + runner 内原子递增 |
| Abort 时事件未 flush | pause 流程先 flush 再 emit paused |
| 前端订阅丢包 | `afterSeq` 机制幂等续播 |
| 过期 paused runner 持久占内存 | 24h 超时后释放引用；下次请求时状态从 DB 恢复"伪 runner"仅用于展示 |

---

## 十、验收定义（done when）

- [ ] 所有对话内容可从 `message_events` 完整还原
- [ ] 暂停、继续、断开重连、切换页面、未读红点 5 项场景 Playwright 全绿
- [ ] 客户端关闭后服务端 runner 继续跑到完成
- [ ] 切模块强制新会话；新会话自动加载模块文档
- [ ] 新富内容类型（card/md/image）无需改 DB 即可新增

---

## 十一、实施顺序建议

推荐按 Task 1 → 2 → 3 → 4 → 5 → 6 → 8 顺序执行，每个 Task 完成后单独 commit 并更新 CURSOR.md。Task 7 延后到稳定后单独开一个小 Step。

总预估工作量：中等偏大（主要在 ChatRunner 与前端 store 重构两处，各约占 30%）。
