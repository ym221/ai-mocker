# Thinking 适配层实施计划

## 目标
让聊天界面支持展示 AI 模型的思考过程（Thinking/Reasoning），通过统一适配层兼容市面上所有主流模型的思考格式。

---

## Task 1: ThinkingAdapter 适配层核心

**文件**: `src/server/agent/thinking-adapter.ts`（新建）

### 1.1 类型定义

```typescript
// 统一输出块类型
type ThinkingChunk =
  | { type: 'thinking'; content: string }
  | { type: 'text'; content: string }
  | { type: 'thinking_complete' }  // 思考结束信号

// 适配策略接口
interface ThinkingStrategy {
  transform(stream: AsyncIterable<any>): AsyncIterable<ThinkingChunk>;
}
```

### 1.2 TagBasedStrategy — 标签解析（核心）

覆盖模型：DeepSeek R1、Qwen QwQ/Qwen3、Grok 3、Kimi k1.5、GLM-4、豆包、所有开源微调模型

关键设计 — **流式状态机**：
- 状态: `outside` → `maybe_open` → `inside` → `maybe_close` → `outside`
- 处理标签跨 chunk 截断问题（如 `<thi` + `nk>` 分两个 chunk 到达）
- 支持的标签: `<think>`, `<thought>`, `<reasoning>`（可配置）

```
状态机流转:
  outside:
    遇到 '<' → 进入 maybe_open, 缓冲 '<'
    其他字符 → emit text chunk
  maybe_open:
    逐字符匹配 'think>' / 'thought>' / 'reasoning>'
    匹配成功 → 进入 inside
    匹配失败 → flush 缓冲为 text, 回到 outside
  inside:
    遇到 '<' → 进入 maybe_close, 缓冲 '<'
    其他字符 → emit thinking chunk
  maybe_close:
    逐字符匹配 '/think>' / '/thought>' / '/reasoning>'
    匹配成功 → emit thinking_complete, 回到 outside
    匹配失败 → flush 缓冲为 thinking, 回到 inside
```

### 1.3 PassthroughStrategy — 透传

覆盖模型：GPT-4o、GPT-4-turbo、Llama、Mistral、Yi 等不带思考的模型

直接将所有 text-delta 事件输出为 `{ type: 'text' }` chunk。

### 1.4 策略工厂

```typescript
function createThinkingStrategy(providerType: string, modelName: string): ThinkingStrategy
```

根据 provider type + model 名称关键词自动选择策略：
- 模型名包含 `deepseek-r1`, `qwq`, `qwen3`, `grok`, `kimi`, `glm` 等 → TagBasedStrategy
- 其他 → PassthroughStrategy

**可扩展**：未来如果用原生 Anthropic/Gemini SDK，加 NativeApiStrategy 即可。

### 验收标准
- [x] 对 `<think>思考内容</think>回答内容` 正确拆分为 thinking + text
- [x] 对跨 chunk 的标签 `<thi` + `nk>内容</think>` 正确解析
- [x] 对无思考内容的纯文本正确透传
- [x] 对嵌套/畸形标签不崩溃，降级为文本

---

## Task 2: 流协议升级 — 服务端

**文件**: `src/server/api/chat.ts`, `src/server/agent/agent-runner.ts`

### 2.1 agent-runner 改造

- `runAgent` 返回值不变（仍返回 `streamText` 的 result）
- 新增：返回 session 的 model 和 provider type 信息，供 chat.ts 选择策略

### 2.2 chat.ts 流输出改造

- Content-Type 改为 `text/event-stream`（或保持 `text/plain` 但输出 JSON Lines）
- 使用 `result.fullStream` 替代 `result.textStream`
- 通过 ThinkingAdapter 转换，每个 chunk 输出一行 JSON:
  ```
  {"type":"thinking","content":"让我想想..."}
  {"type":"text","content":"答案是"}
  {"type":"thinking_complete"}
  ```
- 错误处理保持兼容

### 验收标准
- [x] 使用 DeepSeek R1 等模型时，thinking 和 text 分开输出
- [x] 使用 GPT-4o 等模型时，只输出 text
- [x] 错误信息正常传递

---

## Task 3: 客户端解析 + 数据结构

**文件**: `src/client/pages/ChatPage.vue`

### 3.1 消息数据结构扩展

```typescript
interface ChatMessage {
  role: string;
  content: string;
  thinking?: string;        // 思考过程
  thinkingComplete?: boolean; // 思考是否结束
}
```

### 3.2 流读取器改造

- 按 `\n` 分割 JSON Lines
- 根据 `type` 字段分别追加到 `thinking` 或 `content`
- 收到 `thinking_complete` 时标记思考完成
- 处理 JSON 行跨 chunk 截断（缓冲未完成的行）

### 验收标准
- [x] 流式接收时 thinking 和 content 分别实时更新
- [x] 处理 JSON 行跨 chunk 边界的情况

---

## Task 4: MessageBubble 思考过程 UI

**文件**: `src/client/components/chat/MessageBubble.vue`

### 4.1 Props 扩展

```typescript
defineProps<{
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  thinkingComplete?: boolean;
}>();
```

### 4.2 思考过程展示

- 移除旧的 `<thought>` 正则过滤
- 新增可折叠的思考区域：
  - 思考中（streaming）：展开状态，显示 "思考中..." + 动画 + 实时内容
  - 思考完成：自动折叠，显示 "已深度思考（点击展开）"
  - 点击可展开/折叠
- 思考内容也走 Markdown 渲染
- 视觉：淡色背景、斜体、左侧竖线装饰（类似 Claude 官方 UI）

### 验收标准
- [x] 思考过程流式显示，有加载动画
- [x] 思考完成后自动折叠
- [x] 点击可展开/折叠
- [x] 无思考内容时不显示思考区域
- [x] 样式美观，与整体 UI 协调

---

## Task 5: 数据持久化

**文件**: `src/server/core/schema.ts`, `src/server/agent/agent-runner.ts`, `src/server/api/sessions.ts`

### 5.1 数据库 Schema

messages 表新增 `thinking` 字段：
```typescript
thinking: text('thinking'),  // nullable
```

### 5.2 agent-runner onFinish 保存

在 `onFinish` 回调中，提取 thinking 内容并保存到 messages 表。

### 5.3 历史消息加载

加载历史消息时，返回 thinking 字段，前端回显。

### 验收标准
- [x] 新消息的 thinking 正确保存到数据库
- [x] 刷新页面后思考过程可正确回显
- [x] 旧消息（无 thinking 字段）兼容正常

---

## 执行顺序

Task 1 → Task 2 → Task 3 → Task 4 → Task 5

每个 Task 完成后 commit + 更新 CURSOR.md。
