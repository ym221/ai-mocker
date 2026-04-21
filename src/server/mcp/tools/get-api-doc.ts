import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { getMcpUserId } from '../context.js';

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
        return {
          isError: true,
          content: [
            { type: 'text', text: `Module '${moduleName}' not found for current user.` },
          ],
        };
      }

      const docPath = join(GENERATED_DIR, String(userId), moduleName, 'api-doc.md');
      if (!existsSync(docPath)) {
        return {
          isError: true,
          content: [
            { type: 'text', text: `api-doc.md missing for module '${moduleName}'. The module may be in an inconsistent state.` },
          ],
        };
      }

      const markdown = readFileSync(docPath, 'utf-8');
      return {
        content: [{ type: 'text', text: markdown }],
        structuredContent: { moduleName, markdown },
      };
    }
  );
}
