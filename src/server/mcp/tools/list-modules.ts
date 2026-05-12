import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules, users } from '../../core/schema.js';
import { computeModuleHealth } from '../../core/module-health.js';
import { summarizeEndpoints } from '../../core/openapi-export.js';
import { getMcpUser, getMcpRequestOrigin } from '../context.js';
import { buildMockBaseUrl } from '../lib/mock-base-url.js';

/**
 * Look up minimal user info {id, username} for a list of user ids in one query.
 * Returns Map for O(1) per-module lookup when building the response.
 */
function loadUserInfoMap(userIds: number[]): Map<number, { id: number; username: string }> {
  const map = new Map<number, { id: number; username: string }>();
  if (userIds.length === 0) return map;
  const unique = Array.from(new Set(userIds));
  const rows = db.select({ id: users.id, username: users.username }).from(users).all();
  for (const r of rows) {
    if (unique.includes(r.id)) map.set(r.id, { id: r.id, username: r.username });
  }
  return map;
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
      const ctx = getMcpUser();
      const requestOrigin = getMcpRequestOrigin();
      const rows = db.select().from(modules).where(eq(modules.userId, ctx.userId)).all();

      // 一次查全部相关 user 信息,避免 N+1
      const userIds: number[] = [];
      for (const m of rows) {
        if (m.userId) userIds.push(m.userId);
        if (m.updatedBy) userIds.push(m.updatedBy);
      }
      const userMap = loadUserInfoMap(userIds);
      const lookupUser = (id: number | null | undefined) =>
        id ? (userMap.get(id) ?? { id, username: `#${id}` }) : null;

      let urlSource: 'env-public-url' | 'request-origin' | 'fallback-localhost' = 'fallback-localhost';
      const list = rows.map((m) => {
        const report = computeModuleHealth(ctx.userId, m.name);
        const endpoints = summarizeEndpoints(ctx.userId, m.name);
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
          createdBy: lookupUser(m.userId),
          updatedBy: lookupUser(m.updatedBy ?? m.userId),
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        };
      });

      // 暴露 source 让 AI 自检 — fallback-localhost 在远程部署下就是错的,
      // 应该跟用户提示去配 MCP_PUBLIC_URL 或者反代加 X-Forwarded-*。
      const mockBaseUrlHint = urlSource === 'fallback-localhost'
        ? 'mockBaseUrl 用 localhost 兜底,若 MCP 部署在远程主机,请管理员配 env MCP_PUBLIC_URL 或反向代理加 X-Forwarded-Proto/Host/Port,否则把这个 URL 写入业务代码后部署会失败。'
        : undefined;

      const payload = {
        currentUser: { id: ctx.userId, username: ctx.username },
        modules: list,
        total: list.length,
        mockBaseUrlSource: urlSource,
        ...(mockBaseUrlHint ? { mockBaseUrlHint } : {}),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    }
  );
}
