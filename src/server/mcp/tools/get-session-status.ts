import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { sessions } from '../../core/schema.js';
import { getMcpUser } from '../context.js';
import { getSessionSnapshot } from '../lib/headless-session.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';

export function registerGetSessionStatusTool(server: McpServer): void {
  server.registerTool(
    'get_session_status',
    {
      title: 'Get MCP Session Status',
      description:
        'Light-weight non-blocking snapshot of a running or finished MCP-originated session. '
        + 'Use this to peek at progress while update_module / create_module_from_spec is still running (instead of re-calling the write tool with waitMaxSec). '
        + 'Returns status (running/done/error/paused/aborted), stage label, elapsedSec, lastEventSeq, and the most recent event summaries. '
        + 'Pair with cancel_session to abort a stuck run.',
      inputSchema: {
        sessionId: z.string().describe('The session id returned by update_module / create_module_from_spec'),
      },
    },
    async ({ sessionId }) => {
      const user = getMcpUser();

      // Scope check: session must belong to current user
      const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
      if (!row) {
        return mcpError({
          code: MCP_ERROR_CODES.SESSION_NOT_FOUND,
          message: `Session '${sessionId}' not found.`,
          hint: 'Check the sessionId you were given. Use list_modules to see modules and their most recent state.',
          sessionId,
        });
      }
      if (row.userId !== user.userId) {
        return mcpError({
          code: MCP_ERROR_CODES.SESSION_NOT_FOUND,
          message: `Session '${sessionId}' not found.`,
          hint: 'Sessions are per-user. Confirm you are using the correct API key.',
          sessionId,
        });
      }

      const snap = getSessionSnapshot(sessionId);
      if (!snap) {
        return mcpError({
          code: MCP_ERROR_CODES.SESSION_NOT_FOUND,
          message: `Session '${sessionId}' snapshot unavailable.`,
          hint: 'The session may have been purged. Start a fresh call to re-generate.',
          sessionId,
        });
      }

      return {
        content: [{
          type: 'text',
          text: `Session ${snap.sessionId} — status=${snap.status}, stage=${snap.stage}, elapsed=${snap.elapsedSec ?? '?'}s, lastEventSeq=${snap.lastEventSeq}`,
        }],
        structuredContent: {
          sessionId: snap.sessionId,
          status: snap.status,
          moduleName: snap.moduleName,
          title: snap.title,
          stage: snap.stage,
          elapsedSec: snap.elapsedSec,
          lastEventSeq: snap.lastEventSeq,
          recentEvents: snap.recentEvents.map((e) => ({
            seq: e.seq,
            type: e.type,
            createdAt: e.createdAt,
            payloadSummary: summarizePayload(e.type, e.payload),
          })),
          errorMessage: snap.errorMessage,
        },
      };
    }
  );
}

/** Shorten an event payload for display (don't leak full content to the caller). */
function summarizePayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case 'thinking':
    case 'text':
      return { chars: typeof (payload as any)?.text === 'string' ? (payload as any).text.length : 0 };
    case 'tool_call':
      return { name: (payload as any)?.name };
    case 'tool_result':
      return { name: (payload as any)?.name, success: (payload as any)?.success };
    case 'card': {
      const d = (payload as any)?.data ?? payload;
      return { kind: (payload as any)?.kind, moduleName: d?.moduleName, status: d?.status };
    }
    case 'error':
      return { message: (payload as any)?.message };
    case 'done':
    case 'paused':
    case 'aborted':
      return { message: (payload as any)?.message };
    case 'user':
      return { startedAt: (payload as any)?.startedAt };
    default:
      return {};
  }
}
