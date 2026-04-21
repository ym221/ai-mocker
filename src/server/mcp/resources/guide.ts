import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const GUIDE_MARKDOWN = `# MockForge MCP — 给 AI 助手的使用指南

> 你（IDE 里的 AI）通过 MCP 访问 MockForge。本指南告诉你怎么高效组合工具跑完"从需求到交接"整条闭环。

## MockForge 是什么

MockForge 是 AI 驱动的 **Mock API 服务**。用户在 Web UI 对话生成 Mock 模块，每个模块由五件套构成：
\`controller.ts\` / \`schema.sql\` / \`_meta.json\` / \`test.ts\` / \`api-doc.md\`，通过 \`/mock/<basePath>\` 动态路由对外提供 REST 端点。

你当前连接的是**某个用户**的上下文。看到的、能修改的都是这个用户的模块，互不干扰。

## 11 个工具

### 读
- \`list_modules\` — 列出当前用户的所有模块（name / status / health / endpoints / mockBaseUrl）
- \`get_api_doc\` — 拿模块的 api-doc.md（人类可读）
- \`get_openapi\` — 拿模块的 OpenAPI 3.0.3 JSON（机器可读）
- \`get_mock_access_log\` — 查业务代码最近打到 Mock 的真实请求和响应
- \`get_module_health\` — 检查模块健康状态（5 文件 + 表 + _meta 结构）
- \`diff_with_openapi\` — 把实际请求/响应与契约做结构化 diff

### 写（轻量，即时生效）
- \`manage_data\` — 造数/增删改查数据（insert / bulk_generate / list / update / delete / batch_delete / clear）
- \`run_test\` — 跑模块的 test.ts 回归
- \`delete_module\` — **不可逆**删模块

### 写（重量，触发 AI 生成，~30s-3min）
- \`create_module_from_spec\` — 从 OpenAPI/YAML/自然语言生成新模块。支持 \`dry_run: true\` 预览
- \`update_module\` — 用自然语言指令修改已有模块。支持 \`dry_run: true\` 预览

### 汇报
- \`generate_handoff_report\` — 输出 Markdown 交接报告（契约 + 健康度 + 访问日志 + 后端建议）

## 推荐工作流

\`\`\`
① 新需求进来：看有没有可复用的
   → list_modules

② 没有 → 从 PRD 或已有 OpenAPI 生成 Mock
   → create_module_from_spec({ spec })      // 可先 dry_run:true 预览
   → 拿 mockBaseUrl，在业务代码里代理到这个地址

③ 有 → 拿契约写业务代码
   → get_openapi({ moduleName })            // 生成请求类型、客户端

④ 写完业务代码，跑业务测试

⑤ 测试失败？定位根因：
   → get_mock_access_log({ moduleName })    // 看业务真的发了什么
   → diff_with_openapi({ moduleName, actualRequest, actualResponse })
                                             // 看契约在哪儿对不齐
   → 根据 diff 判断：
     - kind=missing-in-actual → 业务代码漏字段，改业务
     - kind=missing-in-spec    → 契约漏字段，改 Mock（update_module）
     - kind=type-mismatch      → 看类型谁对，改对应侧
     - kind=endpoint-not-in-spec → 业务路径写错 或 Mock 少端点

⑥ Mock 需要改
   → update_module({ moduleName, instruction })  // 可先 dry_run:true
   → run_test({ moduleName })                    // 验证改动没坏别的

⑦ 回到 ④，循环到测试全绿

⑧ 需要造数做 UI 展示 或 跑压力测试
   → manage_data({ action:'bulk_generate', count:50 })

⑨ 跟后端交接
   → generate_handoff_report({ moduleName })
   → 把返回的 markdown 给后端团队
\`\`\`

## 关键规范

- **moduleName** 大小写敏感，与 \`_meta.json\` 的 \`name\` 一致
- **mockBaseUrl** 是可直接用的完整 URL（如 \`http://localhost:3000/mock/order\`），不要再拼接 \`/mock\`
- 所有实体自动包含 \`id\` / \`created_at\` / \`updated_at\` 三个字段，OpenAPI 里也有
- 响应统一 \`{ success, message, data }\` 信封；list 端点 data 是 \`{ list, total, page, pageSize }\`

## 长任务的进度反馈

\`create_module_from_spec\` / \`update_module\` 会调 LLM，执行时间秒到分钟不等。你通过 MCP 协议的 **progress notifications** 收到阶段进度（thinking / writing / tool / module_update 四种阶段），不原样转发 LLM 产生的内容。

## 软 warnings

短期内对同一模块调 \`update_module\` 超过 10 次，返回会带 \`warnings: [{ code:"HIGH_RETRY_COUNT", ... }]\`，**不阻断**调用，但提示你可能陷入错误循环，建议先看 \`get_mock_access_log\` 和 \`get_module_health\` 诊断。

## dry_run 语义

- \`create_module_from_spec({ dry_run: true })\` 纯解析 spec，返回将创建的 moduleName / entities / endpoints，不动 DB/FS
- \`update_module({ dry_run: true })\` 校验模块存在，返回当前端点清单，供你向用户确认再真跑

## 错误处理

- 未知模块 / 参数错 → 工具返回 \`isError: true\` + 明确错误消息，不要重试
- 权限：你看到的就是你能访问的全部；跨用户数据不可见
- 写工具（create/update）若 AI 生成失败，会返回 sessionId，用户可在 Web UI 里打开这个 session 查看详细事件日志，必要时人工接管

## 返回值约定

所有工具都同时返回：
- \`content[0].text\`：人类可读摘要（markdown 或格式化 JSON）
- \`structuredContent\`：机器可读结构化数据（优先用这个做判断）

优先读 \`structuredContent\`，把 \`content\` 留给展示给人。
`;

export function registerGuideResource(server: McpServer): void {
  server.registerResource(
    'mockforge-guide',
    'mockforge://guide',
    {
      title: 'MockForge Usage Guide',
      description:
        'Required reading for any AI using MockForge MCP. Tool catalog, recommended workflow, diff decision tree, progress / warnings semantics.',
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
