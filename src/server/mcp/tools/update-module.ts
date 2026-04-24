import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { getMcpUser } from '../context.js';
import { summarizeEndpoints } from '../../core/openapi-export.js';
import { bumpRetryCounter } from '../lib/retry-counter.js';
import { snapshotMeta, diffSnapshots } from '../lib/update-diff.js';
import { buildUpdateUserContent, extractUpdateInstruction } from '../lib/instruction-utils.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';
import { runWriteTool } from '../lib/write-tool-runner.js';

const GENERATED_DIR = resolve('generated');

function readModuleApiDocHead(userId: number, moduleName: string): string {
  const p = join(GENERATED_DIR, String(userId), moduleName, 'api-doc.md');
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf-8').slice(0, 500); } catch { return ''; }
}

export function registerUpdateModuleTool(server: McpServer): void {
  server.registerTool(
    'update_module',
    {
      title: 'Update Existing Mock Module',
      description:
        'Modify an existing Mock module. Pass a natural-language instruction describing the desired change (add a field, add an endpoint, tweak response shape, fix a bug). '
        + 'Blocks up to `waitMaxSec` seconds (default 60, max 300); if generation is still running when the window elapses returns { status:"still-running", sessionId } — call this tool again with the same args to auto-resume. '
        + 'If another session for this moduleName is already in-flight, `onConflict` decides: "resume" (default) attaches to it, "reject" returns ALREADY_PROCESSING, "replace" cancels it and starts fresh. '
        + 'Set dry_run=true to preview which entities/fields/endpoints would change without touching files. Triggers a full AI generation cycle; progress streamed via MCP progress notifications.',
      inputSchema: {
        moduleName: z.string(),
        instruction: z.string().describe('Natural-language description of the change'),
        waitMaxSec: z.number().int().optional().describe('Max seconds to block waiting for the run to finish. Default 60, max 300.'),
        onConflict: z.enum(['resume', 'reject', 'replace']).optional().describe('Behavior when another session is already updating this moduleName. Default "resume".'),
        provider: z.number().int().optional(),
        model: z.string().optional(),
        preset: z.union([z.number().int(), z.string()]).optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async ({ moduleName, instruction, waitMaxSec, onConflict, provider, model, preset, dry_run }, extra) => {
      const user = getMcpUser();

      // Module existence
      const existing = db.select().from(modules)
        .where(and(eq(modules.userId, user.userId), eq(modules.name, moduleName)))
        .get();
      if (!existing) {
        return mcpError({
          code: MCP_ERROR_CODES.MODULE_NOT_FOUND,
          message: `Module '${moduleName}' not found.`,
          hint: 'Call list_modules to see available modules, or use create_module_from_spec to create a new one.',
          moduleName,
        });
      }

      // Dry run
      if (dry_run) {
        const endpoints = summarizeEndpoints(user.userId, moduleName);
        return {
          content: [{
            type: 'text',
            text: `DRY RUN — would ask AI to modify module "${moduleName}" per instruction: ${instruction}\nCurrent endpoints:\n  ${endpoints.join('\n  ')}`,
          }],
          structuredContent: {
            moduleName,
            status: 'would-update',
            instruction,
            currentEndpoints: endpoints,
          },
        };
      }

      const before = snapshotMeta(user.userId, moduleName);

      return runWriteTool({
        userId: user.userId,
        moduleName,
        waitMaxSec,
        onConflict,
        provider,
        model,
        preset,
        extra,
        userContent: buildUpdateUserContent(moduleName, instruction),
        title: `[MCP] update ${moduleName}`,
        yourInstruction: instruction,
        extractOriginalFromContent: extractUpdateInstruction,
        toolKind: 'update',

        buildSuccessResponse: ({ result, attached, driftWarning, actualInstruction }) => {
          const after = snapshotMeta(user.userId, moduleName);
          const richDiff = diffSnapshots(before, after);
          const apiDoc = readModuleApiDocHead(user.userId, moduleName);
          const retryWarnings = bumpRetryCounter(`${user.userId}:${moduleName}:update`) ?? [];
          const allWarnings = [...richDiff.warnings, ...retryWarnings];

          const summaryText = richDiff.lines.length
            ? `Updated "${moduleName}":\n  ${richDiff.lines.join('\n  ')}`
            : `Updated "${moduleName}" (no structural diff detected)`;
          const warningSuffix = richDiff.warnings.length
            ? `\nNotes:\n  ${richDiff.warnings.join('\n  ')}`
            : '';
          const attachSuffix = attached ? `\n(attached to running session ${result.sessionId})` : '';
          const driftSuffix = driftWarning ? `\n\nWARNING: ${driftWarning}` : '';

          return {
            content: [{ type: 'text', text: summaryText + warningSuffix + attachSuffix + driftSuffix }],
            structuredContent: {
              moduleName,
              status: 'updated',
              sessionId: result.sessionId,
              attached,
              diff: richDiff.lines,
              structuralOnly: richDiff.lines.length > 0 && richDiff.warnings.length === 0,
              hasChange: richDiff.hasChange,
              apiDocPreview: apiDoc,
              warnings: allWarnings,
              ...(attached && actualInstruction != null ? { actualInstruction } : {}),
              ...(attached ? { yourInstruction: instruction } : {}),
              ...(driftWarning ? { warning: driftWarning } : {}),
            },
          };
        },

        buildStillRunningResponse: ({ result, attached, driftWarning, actualInstruction }) => {
          const text = `Module "${moduleName}" is still updating (elapsed ${result.elapsedSec ?? '?'}s, stage=${result.stage ?? 'unknown'}, session=${result.sessionId}). `
            + `Call update_module(${JSON.stringify({ moduleName })}, ...) again with the same arguments to auto-resume.`;
          return {
            content: [{ type: 'text', text }],
            structuredContent: {
              moduleName,
              status: 'still-running',
              sessionId: result.sessionId,
              attached,
              stage: result.stage,
              elapsedSec: result.elapsedSec,
              lastEventSeq: result.lastEventSeq,
              hint: 'Call update_module again with the same arguments to auto-resume. Use get_session_status(sessionId) for a live snapshot, or cancel_session(sessionId) to abort.',
              ...(attached && actualInstruction != null ? { actualInstruction } : {}),
              ...(attached ? { yourInstruction: instruction } : {}),
              ...(driftWarning ? { warning: driftWarning } : {}),
            },
          };
        },
      });
    },
  );
}
