/**
 * Step-Fix-1.3: watchdog decision logic.
 *
 * Pure unit test for decideWatchdog — verifies that a session declaring
 * moduleIntent=create/update MUST produce a write_file/write_files tool call,
 * otherwise the framework nudges up to maxNudge times, and on exhaustion
 * returns `fail` (finalize as error, NEVER silent-done).
 *
 * Full-integration validation happens in F3.1 real-LLM E2E.
 */
import { test, expect } from '@playwright/test';
import { decideWatchdog, buildNudgeMessage } from '../src/server/agent/watchdog';

test.describe('watchdog decision (Step-Fix-1.3)', () => {
  test('WD01 no moduleIntent → proceed (regular chat unaffected)', () => {
    const a = decideWatchdog({ hasWriteCall: false, nudgesIssued: 0, maxNudge: 2 });
    expect(a.kind).toBe('proceed');
  });

  test('WD02 moduleIntent=none → proceed', () => {
    const a = decideWatchdog({ moduleIntentOp: 'none', hasWriteCall: false, nudgesIssued: 0, maxNudge: 2 });
    expect(a.kind).toBe('proceed');
  });

  test('WD03 create + wrote file → proceed', () => {
    const a = decideWatchdog({ moduleIntentOp: 'create', hasWriteCall: true, nudgesIssued: 0, maxNudge: 2 });
    expect(a.kind).toBe('proceed');
  });

  test('WD04 update + wrote file → proceed', () => {
    const a = decideWatchdog({ moduleIntentOp: 'update', hasWriteCall: true, nudgesIssued: 0, maxNudge: 2 });
    expect(a.kind).toBe('proceed');
  });

  test('WD05 create + no write, 0 nudges so far → nudge #1', () => {
    const a = decideWatchdog({ moduleIntentOp: 'create', hasWriteCall: false, nudgesIssued: 0, maxNudge: 2 });
    expect(a).toEqual({ kind: 'nudge', attempt: 1, total: 2 });
  });

  test('WD06 create + no write, 1 nudge so far → nudge #2', () => {
    const a = decideWatchdog({ moduleIntentOp: 'create', hasWriteCall: false, nudgesIssued: 1, maxNudge: 2 });
    expect(a).toEqual({ kind: 'nudge', attempt: 2, total: 2 });
  });

  test('WD07 create + no write, max nudges exhausted → fail (never silent-done)', () => {
    const a = decideWatchdog({ moduleIntentOp: 'create', hasWriteCall: false, nudgesIssued: 2, maxNudge: 2 });
    expect(a.kind).toBe('fail');
    if (a.kind === 'fail') {
      expect(a.message).toContain('moduleIntent=create');
      expect(a.message).toContain('3'); // 2 nudges + 1 original = 3 attempts total
      expect(a.message).toContain('write_file');
    }
  });

  test('WD08 update + no write, max exhausted → fail with correct op in message', () => {
    const a = decideWatchdog({ moduleIntentOp: 'update', hasWriteCall: false, nudgesIssued: 2, maxNudge: 2 });
    expect(a.kind).toBe('fail');
    if (a.kind === 'fail') {
      expect(a.message).toContain('moduleIntent=update');
    }
  });

  test('WD09 maxNudge=0 disables nudging → fail immediately after first empty', () => {
    const a = decideWatchdog({ moduleIntentOp: 'create', hasWriteCall: false, nudgesIssued: 0, maxNudge: 0 });
    expect(a.kind).toBe('fail');
  });

  test('WD10 maxNudge=5 supports longer nudge budgets', () => {
    for (let i = 0; i < 5; i++) {
      const a = decideWatchdog({ moduleIntentOp: 'create', hasWriteCall: false, nudgesIssued: i, maxNudge: 5 });
      expect(a.kind).toBe('nudge');
    }
    const final = decideWatchdog({ moduleIntentOp: 'create', hasWriteCall: false, nudgesIssued: 5, maxNudge: 5 });
    expect(final.kind).toBe('fail');
  });

  test('WD11 buildNudgeMessage mentions operation + module + both tools + 5 required files', () => {
    const msg = buildNudgeMessage('create', 'warehouse');
    expect(msg).toContain('create');
    expect(msg).toContain('warehouse');
    expect(msg).toContain('write_files');
    expect(msg).toContain('write_file');
    expect(msg).toContain('_meta.json');
    expect(msg).toContain('schema.sql');
    expect(msg).toContain('controller.ts');
    expect(msg).toContain('test.ts');
    expect(msg).toContain('api-doc.md');
  });

  test('WD12 buildNudgeMessage for update operation', () => {
    const msg = buildNudgeMessage('update', 'inventory');
    expect(msg).toContain('update');
    expect(msg).toContain('inventory');
  });
});
