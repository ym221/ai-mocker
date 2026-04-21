import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sqlite } from '../../core/database.js';
import { getMcpUserId } from '../context.js';

interface AccessLogRow {
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  request_body: string | null;
  response_body: string | null;
  created_at: string;
}

function tryParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

export function registerGetMockAccessLogTool(server: McpServer): void {
  server.registerTool(
    'get_mock_access_log',
    {
      title: 'Get Mock Access Log',
      description:
        'Return the most recent /mock/* requests for a specific module. Use this to see exactly what the business code sent and what the Mock returned — essential for diagnosing whether a test failure is a Mock bug or a business-code bug.',
      inputSchema: {
        moduleName: z.string().describe('The module name to filter by'),
        limit: z.number().optional().describe('Max rows to return (default 20, max 100)'),
        sinceMinutes: z.number().optional().describe('Only include requests from the last N minutes (optional)'),
      },
    },
    async ({ moduleName, limit, sinceMinutes }) => {
      const userId = getMcpUserId();
      const capped = Math.min(100, Math.max(1, limit ?? 20));

      let rows: AccessLogRow[];
      if (sinceMinutes && sinceMinutes > 0) {
        rows = sqlite.prepare(
          `SELECT method, path, status_code, duration_ms, request_body, response_body, created_at
             FROM mock_requests
             WHERE user_id = ? AND module_name = ?
               AND created_at >= datetime('now', ?)
             ORDER BY id DESC
             LIMIT ?`
        ).all(userId, moduleName, `-${sinceMinutes} minutes`, capped) as AccessLogRow[];
      } else {
        rows = sqlite.prepare(
          `SELECT method, path, status_code, duration_ms, request_body, response_body, created_at
             FROM mock_requests
             WHERE user_id = ? AND module_name = ?
             ORDER BY id DESC
             LIMIT ?`
        ).all(userId, moduleName, capped) as AccessLogRow[];
      }

      const logs = rows.map((r) => ({
        method: r.method,
        path: r.path,
        statusCode: r.status_code,
        durationMs: r.duration_ms,
        requestBody: tryParse(r.request_body),
        responseBody: tryParse(r.response_body),
        createdAt: r.created_at,
      }));

      const totalRow = sqlite.prepare(
        `SELECT COUNT(*) as c FROM mock_requests WHERE user_id = ? AND module_name = ?`
      ).get(userId, moduleName) as { c: number };

      return {
        content: [{ type: 'text', text: JSON.stringify({ logs, total: totalRow.c }, null, 2) }],
        structuredContent: { logs, total: totalRow.c, returned: logs.length },
      };
    }
  );
}
