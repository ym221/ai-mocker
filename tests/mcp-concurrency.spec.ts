/**
 * Task 5.4 — concurrency gate unit tests (CC01-CC05).
 *
 * The gate is in-memory per-process, so we drive it directly (same process
 * as the test). E2E verification that the MCP HTTP layer surfaces the gate
 * is covered in the Task 5.6 acceptance spec.
 */
import { test, expect } from '@playwright/test';

test.describe('Task 5.4 — concurrency gate', () => {
  test.beforeEach(async () => {
    const { resetSlots } = await import('../src/server/mcp/lib/concurrency-gate.js');
    resetSlots();
  });

  test('CC01 per-user limit 命中返 BUSY + runningSessions', async () => {
    const { tryAcquire, resetSlots } = await import('../src/server/mcp/lib/concurrency-gate.js');
    // Default USER_LIMIT = 3
    expect(tryAcquire(1, 'sid1', 'mod1').ok).toBe(true);
    expect(tryAcquire(1, 'sid2', 'mod2').ok).toBe(true);
    expect(tryAcquire(1, 'sid3', 'mod3').ok).toBe(true);

    const r4 = tryAcquire(1, 'sid4', 'mod4');
    expect(r4.ok).toBe(false);
    if (!r4.ok) {
      expect(r4.scope).toBe('user');
      expect(r4.userConcurrent).toBe(3);
      expect(r4.userLimit).toBe(3);
      expect(r4.runningSessions.length).toBe(3);
      expect(r4.runningSessions[0].moduleName).toBeTruthy();
      expect(r4.hint).toBeTruthy();
    }
    resetSlots();
  });

  test('CC02 global limit 与 per-user 互相独立', async () => {
    const { tryAcquire, counts, resetSlots } = await import('../src/server/mcp/lib/concurrency-gate.js');
    // 3 users × 3 sessions each = 9; 10th would hit global (default 10)
    for (let u = 1; u <= 3; u++) {
      for (let s = 1; s <= 3; s++) {
        const r = tryAcquire(u, `u${u}-s${s}`, `mod${s}`);
        expect(r.ok).toBe(true);
      }
    }
    expect(counts(1).global).toBe(9);

    // User 4 first session → global OK (9<10), user ok (0<3)
    expect(tryAcquire(4, 'u4-s1', 'mod1').ok).toBe(true);
    expect(counts(4).global).toBe(10);

    // User 4 second session → global full
    const r = tryAcquire(4, 'u4-s2', 'mod2');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.scope).toBe('global');
      expect(r.globalConcurrent).toBe(10);
    }
    resetSlots();
  });

  test('CC03 attach 不计数 (同一 sessionId 不重复占 slot)', async () => {
    const { tryAcquire, counts, resetSlots } = await import('../src/server/mcp/lib/concurrency-gate.js');
    expect(tryAcquire(1, 'sid1', 'mod1').ok).toBe(true);
    expect(counts(1).user).toBe(1);
    // Re-acquire same sessionId — should replace not accumulate
    tryAcquire(1, 'sid1', 'mod1');
    expect(counts(1).user).toBe(1);
    resetSlots();
  });

  test('CC04 release after terminal', async () => {
    const { tryAcquire, release, counts, resetSlots } = await import('../src/server/mcp/lib/concurrency-gate.js');
    tryAcquire(1, 'sid1', 'mod1');
    tryAcquire(1, 'sid2', 'mod2');
    expect(counts(1).user).toBe(2);
    release('sid1');
    expect(counts(1).user).toBe(1);
    release('sid2');
    expect(counts(1).user).toBe(0);
    resetSlots();
  });

  test('CC05 env 可调', async () => {
    const { tryAcquire, resetSlots } = await import('../src/server/mcp/lib/concurrency-gate.js');
    const orig = process.env.MCP_USER_CONCURRENCY_LIMIT;
    process.env.MCP_USER_CONCURRENCY_LIMIT = '2';
    try {
      expect(tryAcquire(1, 's1', 'm1').ok).toBe(true);
      expect(tryAcquire(1, 's2', 'm2').ok).toBe(true);
      const r = tryAcquire(1, 's3', 'm3');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.userLimit).toBe(2);
    } finally {
      if (orig == null) delete process.env.MCP_USER_CONCURRENCY_LIMIT;
      else process.env.MCP_USER_CONCURRENCY_LIMIT = orig;
      resetSlots();
    }
  });
});
