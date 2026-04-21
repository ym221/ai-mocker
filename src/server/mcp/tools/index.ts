import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpUser } from '../context.js';

/**
 * 注册所有 MCP 工具。Task 1.4 会补齐真实工具。
 */
export function registerMcpTools(server: McpServer): void {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Health check for the MockForge MCP server. Returns the authenticated user info.',
      inputSchema: {},
    },
    async () => {
      const user = getMcpUser();
      return {
        content: [
          {
            type: 'text',
            text: `pong — authenticated as ${user.username} (id=${user.userId})`,
          },
        ],
      };
    }
  );

  // 占位：用于让测试能看到 zod import 不报错
  void z;
}
