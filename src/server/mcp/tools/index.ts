import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListModulesTool } from './list-modules.js';
import { registerGetApiDocTool } from './get-api-doc.js';
import { registerGetOpenApiTool } from './get-openapi.js';

/** 注册所有 MCP 工具。Step-MCP-2 会追加写工具。 */
export function registerMcpTools(server: McpServer): void {
  registerListModulesTool(server);
  registerGetApiDocTool(server);
  registerGetOpenApiTool(server);
}
