/**
 * Step-Observability-1 / Task 3: tool-layer emit integration.
 *
 * Validates that write_files / write_file / run_test calls produce the
 * tool_timing event, and that failed calls (e.g., empty-args write_files)
 * trigger a repair_triggered event with the correct cause + attempt counter.
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');

test.beforeAll(async () => { await waitForBackend(); });

function createSession(): string {
  const id = randomUUID();
  const db = new Database(DB_PATH);
  try {
    db.prepare(
      `INSERT INTO sessions (id, title, user_id, run_status, last_seq) VALUES (?, ?, ?, 'idle', 0)`,
    ).run(id, '[OBS-TEST] tool-timing', 1);
    return id;
  } finally {
    db.close();
  }
}

function deleteSession(id: string) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  } finally {
    db.close();
  }
}

function readObsEvents(sessionId: string): Array<{ type: string; payload: any }> {
  const db = new Database(DB_PATH);
  try {
    const rows = db
      .prepare(`SELECT type, payload FROM message_events WHERE session_id = ? AND seq < 0 ORDER BY id ASC`)
      .all(sessionId) as Array<{ type: string; payload: string }>;
    return rows.map((r) => ({ type: r.type, payload: JSON.parse(r.payload) }));
  } finally {
    db.close();
  }
}

/**
 * buildTools requires a ChatRunner — we mock just enough surface (sessionId)
 * so the instrumentation path is exercised without spinning up a real session.
 */
function fakeRunner(sessionId: string) {
  return { sessionId } as any; // duck-typed: only sessionId is read by tool-registry
}

test.describe('tool-layer observability (Task 3)', () => {
  test('OB-T01 write_files empty input emits tool_timing(error) + repair_triggered', async () => {
    const { buildTools } = await import('../src/server/agent/tool-registry.js');
    const sid = createSession();
    try {
      const tools = buildTools(1, fakeRunner(sid));
      // Empty files array — write_files returns success:false
      const result = await tools.write_files.execute!({ files: [] as any }, { toolCallId: 't1', messages: [] } as any);
      expect((result as any).success).toBe(false);

      // Allow setImmediate emits to flush
      await new Promise((r) => setTimeout(r, 200));

      const events = readObsEvents(sid);
      const tooling = events.find((e) => e.type === 'tool_timing' && e.payload.toolName === 'write_files');
      expect(tooling).toBeTruthy();
      expect(tooling!.payload.resultSummary).toBe('error');
      expect(typeof tooling!.payload.durationMs).toBe('number');

      const repair = events.find((e) => e.type === 'repair_triggered');
      expect(repair).toBeTruthy();
      // empty-args message contains "switch to write_file" — classified as write_failed
      expect(['write_failed', 'sql_exec_failed', 'meta_parse_error']).toContain(repair!.payload.cause);
      expect(repair!.payload.attempt).toBe(1);
    } finally {
      deleteSession(sid);
    }
  });

  test('OB-T02 successful write_file emits tool_timing(ok) and NO repair', async () => {
    const { buildTools } = await import('../src/server/agent/tool-registry.js');
    const sid = createSession();
    try {
      const tools = buildTools(1, fakeRunner(sid));
      // Use a unique module name for this test run to avoid collisions
      const modName = `obs_t02_${Date.now()}`;
      const result = await tools.write_file.execute!(
        { path: `${modName}/api-doc.md`, content: '# OBS T02 doc' },
        { toolCallId: 't2', messages: [] } as any,
      );
      // writeFile returns a string on success per its impl; just ensure no throw
      expect(typeof result === 'string' || (result as any)?.success !== false).toBe(true);

      await new Promise((r) => setTimeout(r, 200));

      const events = readObsEvents(sid);
      const tooling = events.find((e) => e.type === 'tool_timing' && e.payload.toolName === 'write_file');
      expect(tooling).toBeTruthy();
      expect(tooling!.payload.resultSummary).toBe('ok');
      const repair = events.find((e) => e.type === 'repair_triggered');
      expect(repair).toBeFalsy();
    } finally {
      deleteSession(sid);
    }
  });

  test('OB-T03 repeated failures bump the attempt counter', async () => {
    const { buildTools } = await import('../src/server/agent/tool-registry.js');
    const sid = createSession();
    try {
      const tools = buildTools(1, fakeRunner(sid));

      await tools.write_files.execute!({ files: [] as any }, { toolCallId: 'a', messages: [] } as any);
      await tools.write_files.execute!({ files: [] as any }, { toolCallId: 'b', messages: [] } as any);
      await tools.write_files.execute!({ files: [] as any }, { toolCallId: 'c', messages: [] } as any);

      await new Promise((r) => setTimeout(r, 250));

      const events = readObsEvents(sid);
      const repairs = events.filter((e) => e.type === 'repair_triggered');
      expect(repairs.length).toBe(3);
      expect(repairs.map((r) => r.payload.attempt).sort()).toEqual([1, 2, 3]);
    } finally {
      deleteSession(sid);
    }
  });

  test('OB-T04 instrument is silent when no runner provided (tools usable outside chat)', async () => {
    const { buildTools } = await import('../src/server/agent/tool-registry.js');
    // No runner = no sessionId = should not throw and should not write any obs events
    const tools = buildTools(1, undefined);
    const result = await tools.write_files.execute!({ files: [] as any }, { toolCallId: 'n', messages: [] } as any);
    expect((result as any).success).toBe(false);
    // Nothing to assert on DB side because no sessionId
  });
});
