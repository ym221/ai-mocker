import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { deleteModule } from '../../agent/tools/delete-module.js';
import { getMcpUserId } from '../context.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';

export function registerDeleteModuleTool(server: McpServer): void {
  server.registerTool(
    'delete_module',
    {
      title: 'Delete a Mock Module',
      description:
        'Permanently delete a Mock module: drops its SQLite tables, removes generated files, and cleans up the modules registry row. IRREVERSIBLE. Only call when the user or AI explicitly intends to remove the module.',
      inputSchema: {
        moduleName: z.string().describe('Module name to delete'),
      },
    },
    async ({ moduleName }) => {
      const userId = getMcpUserId();

      const mod = db.select().from(modules)
        .where(and(eq(modules.userId, userId), eq(modules.name, moduleName)))
        .get();
      if (!mod) {
        return mcpError({
          code: MCP_ERROR_CODES.MODULE_NOT_FOUND,
          message: `Module '${moduleName}' not found.`,
          hint: 'Call list_modules to see available modules.',
          moduleName,
        });
      }

      const message = await deleteModule(userId, moduleName);
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { moduleName, deleted: true },
      };
    }
  );
}
