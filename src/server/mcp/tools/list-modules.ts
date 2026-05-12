import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { computeModuleHealth } from '../../core/module-health.js';
import { summarizeEndpoints } from '../../core/openapi-export.js';
import { getMcpUserId, getMcpRequestOrigin } from '../context.js';
import { buildMockBaseUrl } from '../lib/mock-base-url.js';

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
      const requestOrigin = getMcpRequestOrigin();
      const rows = db.select().from(modules).where(eq(modules.userId, userId)).all();

      let urlSource: 'env-public-url' | 'request-origin' | 'fallback-localhost' = 'fallback-localhost';
      const list = rows.map((m) => {
        const report = computeModuleHealth(userId, m.name);
        const endpoints = summarizeEndpoints(userId, m.name);
        const effectiveStatus = report.health === 'healthy' && m.status !== 'active'
          ? 'active'
          : m.status;
        const built = buildMockBaseUrl({ moduleName: m.name, basePath: m.basePath, requestOrigin });
        urlSource = built.source;
        return {
          name: m.name,
          displayName: m.displayName,
          description: m.description || null,
          status: effectiveStatus,
          health: report.health,
          endpoints,
          mockBaseUrl: built.url,
          updatedAt: m.updatedAt,
        };
      });

      // 暴露 source 让 AI 自检 — fallback-localhost 在远程部署下就是错的,
      // 应该跟用户提示去配 MCP_PUBLIC_URL 或者反代加 X-Forwarded-*。
      const mockBaseUrlHint = urlSource === 'fallback-localhost'
        ? 'mockBaseUrl 用 localhost 兜底,若 MCP 部署在远程主机,请管理员配 env MCP_PUBLIC_URL 或反向代理加 X-Forwarded-Proto/Host/Port,否则把这个 URL 写入业务代码后部署会失败。'
        : undefined;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ modules: list, total: list.length, mockBaseUrlSource: urlSource, ...(mockBaseUrlHint ? { mockBaseUrlHint } : {}) }, null, 2),
          },
        ],
        structuredContent: {
          modules: list,
          total: list.length,
          mockBaseUrlSource: urlSource,
          ...(mockBaseUrlHint ? { mockBaseUrlHint } : {}),
        },
      };
    }
  );
}
