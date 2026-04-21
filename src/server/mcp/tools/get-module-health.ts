import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { computeModuleHealth } from '../../core/module-health.js';
import { getMcpUserId } from '../context.js';

export function registerGetModuleHealthTool(server: McpServer): void {
  server.registerTool(
    'get_module_health',
    {
      title: 'Get Module Health',
      description:
        'Diagnose a module\'s health: checks all 5 required files exist, _meta.json parses, and the SQLite table is present. Use this before blaming the Mock when something misbehaves.',
      inputSchema: {
        moduleName: z.string().describe('Module name'),
      },
    },
    async ({ moduleName }) => {
      const userId = getMcpUserId();
      const report = computeModuleHealth(userId, moduleName);

      const summary = `Module "${moduleName}" is ${report.health.toUpperCase()}.`
        + (report.missing.length ? ` Missing files: ${report.missing.join(', ')}.` : '')
        + (!report.metaValid ? ' _meta.json invalid.' : '')
        + (!report.hasTable && report.tableName ? ` Table ${report.tableName} missing.` : '');

      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: {
          moduleName,
          health: report.health,
          missingFiles: report.missing,
          metaValid: report.metaValid,
          hasTable: report.hasTable,
          tableName: report.tableName,
        },
      };
    }
  );
}
