import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { computeModuleHealth } from '../../core/module-health.js';
import { summarizeEndpoints } from '../../core/openapi-export.js';
import { getMcpUserId } from '../context.js';

function getMockBaseUrl(name: string, basePath: string | null | undefined): string {
  const port = process.env.PORT || '3000';
  const host = process.env.MCP_PUBLIC_HOST || 'localhost';
  let path = basePath || `/mock/${name}`;
  if (!path.startsWith('/mock')) {
    // 兼容老数据 basePath 只存了 /<name> 的情况
    path = '/mock' + (path.startsWith('/') ? path : '/' + path);
  }
  return `http://${host}:${port}${path}`;
}

export function registerListModulesTool(server: McpServer): void {
  server.registerTool(
    'list_modules',
    {
      title: 'List Mock Modules',
      description:
        'List all Mock API modules owned by the authenticated user. Returns each module\'s name, status, health, endpoints, and the base URL to proxy business code to.',
      inputSchema: {},
    },
    async () => {
      const userId = getMcpUserId();
      const rows = db.select().from(modules).where(eq(modules.userId, userId)).all();

      const list = rows.map((m) => {
        const report = computeModuleHealth(userId, m.name);
        const endpoints = summarizeEndpoints(userId, m.name);
        const effectiveStatus = report.health === 'healthy' && m.status !== 'active'
          ? 'active'
          : m.status;
        return {
          name: m.name,
          displayName: m.displayName,
          description: m.description || null,
          status: effectiveStatus,
          health: report.health,
          endpoints,
          mockBaseUrl: getMockBaseUrl(m.name, m.basePath),
          updatedAt: m.updatedAt,
        };
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ modules: list, total: list.length }, null, 2),
          },
        ],
        structuredContent: { modules: list, total: list.length },
      };
    }
  );
}
