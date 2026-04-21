import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const GUIDE_MARKDOWN = `# MockForge MCP — 给 AI 助手的使用指南

> 本文档由 MockForge 通过 MCP Resource 暴露给你（例如 Cursor / Claude Code）。
> 在操作本用户的 Mock 之前，请先阅读一次，以选择正确的工具组合。

## MockForge 是什么

MockForge 是一个 AI 驱动的 **Mock API 服务**。用户在 Web UI 里通过自然语言对话生成 Mock 模块，每个模块包含五件套：
\`controller.ts\` / \`schema.sql\` / \`_meta.json\` / \`test.ts\` / \`api-doc.md\`，并通过 \`/mock/<basePath>\` 动态路由对外提供 REST 端点。

同一个 MockForge 实例里，多个用户的模块相互隔离。你通过 API Key 鉴权访问到的是**当前这个用户**的模块。

## 当前可用工具（v1：只读）

| 工具 | 何时用 |
|------|--------|
| \`list_modules\` | 启动对话时先调一次，知道用户有哪些 Mock 模块、状态、健康度、可用端点 |
| \`get_api_doc\` | 需要人类可读契约时（生成业务代码前、解释给人看时） |
| \`get_openapi\` | 需要机器可读契约时（生成请求类型、对照响应结构、做字段 diff） |

**写能力（create / update / run_test）在下一版本。** 不要尝试调用这些尚未存在的工具。

## 推荐工作流

\`\`\`
① 列出模块         → list_modules
② 挑一个模块，拿契约 → get_openapi(moduleName)
③ 在业务代码里把 HTTP 请求代理到 mockBaseUrl（list_modules 的字段）
④ 跑业务测试
⑤ 失败了？对照 get_api_doc 的字段说明，判断根因：
   - 业务代码字段错 → 修业务代码
   - 契约本身不合理 → 记下（v2 将支持直接修 Mock）
   - Mock 返回错误 → 记下（v2 将支持直接修 Mock）
\`\`\`

## 字段规范

- **moduleName** 区分大小写，与 \`_meta.json\` 里的 \`name\` 一致
- **mockBaseUrl** 已经是可直接用的完整 URL（如 \`http://localhost:3000/mock/order\`），不需要再拼接
- **endpoints** 是实际可访问的 HTTP 路径列表（\`METHOD PATH\`），可以直接用于业务代码里的请求

## 错误处理

- 未知模块：工具会返回 \`isError: true\` + 明确的错误消息，不要重试
- 权限：你看到的就是你能访问的全部，不会有"隐藏模块"

## 返回值约定

所有工具的 \`structuredContent\` 是机器可读 JSON；\`content[0].text\` 是人类可读版本（可能是 markdown 或格式化 JSON）。
优先使用 \`structuredContent\` 做判断，用 \`content[0].text\` 做展示。
`;

export function registerGuideResource(server: McpServer): void {
  server.registerResource(
    'mockforge-guide',
    'mockforge://guide',
    {
      title: 'MockForge Usage Guide',
      description:
        'Required reading for any AI using MockForge MCP. Explains available tools, recommended workflow, and boundary conditions.',
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
