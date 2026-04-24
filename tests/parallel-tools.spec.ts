/**
 * Task M1.4 — integration test: buildTools 集成 session mutex.
 *
 * 验证:
 * - PT-T01 同 session 内并发 invoke write_files 被串行
 * - PT-T02 同 session 内并发 invoke read_file 不被串行 (真正并行)
 * - PT-T03 buildTools 在无 runner 参数时 tool 仍可直接调用 (无 mutex, 回退行为)
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const USER_ID = 1;
const MODULE = 'pt_mutex_mod';
const MOD_DIR = resolve(process.cwd(), 'generated', String(USER_ID), MODULE);

function cleanFixture() {
  if (existsSync(MOD_DIR)) rmSync(MOD_DIR, { recursive: true, force: true });
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
    db.exec(`DROP TABLE IF EXISTS mock__${USER_ID}_${MODULE}`);
  } finally { db.close(); }
}

/** Minimal fake runner just exposing sessionId for the mutex key. */
function fakeRunner(sessionId: string): any {
  return { sessionId };
}

test.beforeAll(async () => { await waitForBackend(); });

test.describe('Task M1.4 — parallel/serial tool dispatch via buildTools', () => {
  test.beforeEach(() => cleanFixture());
  test.afterAll(() => cleanFixture());

  test('PT-T01 同 session 并发 write_files 被串行 (第二次后观察第一次结果)', async () => {
    const { buildTools } = await import('../src/server/agent/tool-registry.js');
    const tools = buildTools(USER_ID, fakeRunner('mutex-sess-1') as any);

    const files1 = [
      { path: `${MODULE}/a.md`, content: 'first-a' },
      { path: `${MODULE}/b.md`, content: 'first-b' },
    ];
    const files2 = [
      { path: `${MODULE}/a.md`, content: 'second-a' },
      { path: `${MODULE}/b.md`, content: 'second-b' },
    ];

    // Fire both concurrently — mutex must serialize
    const [r1, r2] = await Promise.all([
      (tools as any).write_files.execute({ files: files1 }),
      (tools as any).write_files.execute({ files: files2 }),
    ]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    // Final disk state must be fully from one batch or the other,
    // NEVER interleaved (e.g. a.md=first-a + b.md=second-b is impossible under serialized mutex)
    const { readFileSync } = await import('fs');
    const aContent = readFileSync(resolve(MOD_DIR, 'a.md'), 'utf-8');
    const bContent = readFileSync(resolve(MOD_DIR, 'b.md'), 'utf-8');
    // Both files must come from the same batch
    const fromSecond = aContent === 'second-a' && bContent === 'second-b';
    const fromFirst = aContent === 'first-a' && bContent === 'first-b';
    expect(fromSecond || fromFirst).toBe(true);
  });

  test('PT-T02 同 session 并发 read_file 真正并行 (双方都完整返 content)', async () => {
    // Pre-seed two files directly
    mkdirSync(MOD_DIR, { recursive: true });
    writeFileSync(resolve(MOD_DIR, 'x.md'), 'x-content', 'utf-8');
    writeFileSync(resolve(MOD_DIR, 'y.md'), 'y-content', 'utf-8');

    const { buildTools } = await import('../src/server/agent/tool-registry.js');
    const tools = buildTools(USER_ID, fakeRunner('mutex-sess-2') as any);

    // Both issued in parallel — no mutex on reads; they can interleave freely
    const [rx, ry] = await Promise.all([
      (tools as any).read_file.execute({ path: `${MODULE}/x.md` }),
      (tools as any).read_file.execute({ path: `${MODULE}/y.md` }),
    ]);

    expect(rx).toContain('x-content');
    expect(ry).toContain('y-content');
  });

  test('PT-T03 无 runner 参数时 tool 仍可直接调用 (回退: no mutex 但功能正常)', async () => {
    const { buildTools } = await import('../src/server/agent/tool-registry.js');
    const tools = buildTools(USER_ID);  // no runner

    const r = await (tools as any).write_files.execute({
      files: [{ path: `${MODULE}/solo.md`, content: 'solo content' }],
    });
    expect(r.success).toBe(true);
    const { readFileSync } = await import('fs');
    expect(readFileSync(resolve(MOD_DIR, 'solo.md'), 'utf-8')).toBe('solo content');
  });
});
