# MockForge 全面测试计划

## 测试原则

- **真实页面测试**：所有测试通过 Playwright 打开真实浏览器执行
- **UI 一致性**：验证元素渲染、样式、布局、徽章颜色
- **功能可用性**：验证表单提交、CRUD 操作、数据持久化
- **用户交互**：验证点击、输入、hover、focus、键盘操作、禁用态
- **状态覆盖**：验证 loading 态、空态、错误态、成功态
- **视觉回归**：关键页面截图对比

---

## 测试文件结构

```
tests/
├── helpers.ts                ← 公共工具（login、API helper、清理）
├── api.spec.ts               ← API 接口测试
├── page-login.spec.ts        ← 登录页真实页面测试
├── page-chat.spec.ts         ← 聊天页真实页面测试
├── page-settings.spec.ts     ← 设置页真实页面测试
├── page-modules.spec.ts      ← 模块页真实页面测试
├── page-admin.spec.ts        ← 管理页真实页面测试
├── navigation.spec.ts        ← 导航 & 路由守卫测试
├── responsive.spec.ts        ← 响应式 & 布局测试
└── e2e-flows.spec.ts         ← 端到端业务流程测试
```

---

## 一、登录页测试 (page-login.spec.ts) — 18 个用例

### 1.1 UI 渲染验证

| # | 用例名 | 具体验证 |
|---|--------|----------|
| L01 | 页面标题和品牌信息 | h1 显示 "MockForge"；副标题 "AI-driven Mock API Platform" 可见 |
| L02 | 登录表单完整渲染 | Login/Register 两个标签按钮可见；username 输入框 placeholder="Enter username"；password 输入框 placeholder="Enter password"；提交按钮 type="submit" 文字为 "Login" |
| L03 | 默认选中 Login 标签 | Login 标签有 border-primary class；Register 标签无 border-primary |
| L04 | 表单居中布局 | 表单容器 max-width=sm（384px 范围内）；页面垂直居中（flex items-center justify-center） |

### 1.2 标签切换交互

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| L05 | 切换到注册标签 | 点击 "Register" → 出现第二个 password 输入框（placeholder="Confirm password"）；提交按钮文字变为 "Register" |
| L06 | 切换回登录标签 | 先点 Register 再点 Login → 确认密码框消失；提交按钮文字恢复 "Login" |
| L07 | 标签高亮跟随切换 | 点击 Register → Register 标签有 border-primary，Login 标签无 |

### 1.3 登录功能

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| L08 | 正确凭据登录成功 | 输入 admin / admin123 → 点击提交 → URL 变为 /chat；localStorage 有 mockforge_token |
| L09 | 登录过程 loading 状态 | 点击提交后 → 按钮文字变为 "Processing..."；按钮 disabled |
| L10 | 错误密码停留登录页 | 输入 admin / wrongpwd → 点击提交 → 停留 /login；出现错误 toast |
| L11 | 不存在用户登录失败 | 输入 nobody / any → 点击提交 → 停留 /login |

### 1.4 表单验证

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| L12 | 空字段提交拦截 | 不填任何内容直接提交 → toast 显示 "Please fill in all fields" |
| L13 | 只填用户名提交 | 只填 username → toast "Please fill in all fields" |
| L14 | 注册-用户名过短 | 切换注册，输入 2 字符用户名 + 有效密码 → toast "Username must be 3-20 characters" |
| L15 | 注册-密码过短 | 有效用户名 + 5 字符密码 → toast "Password must be at least 6 characters" |
| L16 | 注册-密码不匹配 | 密码 "123456"，确认 "654321" → toast "Passwords do not match" |

### 1.5 视觉回归

| # | 用例名 | 具体验证 |
|---|--------|----------|
| L17 | 登录页截图对比 | 截图 login-default.png 与基线对比 |
| L18 | 注册标签截图对比 | 切换到注册 → 截图 login-register.png 与基线对比 |

---

## 二、聊天页测试 (page-chat.spec.ts) — 22 个用例

### 2.1 UI 渲染验证

| # | 用例名 | 具体验证 |
|---|--------|----------|
| C01 | 会话侧边栏渲染 | 左侧 w-56 侧边栏可见（桌面端）；"New Chat" 按钮含 Plus 图标 |
| C02 | 聊天输入区渲染 | textarea 可见，placeholder="Send a message... (Shift+Enter for new line)"；文件上传按钮 title="Attach files" 可见；发送按钮 title="Send message" 可见 |
| C03 | 空状态引导文字 | 无消息时显示 "MockForge" 大标题 + "Describe the API you want to generate" |
| C04 | 消息气泡样式 | 用户消息：bg-primary + 右对齐（flex-row-reverse）+ User 图标；助手消息：bg-muted + 左对齐 + Bot 图标 |

### 2.2 会话管理交互

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| C05 | 创建新会话 | 点击 "New Chat" → URL 变为 /chat/:sessionId；侧边栏出现新会话项 |
| C06 | 新会话默认标题 | 创建会话后侧边栏显示 "新对话" 或默认标题 |
| C07 | 切换会话 | 创建会话 A → 创建会话 B → 点击 A → URL 更新为 A 的 sessionId |
| C08 | 删除会话 | hover 会话项 → 出现红色删除按钮（Trash2 图标） → 点击 → 会话从列表消失 |
| C09 | 删除最后一个会话 | 只有一个会话时删除 → URL 回到 /chat；消息列表清空 |
| C10 | 会话高亮状态 | 活跃会话有 bg-accent 样式；非活跃会话 text-muted-foreground |

### 2.3 消息发送交互

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| C11 | 输入文字发送 | textarea 输入文字 → 按 Enter → 用户消息出现在列表；textarea 清空 |
| C12 | Shift+Enter 换行 | 按 Shift+Enter → textarea 内换行；不触发发送 |
| C13 | 空输入发送按钮禁用 | textarea 为空时 → 发送按钮 disabled |
| C14 | 有输入时发送按钮启用 | 输入文字 → 发送按钮 enabled |
| C15 | textarea 自动扩高 | 输入多行文字 → textarea 高度增加（最大 200px） |

### 2.4 加载 & 流式状态

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| C16 | 发送后 loading 态 | 发送消息 → textarea disabled；placeholder 变为 "AI is generating..."；出现 Stop 按钮（Square 图标，title="Stop generating"） |
| C17 | 停止生成 | loading 中点击 Stop → 停止流式接收；恢复输入状态 |
| C18 | 消息自动滚动 | 发送多条消息 → 列表自动滚到底部 |

### 2.5 文件上传交互

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| C19 | 文件上传按钮打开选择器 | 点击 paperclip 按钮 → 触发文件选择（hidden input） |
| C20 | 附件预览显示 | 选择文件后 → 输入区上方出现附件预览（文件名 + X 删除按钮） |
| C21 | 移除附件 | 点击附件上的 X 按钮 → 附件从预览移除 |
| C22 | 有附件时发送按钮启用 | 只有附件无文字 → 发送按钮仍然 enabled |

---

## 三、设置页测试 (page-settings.spec.ts) — 24 个用例

### 3.1 UI 渲染验证

| # | 用例名 | 具体验证 |
|---|--------|----------|
| S01 | 页面标题和标签 | h1 显示 "Settings"；两个标签按钮 "AI Providers" 和 "Project Presets" |
| S02 | 默认显示 Providers 标签 | "AI Providers" 标签有 border-primary class；描述文字 "Configure AI providers for generating Mock APIs" 可见 |
| S03 | Provider 列表渲染 | 列表中每项显示：名称、type|model|scope 信息、编辑（Pencil）和删除（Trash2）按钮 |

### 3.2 Provider CRUD 交互

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| S04 | 点击 Add Provider 打开模态框 | 点击 "+ Add Provider" → 弹出模态框；标题 "Add Provider"；显示 Name/Type/Base URL/API Key/Default Model/Scope 表单字段 |
| S05 | Provider 表单字段 placeholder | Name: "My OpenAI Provider"；Base URL: "https://api.openai.com/v1"；Default Model: "gpt-4o-mini" |
| S06 | Type 下拉选项 | 下拉包含：OpenAI, Anthropic, Google, OpenAI Compatible, Custom |
| S07 | 创建 Provider 成功 | 填写 name + defaultModel + 选择 type → 点击 Save → 模态框关闭；列表新增一项；toast "Provider created" |
| S08 | 创建 Provider 验证 | name 或 model 为空 → 点击 Save → toast "Name and model are required"；模态框不关闭 |
| S09 | 取消关闭模态框 | 点击 Cancel → 模态框关闭；列表不变 |
| S10 | 点击背景关闭模态框 | 点击模态框外的遮罩 → 模态框关闭 |
| S11 | 编辑 Provider 预填数据 | 点击 Pencil 按钮 → 模态框标题 "Edit Provider"；表单预填已有数据 |
| S12 | 编辑 Provider API Key 提示 | 编辑模式 → API Key placeholder="Leave blank to keep current" |
| S13 | 更新 Provider 成功 | 修改 name → 点击 Save → toast "Provider updated"；列表中名称更新 |
| S14 | 删除 Provider | 点击 Trash2 → 浏览器确认弹窗 → 确认 → toast "Provider deleted"；项目从列表移除 |
| S15 | 取消删除 Provider | 点击 Trash2 → 浏览器确认弹窗 → 取消 → 列表不变 |

### 3.3 Preset CRUD 交互

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| S16 | 切换到 Presets 标签 | 点击 "Project Presets" → 描述文字 "Define project presets for consistent API generation"；"+ Add Preset" 按钮可见 |
| S17 | 点击 Add Preset 打开模态框 | 点击 → 标题 "Add Preset"；显示 Name/Description/Configuration/Scope 字段 |
| S18 | Preset 表单字段 placeholder | Name: "Company API Standard"；Description: "Describe this preset"；Content: `{"responseFormat":{}, "fieldNaming":"camelCase"}` |
| S19 | 创建 Preset 成功 | 填写 name + content → Save → toast "Preset created"；列表新增一项 |
| S20 | 创建 Preset 验证 | name 为空 → toast "Name is required" |
| S21 | 编辑 Preset | 点击 Pencil → 标题 "Edit Preset"；预填数据；修改后 Save → toast "Preset updated" |
| S22 | 删除 Preset | 点击 Trash2 → 确认 → toast "Preset deleted" |

### 3.4 空状态 & 视觉

| # | 用例名 | 具体验证 |
|---|--------|----------|
| S23 | Provider 空列表 | 删除所有 Provider 后 → 显示 "No providers configured" |
| S24 | Preset 空列表 | 无 Preset 时 → 显示 "No presets configured" |

---

## 四、模块页测试 (page-modules.spec.ts) — 12 个用例

### 4.1 模块列表页

| # | 用例名 | 具体验证 |
|---|--------|----------|
| M01 | 页面标题 | h1 显示 "Modules" |
| M02 | 模块卡片渲染 | 每张卡片：名称（h3）、状态徽章（active 绿色/inactive）、描述文字、basePath、端点数 |
| M03 | 卡片 hover 效果 | hover 模块卡片 → border 和 shadow 变化（transition） |
| M04 | 点击卡片跳转详情 | 点击卡片 → URL 变为 /modules/:name |
| M05 | 空状态显示 | 无模块时 → Boxes 图标 + "No modules yet" + "Go to Chat to generate your first Mock API module" |
| M06 | loading 状态 | 加载中 → 显示 "Loading..." |

### 4.2 模块详情页

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| M07 | 详情页头部信息 | h1 显示模块名；描述 + basePath 显示 |
| M08 | Endpoints 标签默认选中 | 标签 "Endpoints" 有 border-primary；端点列表可见 |
| M09 | 端点 Method 徽章颜色 | GET=绿色(bg-green-100)、POST=蓝色(bg-blue-100)、PUT=黄色(bg-yellow-100)、DELETE=红色(bg-red-100) |
| M10 | GET 端点测试按钮 | GET 端点行有 "Test" 按钮；非 GET 端点无 Test 按钮 |
| M11 | 执行端点测试 | 点击 Test → 显示测试结果区：method + url + 状态码徽章 + JSON 响应 |
| M12 | Documentation 标签 | 点击 Documentation → 加载文档内容或显示 "No documentation available" |

---

## 五、管理页测试 (page-admin.spec.ts) — 12 个用例

### 5.1 UI 渲染验证

| # | 用例名 | 具体验证 |
|---|--------|----------|
| A01 | 页面标题 | h1 "Admin Panel" + Shield 图标可见；h2 "User Management" 可见 |
| A02 | 用户表格结构 | 表头含 ID / Username / Role / Status / Actions 五列 |
| A03 | 角色徽章颜色 | admin 用户 → 紫色徽章(bg-purple-100 text-purple-700)；普通用户 → 灰色徽章(bg-gray-100 text-gray-700) |
| A04 | 状态徽章颜色 | Active → 绿色(bg-green-100 text-green-700)；Disabled → 红色(bg-red-100 text-red-700) |
| A05 | 操作按钮文字 | admin 用户显示 "Demote"；普通用户显示 "Promote"；活跃用户显示 "Disable"；禁用用户显示 "Enable" |

### 5.2 用户管理交互

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| A06 | 提升用户为管理员 | 点击普通用户的 "Promote" → toast "Role changed to admin"；角色徽章变紫色；按钮变 "Demote" |
| A07 | 降级管理员 | 点击管理员的 "Demote" → toast "Role changed to user"；角色徽章变灰色 |
| A08 | 禁用用户 | 点击 "Disable" → toast "User disabled"；状态变红色；按钮变 "Enable" |
| A09 | 启用用户 | 点击 "Enable" → toast "User enabled"；状态变绿色 |

### 5.3 权限 & 视觉

| # | 用例名 | 具体验证 |
|---|--------|----------|
| A10 | 非管理员无法访问 | 普通用户访问 /admin → 重定向到 /chat |
| A11 | 管理页截图对比 | 截图 admin-default.png 与基线对比 |
| A12 | 表格样式一致 | 表头 bg-muted；行间 border-t border-border |

---

## 六、导航 & 路由守卫测试 (navigation.spec.ts) — 12 个用例

### 6.1 路由守卫

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| R01 | 未登录→/chat 重定向 | 直接访问 /chat → 重定向到 /login |
| R02 | 未登录→/settings 重定向 | 直接访问 /settings → 重定向到 /login |
| R03 | 未登录→/modules 重定向 | 直接访问 /modules → 重定向到 /login |
| R04 | 未登录→/admin 重定向 | 直接访问 /admin → 重定向到 /login |
| R05 | 已登录→/login 重定向 | 已登录访问 /login → 重定向到 /chat |
| R06 | 根路径重定向 | 已登录访问 / → 重定向到 /chat |

### 6.2 侧边栏导航

| # | 用例名 | 具体操作 → 验证 |
|---|--------|-----------------|
| R07 | 导航项完整显示 | 登录后 → 显示 对话/模块/设置/管理 四个链接 |
| R08 | 点击 "对话" 导航 | 从其他页面点击 → URL=/chat |
| R09 | 点击 "模块" 导航 | 点击 → URL=/modules |
| R10 | 点击 "设置" 导航 | 点击 → URL=/settings |
| R11 | 点击 "管理" 导航 | 点击 → URL=/admin；页面显示 "Admin Panel" |
| R12 | 退出登录 | 点击退出按钮(title="Logout") → URL=/login；localStorage 无 token |

---

## 七、响应式测试 (responsive.spec.ts) — 10 个用例

### 7.1 移动端 (375x667)

| # | 用例名 | 具体验证 |
|---|--------|----------|
| V01 | 登录页居中无溢出 | 表单居中；body.scrollWidth <= innerWidth |
| V02 | 登录页截图 | 截图 login-mobile.png |
| V03 | 布局侧边栏隐藏 | 桌面侧边栏(hidden lg:flex) 不可见 |
| V04 | 头部汉堡菜单可见 | Menu 按钮可见可点击 |
| V05 | 点击汉堡打开移动侧边栏 | 点击 → 出现移动端侧边栏 overlay + 侧边栏 |
| V06 | 点击遮罩关闭移动侧边栏 | 点击黑色遮罩 → 侧边栏关闭 |
| V07 | 聊天页会话侧边栏隐藏 | /chat 页面 session 侧边栏 (hidden md:flex) 在移动端不可见 |

### 7.2 桌面端 (1280x720)

| # | 用例名 | 具体验证 |
|---|--------|----------|
| V08 | 无水平溢出 | body.scrollWidth <= innerWidth |
| V09 | 侧边栏正常显示 | 桌面侧边栏可见；宽度 w-64 |
| V10 | 聊天会话侧边栏显示 | session 侧边栏 w-56 可见 |

---

## 八、API 接口测试 (api.spec.ts) — 40 个用例

### 8.1 认证 API

| # | 方法 | 路径 | 用例 | 预期 |
|---|------|------|------|------|
| I01 | GET | /api/health | 健康检查 | 200 |
| I02 | POST | /api/auth/login | 正确凭据 | 200 + token |
| I03 | POST | /api/auth/login | 空 body | 400 |
| I04 | POST | /api/auth/login | 密码错误 | 401 |
| I05 | POST | /api/auth/login | 用户不存在 | 401 |
| I06 | POST | /api/auth/register | 有效数据 | 201 |
| I07 | POST | /api/auth/register | 用户名过短 | 400 |
| I08 | POST | /api/auth/register | 密码过短 | 400 |
| I09 | POST | /api/auth/register | 重复用户名 | 409 |

### 8.2 会话 API

| # | 方法 | 路径 | 用例 | 预期 |
|---|------|------|------|------|
| I10 | GET | /api/sessions | 列表 | 200 + 数组 |
| I11 | GET | /api/sessions | 未认证 | 401 |
| I12 | POST | /api/sessions | 创建 | 201 |
| I13 | GET | /api/sessions/:id | 获取详情 | 200 + messages |
| I14 | PUT | /api/sessions/:id | 更新标题 | 200 |
| I15 | DELETE | /api/sessions/:id | 删除 | 200 |
| I16 | DELETE | /api/sessions/999 | 不存在 | 404 |

### 8.3 Provider API

| # | 方法 | 路径 | 用例 | 预期 |
|---|------|------|------|------|
| I17 | GET | /api/providers | 列表（key 已脱敏） | 200 + apiKeyEncrypted="***" |
| I18 | POST | /api/providers | 创建 | 201 |
| I19 | POST | /api/providers | 缺字段 | 400 |
| I20 | PUT | /api/providers/:id | 更新 | 200 |
| I21 | PUT | /api/providers/:id | 非 owner | 403 |
| I22 | DELETE | /api/providers/:id | 删除 | 200 |

### 8.4 Preset API

| # | 方法 | 路径 | 用例 | 预期 |
|---|------|------|------|------|
| I23 | GET | /api/presets | 列表 | 200 |
| I24 | POST | /api/presets | 创建 | 201 |
| I25 | POST | /api/presets | 缺 name | 400 |
| I26 | PUT | /api/presets/:id | 更新 | 200 |
| I27 | DELETE | /api/presets/:id | 删除 | 200 |

### 8.5 模块 API

| # | 方法 | 路径 | 用例 | 预期 |
|---|------|------|------|------|
| I28 | GET | /api/modules | 列表 | 200 |
| I29 | GET | /api/modules/:name | 详情 | 200 |
| I30 | GET | /api/modules/:name | 不存在 | 404 |
| I31 | GET | /api/modules/:name/context | 上下文 | 200 |
| I32 | GET | /api/modules/:name/doc | 文档 | 200 |

### 8.6 上传 & 用户管理 API

| # | 方法 | 路径 | 用例 | 预期 |
|---|------|------|------|------|
| I33 | POST | /api/upload | 上传文件 | 200 |
| I34 | POST | /api/upload | 无文件 | 400 |
| I35 | POST | /api/upload | 未认证 | 401 |
| I36 | GET | /api/users | Admin 列表 | 200 |
| I37 | GET | /api/users | 非 Admin | 403 |
| I38 | PUT | /api/users/:id | 修改角色 | 200 |
| I39 | PUT | /api/users/:id | 修改状态 | 200 |
| I40 | PUT | /api/users/:id | 非 Admin | 403 |

---

## 九、端到端业务流程 (e2e-flows.spec.ts) — 8 个用例

| # | 流程名 | 完整操作链 | 验证点 |
|---|--------|-----------|--------|
| E01 | 登录→聊天→退出 | 打开登录页 → 输入凭据 → 登录 → 创建会话 → 发送消息 → 看到用户消息 → 点击退出 → 回到登录页 | 全链路流畅、token 正确设置和清除 |
| E02 | Provider 全生命周期 | 登录 → 进入设置 → 创建 Provider → 列表中出现 → 编辑修改名称 → 名称更新 → 删除 → 列表移除 | CRUD 数据持久化 |
| E03 | Preset 全生命周期 | 登录 → 设置 → Presets 标签 → 创建 → 编辑 → 删除 | CRUD 数据持久化 |
| E04 | 会话全生命周期 | 登录 → 新建会话 → 发消息 → 改标题 → 刷新页面 → 消息仍在 → 删除会话 | 数据持久化 |
| E05 | 模块浏览完整流程 | 登录 → 模块列表 → 点击进详情 → 查看端点 → 测试 GET → 查看文档 | 全流程通畅 |
| E06 | 管理员操作流程 | 登录 admin → 管理页 → 查看用户表 → 提升/降级角色 → 禁用/启用 | 权限和状态变更正确 |
| E07 | 多会话切换 | 创建会话 A → 发消息 "hello A" → 创建会话 B → 发消息 "hello B" → 切回 A → "hello A" 仍在 | 会话隔离 |
| E08 | 跨页面导航一致性 | 登录 → 聊天 → 设置 → 模块 → 管理 → 聊天 | 每次导航侧边栏高亮正确、页面内容正确 |

---

## 十、总计

| 分类 | 文件 | 用例数 |
|------|------|--------|
| 登录页 | page-login.spec.ts | 18 |
| 聊天页 | page-chat.spec.ts | 22 |
| 设置页 | page-settings.spec.ts | 24 |
| 模块页 | page-modules.spec.ts | 12 |
| 管理页 | page-admin.spec.ts | 12 |
| 导航 & 路由 | navigation.spec.ts | 12 |
| 响应式 | responsive.spec.ts | 10 |
| API 接口 | api.spec.ts | 40 |
| 端到端 | e2e-flows.spec.ts | 8 |
| **总计** | **9 个文件** | **158** |

---

## 十一、执行优先级

| 优先级 | 范围 | 说明 |
|--------|------|------|
| P0 | 登录页 + 路由守卫 + API 认证 | 安全基线，必须 100% 通过 |
| P1 | 聊天页 + 设置页 + API CRUD | 核心功能 |
| P2 | 模块页 + 管理页 + 端到端 | 完整业务 |
| P3 | 响应式 + 视觉回归 | 体验保障 |
