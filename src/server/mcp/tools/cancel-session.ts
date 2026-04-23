import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { sessions } from '../../core/schema.js';
import { getMcpUser } from '../context.js';
import { ChatRunner } from '../../agent/chat-runner.js';
import { attachAndWait, getSessionSnapshot } from '../lib/headless-session.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';

export function registerCancelSessionTool(server: McpServer): void {
  server.registerTool(
    'cancel_session',
    {
      title: 'Cancel MCP Session',
      description:
        'Abort a running MCP-originated session. Safe to call when the session is already terminal (no-op). '
        + 'Use when a session is stuck or when you want to start over with a different instruction — combine with update_module({ onConflict: "replace" }) to do it in one step.',
      inputSchema: {
        sessionId: z.string().describe('The session id to cancel'),
      },
    },
    async ({ sessionId }) => {
      const user = getMcpUser();

      const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
      if (!row) {
        return mcpError({
          code: MCP_ERROR_CODES.SESSION_NOT_FOUND,
          message: `Session '${sessionId}' not found.`,
          hint: 'Check the sessionId. Use get_session_status(sessionId) to verify state.',
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

      const before = getSessionSnapshot(sessionId);
      const runner = ChatRunner.get(sessionId);

      if (!runner || !runner.isLive()) {
        // Already terminal — idempotent no-op
        return {
          content: [{
            type: 'text',
            text: `Session ${sessionId} is not running (status=${before?.status ?? 'unknown'}). No action taken.`,
          }],
          structuredContent: {
            sessionId,
            status: before?.status ?? 'unknown',
            wasLive: false,
            elapsedBeforeCancel: before?.elapsedSec ?? null,
          },
        };
      }

      try { runner.pause(); } catch { /* ignore */ }

      // Wait briefly for the runner to finalize
      await attachAndWait(sessionId, 10).catch(() => null);

      const after = getSessionSnapshot(sessionId);
      const elapsed = before?.elapsedSec ?? null;

      return {
        content: [{
          type: 'text',
          text: `Session ${sessionId} aborted after ${elapsed ?? '?'}s (status=${after?.status ?? 'aborted'}).`,
        }],
        structuredContent: {
          sessionId,
          status: after?.status ?? 'aborted',
          wasLive: true,
          elapsedBeforeCancel: elapsed,
        },
      };
    }
  );
}
