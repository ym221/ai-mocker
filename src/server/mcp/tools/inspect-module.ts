import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { buildOpenApi } from '../../core/openapi-export.js';
import { computeModuleHealth } from '../../core/module-health.js';
import { getMcpUserId } from '../context.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';

const GENERATED_DIR = resolve('generated');

type View = 'all' | 'doc' | 'openapi' | 'health';

interface InspectView {
  doc?: { markdown: string | null; hasFile: boolean };
  openapi?: { spec: unknown | null };
  health?: {
    status: 'healthy' | 'degraded' | 'missing';
    missingFiles: string[];
    metaValid: boolean;
    hasTable: boolean;
    tableName: string | null;
  };
}

function readDocSection(userId: number, moduleName: string): InspectView['doc'] {
  const p = join(GENERATED_DIR, String(userId), moduleName, 'api-doc.md');
  if (!existsSync(p)) return { markdown: null, hasFile: false };
  try {
    return { markdown: readFileSync(p, 'utf-8'), hasFile: true };
  } catch {
    return { markdown: null, hasFile: true };
  }
}

function buildHumanText(moduleName: string, view: View, sections: InspectView): string {
  const lines: string[] = [`Inspect "${moduleName}" (view=${view}):`];
  if (sections.health) {
    const h = sections.health;
    lines.push(`  health: ${h.status}${h.missingFiles.length ? ' · missing: ' + h.missingFiles.join(', ') : ''}${!h.hasTable && h.tableName ? ' · table missing: ' + h.tableName : ''}`);
  }
  if (sections.openapi) {
    const paths = Object.keys((sections.openapi.spec as any)?.paths ?? {});
    lines.push(`  openapi: ${paths.length} path(s)${paths.length ? ' — ' + paths.slice(0, 6).join(', ') + (paths.length > 6 ? '…' : '') : ''}`);
  }
  if (sections.doc) {
    const mdLen = sections.doc.markdown?.length ?? 0;
    lines.push(`  doc: ${mdLen > 0 ? mdLen + ' chars' : '(missing)'}`);
  }
  return lines.join('\n');
}

export function registerInspectModuleTool(server: McpServer): void {
  server.registerTool(
    'inspect_module',
    {
      title: 'Inspect a Mock Module',
      description:
        'Get everything you need to know about a module in one call: API doc, OpenAPI spec, and health status. '
        + 'Defaults to view="all" (returns all three). Pass view="doc" / "openapi" / "health" to narrow. '
        + 'Replaces the older get_api_doc / get_openapi / get_module_health trio — call this instead.',
      inputSchema: {
        moduleName: z.string().describe('The module name'),
        view: z.enum(['all', 'doc', 'openapi', 'health']).optional().describe('Which section(s) to return. Default: "all"'),
      },
    },
    async ({ moduleName, view }) => {
      const userId = getMcpUserId();
      const effective: View = view ?? 'all';

      const mod = db.select().from(modules)
        .where(and(eq(modules.userId, userId), eq(modules.name, moduleName)))
        .get();
      if (!mod) {
        return mcpError({
          code: MCP_ERROR_CODES.MODULE_NOT_FOUND,
          message: `Module '${moduleName}' not found.`,
          hint: 'Call list_modules to see available modules, or use create_module_from_spec to create a new one.',
          moduleName,
        });
      }

      const sections: InspectView = {};
      if (effective === 'all' || effective === 'doc') {
        sections.doc = readDocSection(userId, moduleName);
      }
      if (effective === 'all' || effective === 'openapi') {
        const spec = buildOpenApi(userId, moduleName);
        sections.openapi = { spec: spec ?? null };
      }
      if (effective === 'all' || effective === 'health') {
        const report = computeModuleHealth(userId, moduleName);
        sections.health = {
          status: report.health,
          missingFiles: report.missing,
          metaValid: report.metaValid,
          hasTable: report.hasTable,
          tableName: report.tableName,
        };
      }

      return {
        content: [{ type: 'text', text: buildHumanText(moduleName, effective, sections) }],
        structuredContent: {
          moduleName,
          view: effective,
          ...sections,
        },
      };
    },
  );
}
