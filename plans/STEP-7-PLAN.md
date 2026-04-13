# Step 7: System Prompt + AgentRunner + 系统 API — 聚焦子计划

## 目标
实现系统 API（providers/presets/sessions/modules）、System Prompt 构建、AgentRunner SSE 流、chat 端点。

## Task 清单

### Task 1: api/providers.ts — Provider CRUD
- GET /api/providers — 列表（公开 + 自己的私有）
- POST /api/providers — 创建
- PUT /api/providers/:id — 更新
- DELETE /api/providers/:id — 删除
- 需要 authMiddleware

### Task 2: api/presets.ts — 预设 CRUD
- GET /api/presets — 列表
- POST /api/presets — 创建
- PUT /api/presets/:id — 更新
- DELETE /api/presets/:id — 删除

### Task 3: api/sessions.ts — 会话 CRUD
- GET /api/sessions — 列表
- POST /api/sessions — 创建（含 presetId, moduleName）
- GET /api/sessions/:id — 详情 + 消息加载
- DELETE /api/sessions/:id — 删除（级联删除消息）
- PUT /api/sessions/:id — 更新标题等

### Task 4: api/modules.ts — 模块管理 API
- GET /api/modules — 列表
- GET /api/modules/:name — 详情
- GET /api/modules/:name/context — 读取 _context.md
- GET /api/modules/:name/doc — 读取 api-doc.md

### Task 5: system-prompt.ts — 系统提示词
- buildSystemPrompt({ userId, moduleList, preset, moduleContext })
- 内联完整代码骨架 + BaseModel API + 响应格式 + 示例模块
- 预设注入（responseFormat, fieldNaming, pagination, customPrompt）

### Task 6: agent-runner.ts — streamText 封装
- 使用 Vercel AI SDK streamText
- 构建 model/tools/prompt
- maxSteps: 10
- onFinish: 持久化消息到 messages 表

### Task 7: api/chat.ts — POST /api/chat (SSE)
- 接收 sessionId + messages
- 加载 session 配置（provider, preset, module）
- 调用 agentRunner 返回 SSE 流
