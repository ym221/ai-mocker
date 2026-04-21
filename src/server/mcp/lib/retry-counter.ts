/**
 * 进程内存里的 retry counter，为 MCP 写工具提供软 warnings。
 *
 * 设计：
 * - key = `${userId}:${moduleName}:${tool}`（例如 '1:order:update'）
 * - 24h 内 >= 10 次触发软 warning（不阻断）
 * - 超过 48h 的记录自动过期
 * - 进程重启清零（可接受；CURSOR 有记录）
 */

export interface Warning {
  code: string;
  message: string;
}

interface Entry {
  count: number;
  firstAt: number;
  lastAt: number;
}

const counters = new Map<string, Entry>();
const WINDOW_MS = 24 * 60 * 60 * 1000;
const THRESHOLD = 10;
const PURGE_EVERY = 100;  // 每 N 次 bump 触发一次过期清理

let bumpsSinceLastPurge = 0;

function purgeExpired() {
  const now = Date.now();
  for (const [k, v] of counters.entries()) {
    if (now - v.lastAt > WINDOW_MS * 2) counters.delete(k);
  }
}

/**
 * 增加指定 key 的计数，返回当前值超过阈值时的 warning 数组。
 */
export function bumpRetryCounter(key: string): Warning[] | undefined {
  const now = Date.now();
  const prev = counters.get(key);
  if (!prev) {
    counters.set(key, { count: 1, firstAt: now, lastAt: now });
  } else if (now - prev.firstAt > WINDOW_MS) {
    // window 外，重置
    counters.set(key, { count: 1, firstAt: now, lastAt: now });
  } else {
    prev.count += 1;
    prev.lastAt = now;
  }

  bumpsSinceLastPurge += 1;
  if (bumpsSinceLastPurge >= PURGE_EVERY) {
    bumpsSinceLastPurge = 0;
    purgeExpired();
  }

  const entry = counters.get(key)!;
  if (entry.count >= THRESHOLD) {
    return [{
      code: 'HIGH_RETRY_COUNT',
      message: `This module has been modified ${entry.count} times in the last 24h via '${key.split(':').pop()}'. If you're looping on an error, consider pausing to inspect the access log and module health, or ask a human to review.`,
    }];
  }
  return undefined;
}

/** 测试用/模块删除时：清理某个 key 的计数。 */
export function resetRetryCounter(key: string): void {
  counters.delete(key);
}

/** 测试用：清空全部。 */
export function resetAllRetryCounters(): void {
  counters.clear();
}

/** 读取当前值（测试用）。 */
export function getRetryCount(key: string): number {
  return counters.get(key)?.count || 0;
}
