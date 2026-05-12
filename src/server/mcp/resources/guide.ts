import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const GUIDE_MARKDOWN = `# MockForge MCP

让 Coding Agent 从自然语言或 OpenAPI 直接生成可访问的 Mock REST 服务。

## 访问 URL 公式(铁律)

\`\`\`
完整访问 URL = <MCP origin>/mock/<moduleName><endpoint.path>
\`\`\`

例:\`moduleName=order\` + \`endpoint.path=/list\` → \`<MCP origin>/mock/order/list\`

**默认零身份信息**:业务代码 / 代理 / curl 直接用 mockBaseUrl 拼,**不要带任何 token / userId / header**。MCP 给的 \`mockBaseUrl\` 已经是 \`<MCP origin>/mock/<moduleName>\`,你只需要拼 endpoint.path 即可。

\`mockBaseUrl\` 的 origin 算法:env \`MCP_PUBLIC_URL\` > 请求 \`X-Forwarded-*\` > \`http://localhost:<PORT>\` 兜底。返回的 \`mockBaseUrlSource\` 字段告诉你来源 — 若是 \`fallback-localhost\` 但 MCP 部署在远程,提示用户配 \`MCP_PUBLIC_URL\`。

## 接口 404 只有两种原因

1. **URL 拼错** → 对照公式核对(模块名、endpoint.path 是否带了多余前缀)
2. **AI 生成的代码有问题** → 框架已硬校验 _meta.json,这里 404 通常是 \`endpoints[].path\` 在 _meta 里登记的不是你想的那个;\`MODULE_NOT_FOUND\` 时响应里附 \`hint\` 列出所有可用模块名,\`ENDPOINT_NOT_MATCHED\` 时附 \`hint\` 列出该模块所有已注册 path

## 工具耗时（先看这里）

| 类型 | 耗时 | 工具 |
|------|------|------|
| 读 | <1s | \`list_modules\` \`inspect_module\` \`get_mock_access_log\` \`diff_with_openapi\` \`get_session_status\` |
| 数据 / 测试 / 删除 | <30s | \`manage_data\` \`run_test\` \`delete_module\` \`cancel_session\` \`generate_handoff_report\` |
| **AI 生成新模块** | **7-12 min** | \`create_module_from_spec\` |
| **AI 修改模块** | **2-10 min** | \`update_module\` — 小改 2-5min / 大改 5-10min（含内部测试 + 修复循环） |

> 增删改数据走 \`manage_data\` 直连 DB，30 秒内完成；只有 \`create_module_from_spec\` / \`update_module\` 走 LLM，是分钟级。

## ⚡ 长任务策略：异步并行 + 自动续接

调 \`create_module_from_spec\` / \`update_module\` 期间**不要空转**：

- **已知接口形状** → 直接写业务代码，不必等模块完全 ready
- **需要契约** → 生成中也能 \`inspect_module(moduleName, view:'openapi')\` 拿到当前草稿
- **续接**：默认 \`waitMaxSec=180\`（上限 300），超时返 \`{ sessionId, status:"still-running", stage, elapsedSec }\`
  - 重发**同样参数** → 自动 attach 到在跑的 session（不重复创建，\`attached:true\`）
  - 或 polling \`get_session_status(sessionId)\`（5ms 非阻塞快照）
  - 客户端 transport 断了不要紧，server-side 任务继续跑，重发即续接

## 13 个工具

**读**
- \`list_modules\` — 列出所有模块(name / status / health / endpoints / mockBaseUrl / createdBy / updatedBy / 时间);响应顶层含 \`currentUser: {id, username}\` 让你一眼知道"我是谁"
- \`list_models\` — 按 provider 分组列出可用 AI 模型;每个 model 带 \`isVerified\`(测试通过)+ \`note\`(用户写的成本/速度备注)+ \`isDefault\`。**写工具调用前先看这个挑合适的 model**
- \`inspect_module(moduleName, view?)\` — view: \`all|doc|openapi|health\`（默认 all）
- \`get_mock_access_log(moduleName)\` — 业务代码最近打到 Mock 的真实请求/响应
- \`diff_with_openapi(moduleName, actualRequest, actualResponse)\` — 实际 vs 契约结构化 diff

**写（轻量，秒级，不走 LLM）**
- \`manage_data\` — \`insert | update | delete | list | batch_delete | clear | bulk_generate\`
- \`run_test(moduleName)\` — 跑模块自带回归
- \`delete_module(moduleName)\` — 不可逆

**写（AI 生成，分钟级）**
- \`create_module_from_spec({ spec, moduleName, dry_run?, waitMaxSec?, onConflict?, provider?, model?, preset? })\`
- \`update_module({ moduleName, instruction, dry_run?, waitMaxSec?, onConflict?, provider?, model?, preset? })\`

**会话**
- \`get_session_status(sessionId)\` / \`cancel_session(sessionId)\`

**交付**
- \`generate_handoff_report(moduleName)\` — 给后端的交接 markdown

## 没有接口文档时：A 一把梭 / B 你先出 spec

> 心智锚点：MCP 后端默认走**用户在 Web UI 设的默认 provider + 默认 model**。实际 model 不固定(可能 GPT / Claude / DeepSeek 等任意)。\n> 先调 \`list_models\` 看用户配的清单(每个 model 带 \`isVerified\` 测试通过状态 + \`note\` 备注),根据 note 选合适的 model;在 \`create_module_from_spec\` / \`update_module\` 调用时传 \`provider\` / \`model\` 覆盖默认。

**模式 A — 丢需求文本给 MCP**：\`create_module_from_spec({ spec: "<自然语言需求>", moduleName })\`
适合：CRUD 套路 / 简单规则 / 你的模型档位 ≤ MCP 默认。

**模式 B — 你先出 spec**（推荐当你 ≥ Claude Sonnet 4 / GPT-4o 档）：
1. 你（user Agent）基于 PRD 自己生成 OpenAPI YAML 或 Markdown spec
2. \`create_module_from_spec({ spec: "<你的 spec>", moduleName })\` 让 MCP 只做实现
3. **生成期间你拿自己的 spec 直接写业务代码**——这才是真正的异步并行（不必等 MCP）
4. MCP 完成后业务代码切到 \`mockBaseUrl\` 联调

**临时换 MCP 后端模型**：两个生成工具都接受 \`provider\` / \`model\` / \`preset\`（user-owned 或 public scope 的 provider id/name），可临时覆盖默认。例：\`{ ..., provider: "anthropic", model: "claude-sonnet-4-6" }\`。

## 典型流程

1. \`list_modules\` 找可复用的
2. 没有 → \`create_module_from_spec\`（**同时并行写业务代码**，不要等）
3. 业务测试失败 → \`get_mock_access_log\` + \`diff_with_openapi\` 定位是契约还是业务侧问题
4. 改 Mock → \`update_module\` → \`run_test\` 验证
5. 造数（UI 展示 / 压测）→ \`manage_data({ action:'bulk_generate', count })\`
6. 交付 → \`generate_handoff_report\`

## 关键约定

- \`moduleName\` 大小写敏感,**全局唯一**(框架在 create_module_from_spec / write_files 写盘前硬校验冲突;冲突时报 \`MODULE_NAME_TAKEN\` 让你改名,建议加业务前缀如 \`acme_order\`)
- \`mockBaseUrl\` 是完整 URL,直接用,不要再拼 \`/mock\` 或 \`/<moduleName>\`
- \`endpoints[].path\` 是**模块内**子路径,以 \`/\` 开头,**不带** \`/mock/\` 也不带 \`/<moduleName>/\` 前缀(框架自动加)
- 所有实体自动含 \`id\` / \`created_at\` / \`updated_at\`
- 响应信封 \`{ success, message, data }\`;list 端点 data 是 \`{ list, total, page, pageSize }\`
- 优先读 \`structuredContent\`(机读),\`content[0].text\` 是给人看的
- \`dry_run:true\` → 只解析校验不落地,先确认再真跑

## 接入业务代码

直接用 \`mockBaseUrl\` 拼端点 path 即可,**完全无需带身份信息**:

- **换 baseURL**:\`axios.create({ baseURL: mockBaseUrl })\` → 拼 endpoint.path 调
- **vite proxy**:\`server.proxy['/api/order'] = { target: '<MCP origin>', rewrite: p => p.replace(/^\\/api\\/order/, '/mock/order') }\` — 不需要 headers,不需要 userId
- **nginx**:\`proxy_pass <MCP origin>/mock/<moduleName>/\` 同样无需 X-* header

跨域已开(CORS \`origin: true\`),浏览器直 fetch 也行。

## onConflict（同模块已有任务在跑时）

- \`'resume'\`（默认）— attach 到在跑的，拿它的结果（\`actualInstruction\` ≠ \`yourInstruction\` 时附 \`warning\`）
- \`'reject'\` — 返 \`MOCKFORGE_ALREADY_PROCESSING\`，你自己决定
- \`'replace'\` — cancel 旧的再启新的

## 用户身份(罕见场景才需要)

mock 访问 URL **零身份信息**就工作。你只在以下情况才需要"用户"概念:
- 看 \`list_modules\` / \`inspect_module\` 响应顶层的 \`currentUser: {id, username}\` 知道"我是谁"
- 每个 module 的 \`createdBy\` / \`updatedBy\` 告诉你"这模块是谁建的、谁动过"
- 框架启动检测到多个用户拥有同名模块时(历史遗留),mock-router 按 user_id 最小的那条响应,运维侧应 rename 解决,不需要你做任何事

## 错误码

错误响应 \`isError:true\`，\`structuredContent.{ code, hint, recovery_steps }\`：

\`MOCKFORGE_BUSY\`（per-user 3 / 全局 10 并发超限）/ \`MOCKFORGE_ALREADY_PROCESSING\`（仅 reject 模式）/ \`MOCKFORGE_MODULE_NOT_FOUND\` / \`MOCKFORGE_SESSION_NOT_FOUND\` / \`MOCKFORGE_NO_PROVIDER\` / \`MOCKFORGE_VALIDATION_FAILED\` / \`MOCKFORGE_WAIT_TIMEOUT\` / \`MOCKFORGE_INTERNAL_ERROR\`。

每条错误都附 \`recovery_steps\`（机读：下一步该调什么工具）。
`;

export function registerGuideResource(server: McpServer): void {
  server.registerResource(
    'mockforge-guide',
    'mockforge://guide',
    {
      title: 'MockForge Usage Guide',
      description:
        'Read first. Tool catalog with timing tiers, async strategy for 7-12min generation tasks, attach-on-resend resume model, error codes with recovery_steps.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: GUIDE_MARKDOWN,
        },
      ],
    })
  );
}
