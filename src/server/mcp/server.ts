import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from './tools/index.js';
import { registerGuideResource } from './resources/guide.js';

const SERVER_INFO = {
  name: 'mockforge',
  version: '0.1.0',
  title: 'MockForge',
};

/**
 * 每个 MCP 请求创建一个全新的 McpServer 实例（stateless 模式）。
 * 用户上下文由 mcpUserContext (AsyncLocalStorage) 承载，不通过实例参数传递。
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: {},
      resources: {},
    },
  });
  registerMcpTools(server);
  registerGuideResource(server);
  return server;
}
