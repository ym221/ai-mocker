import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { buildOpenApi } from '../../core/openapi-export.js';
import { getMcpUserId } from '../context.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';

export function registerGetOpenApiTool(server: McpServer): void {
  server.registerTool(
    'get_openapi',
    {
      title: 'Get OpenAPI Spec',
      description:
        'Return the OpenAPI 3.0.3 specification for a Mock module, derived from its _meta.json. Useful when the IDE-side AI needs a machine-readable contract (types, request/response shapes) to align business code against.',
      inputSchema: {
        moduleName: z.string().describe('The name of the module'),
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
          hint: 'Call list_modules to see available modules.',
          moduleName,
        });
      }

      const spec = buildOpenApi(userId, moduleName);
      if (!spec) {
        return mcpError({
          code: MCP_ERROR_CODES.INTERNAL_ERROR,
          message: `Cannot build OpenAPI for '${moduleName}': _meta.json missing or invalid.`,
          hint: 'Call get_module_health to inspect. You may need update_module to regenerate.',
          moduleName,
        });
      }

      return {
        content: [
          { type: 'text', text: JSON.stringify(spec, null, 2) },
        ],
        structuredContent: { moduleName, openapi: spec },
      };
    }
  );
}
