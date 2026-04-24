import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { getMcpUserId } from '../context.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';

const GENERATED_DIR = resolve('generated');

export function registerGetApiDocTool(server: McpServer): void {
  server.registerTool(
    'get_api_doc',
    {
      title: 'Get API Documentation',
      description:
        'Read the api-doc.md for a specific Mock module. Use this to feed the contract to another AI or to show the human what endpoints/fields are available.',
      inputSchema: {
        moduleName: z.string().describe('The name of the module (matches directory name under generated/<userId>/)'),
      },
    },
    async ({ moduleName }) => {
      const userId = getMcpUserId();

      const mod = db
        .select()
        .from(modules)
        .where(and(eq(modules.userId, userId), eq(modules.name, moduleName)))
        .get();
      if (!mod) {
        return mcpError({
          code: MCP_ERROR_CODES.MODULE_NOT_FOUND,
          message: `Module '${moduleName}' not found for current user.`,
          hint: 'Call list_modules to see available modules, or use create_module_from_spec to create a new one.',
          moduleName,
        });
      }

      const docPath = join(GENERATED_DIR, String(userId), moduleName, 'api-doc.md');
      if (!existsSync(docPath)) {
        return mcpError({
          code: MCP_ERROR_CODES.INTERNAL_ERROR,
          message: `api-doc.md missing for module '${moduleName}'. The module may be in an inconsistent state.`,
          hint: 'Call get_module_health to inspect. You may need update_module to regenerate, or delete + recreate.',
          moduleName,
        });
      }

      const markdown = readFileSync(docPath, 'utf-8');
      return {
        content: [{ type: 'text', text: markdown }],
        structuredContent: { moduleName, markdown },
      };
    }
  );
}
