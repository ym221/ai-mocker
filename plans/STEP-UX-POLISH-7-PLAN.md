# STEP-UX-POLISH-7 计划

## 用户反馈（4 项）

| # | 问题 | 性质 | 工时 |
|---|------|------|------|
| 1 | `<thought>` 标签泄漏到正文 + 切换对话时打字机重新动画 | Bug | 30min |
| 2 | 缺少 Provider/Model 切换功能：设置页默认、Header 快速切换、持久化 | Feature | 2h |
| 3 | 界面英文 → 中文，MockForge → AI Mock | UX | 40min |
| 4 | AI 安全：随意输入触发生成、需防止聊天跨界操作 | Security | 30min |

---

## Task 1 — Thinking 标签泄漏 + 打字机 replay

### 1a. `<thought>` 泄漏根因

截图显示 `<thought>` 原文出现在正文中。ThinkingParser 已支持 `<thought>` 标签，但**存量事件**（旧数据库中的 text 事件）已经把 `<thought>` 内容作为 text 写入了 event log。重连 replay 时这些 text 事件原样回放，前端渲染为正文。

**方案**：客户端渲染层加一层兜底 — 对 assistant 消息的 `content` 做正则剥离：
```ts
content.replace(/<(thought|think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim()
```

### 1b. 切换对话打字机重新动画

切回已完成的对话时，`connect()` replay 历史事件 → content 从空逐步追加 → typewriter 把追加视为"新增字符"逐个显示。

**方案**：typewriter 在初始化时检查 `streamDone` 是否已经为 true → 如果是则跳过动画直接显示全文。MessageBubble 已有 `isStreamingAssistant = !isUser && !streamDone`，typewriter 的 `enabled()` 依赖此值。问题出在 replay 期间 `streamDone` 从 false 变 true 的时间窗内。

修复：在 typewriter 的 watch(source) 中，如果单次 diff > 200 字符（批量 replay 特征），直接 flush 不动画。

---

## Task 2 — Provider/Model 切换

### 当前状态
- sessions 表有 `provider_id` 和 `model` 字段
- 创建会话时可指定 `providerId`
- 但 UI 上没有入口选择/切换

### 方案

**2a. 用户默认 Provider 持久化**

- 新增 `users.default_provider_id` 字段（schema + migration）
- Settings 页 Provider 列表每行增加 ★"设为默认" 按钮
- 新建会话时：`providerId = user.defaultProviderId || providers[0].id`

**2b. Header 快速切换**

- `AppHeader` 右侧增加下拉选择器（Provider + Model）
- 数据源：GET /api/providers（已有 API）
- 选中后更新 `user.defaultProviderId`（PUT /api/auth/profile）
- 正在进行中的对话不受影响（session 已绑定 providerId），新对话用新选择

**2c. 会话创建时自动绑定**

- `chatStore.createSession()` 传入当前默认 `providerId`
- 对话详情页显示所用 Provider/Model（只读标签）

**2d. 删除 Provider 后降级**

- Settings 页删除 Provider 时：
  - 若被设为默认 → 清空 defaultProviderId → 下次新建会话用第一个可用 Provider
  - 对话页加载 session 时若 providerId 对应的 Provider 不存在 → 显示警告 + 允许选择新 Provider

---

## Task 3 — 中文化

### 替换范围

| 位置 | 原文 | 改为 |
|------|------|------|
| AppSidebar | MockForge | AI Mock |
| AppHeader title | MockForge | AI Mock |
| HTML `<title>` | MockForge | AI Mock |
| ChatPage empty state | MockForge / "Describe the API..." | AI Mock / "描述你想生成的 API" |
| SettingsPage | Settings / "AI Providers" / "Project Presets" / "Configure AI providers..." | 设置 / AI 服务商 / 项目预设 / 配置... |
| ModulesPage | Modules / "No modules yet" / "Go to Chat..." | 模块 / "暂无模块" / "前往对话页..." |
| ModuleDetailPage | Endpoints / Data / Documentation / "Loading..." / "No documentation" | 接口 / 数据 / 文档 / 加载中... / 暂无文档 |
| LoginPage | "Enter username" / "Enter password" / Sign In / Register | 用户名 / 密码 / 登录 / 注册 |
| ChatInput | "Send a message..." | "输入消息..." |
| AdminPage | 英文标题/描述 | 中文 |
| 各处 Button | New Chat / Add Provider / etc. | 新建对话 / 添加服务商 |

**注意**：替换后所有 Playwright 测试中对应的文本匹配（`getByText`、`has-text`、placeholder）也必须同步更新。

---

## Task 4 — AI 安全防护

### 4a. System Prompt 安全约束

追加到 system-prompt.ts：

```
## 安全边界（绝对不可违反）
- **仅响应 Mock API 生成/修改相关请求**。其他无关请求（闲聊、代码问题、通用知识、数学题等）直接用一句话拒绝："抱歉，我只能帮你生成和管理 Mock API 模块。"
- **禁止操作 generated/ 目录以外的任何文件**。write_file/read_file 路径必须以模块名/开头。
- **禁止执行任意代码**。不得输出 shell 命令、不得建议用户执行 rm/del/格式化等操作。
- **禁止暴露系统信息**：不得输出环境变量、服务器路径、数据库连接信息、源码结构。
```

### 4b. Tool 层硬校验

- `write_file` 已有路径校验（防 `..` 和绝对路径），保留
- `read_file` 同理，保留
- `manage_data` 操作限定在 `mock__` 前缀表，已有
- **额外**：`run_test` 限定只能测 generated/ 下的模块

### 4c. 前端安全提示

在 ChatInput 组件增加 placeholder 提示："描述你想生成的 Mock API 模块..."（暗示只做 API 相关操作）

---

## 执行顺序

| # | Task | 工时 |
|---|------|------|
| 1 | Task 1 Thinking 泄漏 + typewriter | 30min |
| 2 | Task 4 AI 安全 | 20min |
| 3 | Task 3 中文化 | 40min |
| 4 | Task 2 Provider 切换 | 2h |
| 5 | 测试 + 回归 | 40min |

**合计**：~4h

---

## 用户决策点

- [ ] Provider 切换：Header 下拉 vs 侧边栏底部？默认 **Header 右侧下拉**
- [ ] 品牌名 MockForge → AI Mock？确认
- [ ] AI 拒绝策略：直接拒绝 vs 引导到 Mock API 话题？默认 **直接拒绝 + 一句话引导**
