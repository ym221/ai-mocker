import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { manageData } from '../../agent/tools/manage-data.js';
import { getMcpUserId } from '../context.js';

export function registerManageDataTool(server: McpServer): void {
  server.registerTool(
    'manage_data',
    {
      title: 'Manage Mock Data',
      description:
        'Insert / update / delete / clear / list / bulk_generate mock records. Use bulk_generate to quickly seed N rows with faker. Use insert/update/delete for targeted tweaks. Use list to inspect before changing. All operations are isolated per user.',
      inputSchema: {
        action: z
          .enum(['insert', 'update', 'delete', 'batch_delete', 'clear', 'list', 'bulk_generate'])
          .describe('Operation to perform'),
        moduleName: z.string(),
        data: z.any().optional().describe('Record payload object (for insert/update)'),
        id: z.number().optional().describe('Record id (for update/delete)'),
        ids: z.array(z.number()).optional().describe('Record ids (for batch_delete)'),
        count: z.number().optional().describe('Number of records (for bulk_generate)'),
        entityName: z.string().optional().describe('Entity name (defaults to first entity)'),
        page: z.number().optional(),
        pageSize: z.number().optional(),
        orderBy: z.string().optional(),
        where: z.any().optional().describe('Filter conditions object'),
      },
    },
    async ({ action, moduleName, data, id, ids, count, entityName, page, pageSize, orderBy, where }) => {
      const userId = getMcpUserId();
      try {
        const result = await manageData(userId, action, moduleName, data, {
          count, id, ids, entityName, page, pageSize, orderBy, where,
        });
        return {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
          structuredContent: { action, moduleName, result },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `manage_data failed: ${msg}` }],
        };
      }
    }
  );
}
