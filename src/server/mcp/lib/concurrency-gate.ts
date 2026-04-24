/**
 * Per-user + global concurrency gate for MCP heavy write operations.
 *
 * Rationale: IDE AI Agents that retry aggressively after client timeouts can
 * cascade into many concurrent sessions. The per-user cap prevents a single
 * user (or runaway AI) from DoS-ing themselves; the global cap protects the
 * box as a whole.
 *
 * Only NEW sessions are counted — attach-on-resume does NOT consume a slot
 * (it reuses an already-counted one).
 */

export interface ActiveSlot {
  userId: number;
  sessionId: string;
  moduleName: string | null;
  startedAt: number;
}

export interface RunningSessionInfo {
  sessionId: string;
  moduleName: string | null;
  elapsedSec: number;
}

export interface AcquireOk { ok: true }
export interface AcquireBusy {
  ok: false;
  scope: 'user' | 'global';
  userConcurrent: number;
  userLimit: number;
  globalConcurrent: number;
  globalLimit: number;
  runningSessions: RunningSessionInfo[];
  hint: string;
}
export type AcquireResult = AcquireOk | AcquireBusy;

const slots = new Map<string, ActiveSlot>(); // sessionId -> slot

function userLimit(): number {
  return Number(process.env.MCP_USER_CONCURRENCY_LIMIT || 3);
}
function globalLimit(): number {
  return Number(process.env.MCP_GLOBAL_CONCURRENCY_LIMIT || 10);
}

function currentUserCount(userId: number): number {
  let n = 0;
  for (const s of slots.values()) if (s.userId === userId) n += 1;
  return n;
}

function buildRunningList(userId: number): RunningSessionInfo[] {
  const now = Date.now();
  const list: RunningSessionInfo[] = [];
  for (const s of slots.values()) {
    if (s.userId === userId) {
      list.push({
        sessionId: s.sessionId,
        moduleName: s.moduleName,
        elapsedSec: Math.floor((now - s.startedAt) / 1000),
      });
    }
  }
  return list;
}

/** Try to acquire a slot for a new session. Does NOT insert on failure. */
export function tryAcquire(userId: number, sessionId: string, moduleName: string | null): AcquireResult {
  const uLimit = userLimit();
  const gLimit = globalLimit();
  const gConc = slots.size;
  const uConc = currentUserCount(userId);

  if (gConc >= gLimit) {
    return {
      ok: false,
      scope: 'global',
      userConcurrent: uConc,
      userLimit: uLimit,
      globalConcurrent: gConc,
      globalLimit: gLimit,
      runningSessions: buildRunningList(userId),
      hint: 'Global concurrency limit reached. Wait for one of the running sessions to finish, or ask an admin to raise MCP_GLOBAL_CONCURRENCY_LIMIT.',
    };
  }
  if (uConc >= uLimit) {
    return {
      ok: false,
      scope: 'user',
      userConcurrent: uConc,
      userLimit: uLimit,
      globalConcurrent: gConc,
      globalLimit: gLimit,
      runningSessions: buildRunningList(userId),
      hint: 'Per-user concurrency limit reached. Wait for one of the running sessions to finish, or call cancel_session(sessionId) to abort one.',
    };
  }

  slots.set(sessionId, {
    userId,
    sessionId,
    moduleName,
    startedAt: Date.now(),
  });
  return { ok: true };
}

/** Release a slot. Safe to call multiple times. */
export function release(sessionId: string): void {
  slots.delete(sessionId);
}

/** List active slots (for tests / diagnostics). */
export function listSlots(): ActiveSlot[] {
  return Array.from(slots.values());
}

/** Test helper — clear all tracked slots. */
export function resetSlots(): void {
  slots.clear();
}

/** Counts (for tests). */
export function counts(userId: number): { user: number; global: number; userLimit: number; globalLimit: number } {
  return {
    user: currentUserCount(userId),
    global: slots.size,
    userLimit: userLimit(),
    globalLimit: globalLimit(),
  };
}
