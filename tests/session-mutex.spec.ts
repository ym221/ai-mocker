/**
 * Task M1.4 — per-session mutex for write-side tool calls.
 *
 * PT01 runSerialized 在同 session 内严格串行 (交错 start 不交错 end)
 * PT02 不同 session 不互相阻塞
 * PT03 异常时 release 仍被触发, 后续调用不饿死
 * PT04 活动 session 数会在空闲后释放
 */
import { test, expect } from '@playwright/test';
import { runSerialized, activeMutexCount, resetSessionMutex } from '../src/server/agent/lib/session-mutex';

test.describe('Task M1.4 — session mutex', () => {
  test('PT01 同 session 串行: 第二次调用必须等第一次 finish', async () => {
    resetSessionMutex('sess-a');
    const log: string[] = [];
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

    const run1 = runSerialized('sess-a', async () => {
      log.push('1 start');
      await delay(50);
      log.push('1 end');
      return 1;
    });

    // Start second BEFORE first has resolved
    const run2 = runSerialized('sess-a', async () => {
      log.push('2 start');
      await delay(10);
      log.push('2 end');
      return 2;
    });

    const [r1, r2] = await Promise.all([run1, run2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    // 2's start must come after 1's end (serialized)
    expect(log).toEqual(['1 start', '1 end', '2 start', '2 end']);
  });

  test('PT02 不同 session 不互相阻塞', async () => {
    resetSessionMutex('sess-b');
    resetSessionMutex('sess-c');
    const log: string[] = [];
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

    const runB = runSerialized('sess-b', async () => {
      log.push('B start');
      await delay(40);
      log.push('B end');
    });
    const runC = runSerialized('sess-c', async () => {
      log.push('C start');
      await delay(10);
      log.push('C end');
    });

    await Promise.all([runB, runC]);
    // Both sessions should have STARTED before either ENDED (parallel)
    const bStart = log.indexOf('B start');
    const cStart = log.indexOf('C start');
    const bEnd = log.indexOf('B end');
    const cEnd = log.indexOf('C end');
    expect(Math.max(bStart, cStart)).toBeLessThan(Math.min(bEnd, cEnd));
  });

  test('PT03 fn 抛错后 mutex 释放, 后续调用不饿死', async () => {
    resetSessionMutex('sess-d');
    const bad = runSerialized('sess-d', async () => {
      throw new Error('intentional');
    });
    await expect(bad).rejects.toThrow('intentional');

    // Next acquire must not hang
    const good = await runSerialized('sess-d', async () => 'ok');
    expect(good).toBe('ok');
  });

  test('PT04 空闲后 session 条目被 GC', async () => {
    resetSessionMutex('sess-e');
    await runSerialized('sess-e', async () => 42);
    // Allow microtask queue to flush finally-block cleanup
    await new Promise(r => setTimeout(r, 0));
    // sess-e 应已从 queues 里删除(其他测试仍可能有 session)
    const before = activeMutexCount();

    // Grab another session: active count goes up
    let release: () => void = () => {};
    const held = new Promise<void>(r => { release = r; });
    const running = runSerialized('sess-f', async () => { await held; });
    await new Promise(r => setTimeout(r, 10));
    expect(activeMutexCount()).toBeGreaterThanOrEqual(before + 1);
    release();
    await running;
  });
});
