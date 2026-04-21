import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListModulesTool } from './list-modules.js';
import { registerGetApiDocTool } from './get-api-doc.js';
import { registerGetOpenApiTool } from './get-openapi.js';
import { registerGetMockAccessLogTool } from './get-mock-access-log.js';
import { registerGetModuleHealthTool } from './get-module-health.js';
import { registerDiffWithOpenApiTool } from './diff-with-openapi.js';
import { registerDeleteModuleTool } from './delete-module.js';
import { registerRunTestTool } from './run-test.js';
import { registerManageDataTool } from './manage-data.js';
import { registerCreateModuleFromSpecTool } from './create-module-from-spec.js';
import { registerUpdateModuleTool } from './update-module.js';
import { registerGenerateHandoffReportTool } from './generate-handoff-report.js';

/** 注册所有 MCP 工具。 */
export function registerMcpTools(server: McpServer): void {
  // Read tools
  registerListModulesTool(server);
  registerGetApiDocTool(server);
  registerGetOpenApiTool(server);
  registerGetMockAccessLogTool(server);
  registerGetModuleHealthTool(server);
  registerDiffWithOpenApiTool(server);
  // Write tools (lightweight — directly wrap existing Agent tools)
  registerDeleteModuleTool(server);
  registerRunTestTool(server);
  registerManageDataTool(server);
  // Write tools (heavy — bridge ChatRunner)
  registerCreateModuleFromSpecTool(server);
  registerUpdateModuleTool(server);
  // Reporting
  registerGenerateHandoffReportTool(server);
}
