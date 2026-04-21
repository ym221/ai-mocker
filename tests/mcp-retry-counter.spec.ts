/**
 * retry-counter 单元测试（纯内存逻辑，不涉及 DB/HTTP）
 */
import { test, expect } from '@playwright/test';
import {
  bumpRetryCounter,
  resetAllRetryCounters,
  getRetryCount,
} from '../src/server/mcp/lib/retry-counter.js';

test.beforeEach(() => { resetAllRetryCounters(); });

test.describe('retry-counter', () => {
  test('R01 第一次 bump 无 warning', () => {
    const w = bumpRetryCounter('1:foo:update');
    expect(w).toBeUndefined();
    expect(getRetryCount('1:foo:update')).toBe(1);
  });

  test('R02 达到阈值（10）开始返回 HIGH_RETRY_COUNT warning', () => {
    const key = '1:bar:update';
    for (let i = 0; i < 9; i++) {
      expect(bumpRetryCounter(key)).toBeUndefined();
    }
    const w = bumpRetryCounter(key); // 第 10 次
    expect(w).toBeDefined();
    expect(w?.[0]?.code).toBe('HIGH_RETRY_COUNT');
    expect(w?.[0]?.message).toContain('10');
  });

  test('R03 不同 key 独立计数', () => {
    bumpRetryCounter('1:a:update');
    bumpRetryCounter('1:a:update');
    bumpRetryCounter('2:a:update');
    expect(getRetryCount('1:a:update')).toBe(2);
    expect(getRetryCount('2:a:update')).toBe(1);
    expect(getRetryCount('1:b:update')).toBe(0);
  });

  test('R04 warning 文案含动作名', () => {
    const key = '1:order:update';
    for (let i = 0; i < 10; i++) bumpRetryCounter(key);
    const w = bumpRetryCounter(key);
    expect(w?.[0]?.message).toContain('update');
  });
});
