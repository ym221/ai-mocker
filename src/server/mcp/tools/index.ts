import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListModulesTool } from './list-modules.js';
import { registerGetApiDocTool } from './get-api-doc.js';
import { registerGetOpenApiTool } from './get-openapi.js';
import { registerGetMockAccessLogTool } from './get-mock-access-log.js';
import { registerGetModuleHealthTool } from './get-module-health.js';

/** 注册所有 MCP 工具。 */
export function registerMcpTools(server: McpServer): void {
  // Read tools
  registerListModulesTool(server);
  registerGetApiDocTool(server);
  registerGetOpenApiTool(server);
  registerGetMockAccessLogTool(server);
  registerGetModuleHealthTool(server);
}
