/**
 * Per-user in-flight MCP operation guard.
 *
 * Problem: when an IDE AI Agent (Cursor / Claude Code) hits a timeout waiting
 * for a long MCP tool call (create_module_from_spec / update_module can take
 * 3+ minutes), it often retries the same call. Each retry used to create a
 * brand-new session + ChatRunner in parallel. Two concurrent runners for the
 * same module produced:
 *   - duplicate "[MCP] create X" entries in the sessions sidebar
 *   - race on the modules table (one sets 'active', the other resets to 'editing')
 *   - the later runner, on applyModuleIntent, reconciles to 'edit' even though
 *     nothing changed, leaving the AI stuck in a "nothing to do" loop for
 *     7-10 minutes until the hard timeout.
 *
 * Fix: refuse to start a new MCP-orchestrated runner while another one is
 * already running for the same (userId, moduleName) pair. The caller gets a
 * clear "already-processing" signal and the existing session keeps going.
 *
 * The guard is best-effort:
 *   - It keys on (userId, moduleName). Calls without an explicit moduleName
 *     (AI infers it) skip the guard — that's fine because retries from clients
 *     typically carry the same moduleName.
 *   - It also checks the sessions table for `runStatus='running'` so that a
 *     server restart (registry wiped) doesn't falsely block a legitimate new
 *     call.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { sessions } from '../../core/schema.js';
import { ChatRunner } from '../../agent/chat-runner.js';

export interface InFlightCheck {
  inFlight: boolean;
  existingSessionId?: string;
}

/**
 * Check whether the given user already has a live ChatRunner (MCP-originated
 * or Web-UI-originated) processing this moduleName.
 */
export function findInFlightSession(userId: number, moduleName: string): InFlightCheck {
  const running = db.select()
    .from(sessions)
    .where(and(
      eq(sessions.userId, userId),
      eq(sessions.moduleName, moduleName),
      eq(sessions.runStatus, 'running'),
    ))
    .all();
  for (const s of running) {
    const r = ChatRunner.get(s.id);
    if (r && r.isLive()) {
      return { inFlight: true, existingSessionId: s.id };
    }
  }
  return { inFlight: false };
}
