import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const GUIDE_MARKDOWN = `# MockForge MCP

让 Coding Agent 从自然语言或 OpenAPI 直接生成可访问的 Mock REST 服务。每个模块对外暴露一个 \`mockBaseUrl\` —— 形如 \`<当前 MCP server 部署地址>/mock/<basePath>\`（例：你连的 MCP 是 \`http://localhost:3000\` 时，order 模块的 \`mockBaseUrl\` 就是 \`http://localhost:3000/mock/order\`）。每个模块含 CRUD + 业务规则 + Mock 数据。

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

## 12 个工具

**读**
- \`list_modules\` — 列出所有模块（name / status / health / endpoints / mockBaseUrl）
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

> 心智锚点：MCP 后端默认走**成本优先模型**（免费 gemma 系，中等偏弱）。决策按你（user 端 Agent）的模型档位选。

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

- \`moduleName\` 大小写敏感
- \`mockBaseUrl\` 是完整 URL，直接用，不要再拼 \`/mock\`
- 所有实体自动含 \`id\` / \`created_at\` / \`updated_at\`
- 响应信封 \`{ success, message, data }\`；list 端点 data 是 \`{ list, total, page, pageSize }\`
- 优先读 \`structuredContent\`（机读），\`content[0].text\` 是给人看的
- \`dry_run:true\` → 只解析校验不落地，先确认再真跑

## 接入业务代码（必读）

\`mockBaseUrl\` 跟业务代码原本的后端**不在同源**（host/port 不同），直接 fetch 会跨域。两种接法：

- **换 baseURL**：业务的 axios/fetch 客户端 \`baseURL\` 直接设为 \`mockBaseUrl\`（适合纯前端原型 / Node 端调用）
- **开发代理**（推荐，业务代码零改动）：在 dev server 把业务的 \`/api/*\` 转发到 \`mockBaseUrl\`
  - Vite：\`vite.config.ts\` 的 \`server.proxy['/api'] = { target: '<MCP host>', rewrite: p => p.replace(/^\\/api/, '/mock/<basePath>') }\`
  - Next.js：\`next.config.js\` 的 \`rewrites\`，\`source: '/api/:path*'\` → \`destination: '<mockBaseUrl>/:path*'\`
  - webpack devServer / CRA \`setupProxy.js\` / nginx \`proxy_pass\` 同理

**关键**：转发后到 MCP 的最终 URL 必须保留 \`/mock/<basePath>\` 前缀，否则 mock-router 匹配不到端点。

## onConflict（同模块已有任务在跑时）

- \`'resume'\`（默认）— attach 到在跑的，拿它的结果（\`actualInstruction\` ≠ \`yourInstruction\` 时附 \`warning\`）
- \`'reject'\` — 返 \`MOCKFORGE_ALREADY_PROCESSING\`，你自己决定
- \`'replace'\` — cancel 旧的再启新的

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
