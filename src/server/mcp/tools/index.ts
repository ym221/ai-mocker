import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListModulesTool } from './list-modules.js';
import { registerListModelsTool } from './list-models.js';
import { registerInspectModuleTool } from './inspect-module.js';
import { registerGetMockAccessLogTool } from './get-mock-access-log.js';
import { registerDiffWithOpenApiTool } from './diff-with-openapi.js';
import { registerDeleteModuleTool } from './delete-module.js';
import { registerRunTestTool } from './run-test.js';
import { registerManageDataTool } from './manage-data.js';
import { registerCreateModuleFromSpecTool } from './create-module-from-spec.js';
import { registerUpdateModuleTool } from './update-module.js';
import { registerPatchModuleFieldTool } from './patch-module-field.js';
import { registerPatchModuleEndpointTool } from './patch-module-endpoint.js';
import { registerGetSessionStatusTool } from './get-session-status.js';
import { registerCancelSessionTool } from './cancel-session.js';
import { registerGenerateHandoffReportTool } from './generate-handoff-report.js';

/** 注册所有 MCP 工具。 */
export function registerMcpTools(server: McpServer): void {
  // Read tools
  registerListModulesTool(server);
  registerListModelsTool(server);
  registerInspectModuleTool(server);     // replaces get_api_doc + get_openapi + get_module_health
  registerGetMockAccessLogTool(server);
  registerDiffWithOpenApiTool(server);
  // Write tools (lightweight — directly wrap existing Agent tools)
  registerDeleteModuleTool(server);
  registerRunTestTool(server);
  registerManageDataTool(server);
  // Write tools (heavy — bridge ChatRunner)
  registerCreateModuleFromSpecTool(server);
  registerUpdateModuleTool(server);
  // Patch tools (deterministic, no LLM — Step-Loosen Phase 1)
  registerPatchModuleFieldTool(server);
  registerPatchModuleEndpointTool(server);
  // Session tools (MCP-5: resumability helpers)
  registerGetSessionStatusTool(server);
  registerCancelSessionTool(server);
  // Reporting
  registerGenerateHandoffReportTool(server);
}
