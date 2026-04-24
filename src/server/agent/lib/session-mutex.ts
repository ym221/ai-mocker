/**
 * Per-session async mutex for serializing write-side tool executions.
 *
 * Rationale:
 *   When the model emits parallel tool calls in a single turn (supported by
 *   OpenAI-compatible + Anthropic + Gemini models), the AI SDK invokes all
 *   tool `execute()` functions concurrently. Reads (read_file / list_modules /
 *   get_module_template) are idempotent and can truly run in parallel. Writes
 *   (write_files / manage_data / run_test / delete_module) touch filesystem +
 *   SQLite and must be serialized within a session to avoid:
 *     - File write races on overlapping paths
 *     - Interleaved SQL transactions in better-sqlite3 (which is sync but
 *       async callbacks can be scheduled out-of-order)
 *     - Partial state seen by run_test while write_files is still committing
 *
 * Scope:
 *   Key is `sessionId`. Cross-session concurrency is governed by
 *   concurrency-gate.ts (runs BEFORE session starts) and doesn't need the
 *   mutex. The mutex only protects tool executions WITHIN one AI turn.
 */

type ResolveFn = () => void;

const queues = new Map<string, Promise<void>>();

/** Acquire the session's mutex; run fn; release. Returns whatever fn returns. */
export async function runSerialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(sessionId) ?? Promise.resolve();

  let release: ResolveFn = () => {};
  const next = new Promise<void>((r) => { release = r; });
  const myTail = prior.then(() => next);
  queues.set(sessionId, myTail);

  try {
    await prior;
    return await fn();
  } finally {
    release();
    // If nobody chained behind us, drop the map entry so memory doesn't grow.
    // If a later acquire came in, queues.get() now points to their tail, not ours.
    if (queues.get(sessionId) === myTail) {
      queues.delete(sessionId);
    }
  }
}

/** Test/ops helper: clear the queue for a session (e.g. after a crash). */
export function resetSessionMutex(sessionId: string): void {
  queues.delete(sessionId);
}

/** Test helper: how many sessions currently hold a chain? */
export function activeMutexCount(): number {
  return queues.size;
}
