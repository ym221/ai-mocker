import { sqlite } from './database.js';

const BODY_MAX = 8 * 1024; // 8KB 单字段上限
const KEEP_PER_USER = 10000; // 每用户保留最新条数
const TRIM_EVERY_N = 100;    // 每用户每 N 条 insert 做一次 trim

const trimCounters = new Map<number, number>();

function safeStringify(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    if (str.length > BODY_MAX) return str.slice(0, BODY_MAX) + `…(truncated, original ${str.length}B)`;
    return str;
  } catch {
    return '[unserializable]';
  }
}

export interface AccessLogEntry {
  userId: number;
  moduleName: string;
  method: string;
  path: string;          // 完整 /mock/xxx/xxx
  statusCode: number;
  durationMs: number;
  requestBody?: unknown;
  responseBody?: unknown;
}

/**
 * 异步记录一次 /mock/* 请求。任何失败都会吞掉——access log 不能影响业务响应。
 */
export function recordMockAccess(entry: AccessLogEntry): void {
  try {
    sqlite.prepare(
      `INSERT INTO mock_requests (user_id, module_name, method, path, status_code, duration_ms, request_body, response_body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.userId,
      entry.moduleName,
      entry.method.toUpperCase(),
      entry.path,
      entry.statusCode,
      Math.max(0, Math.round(entry.durationMs)),
      safeStringify(entry.requestBody),
      safeStringify(entry.responseBody),
    );

    // 滚动清理：每 N 条做一次，避免每次都扫表
    const count = (trimCounters.get(entry.userId) || 0) + 1;
    if (count >= TRIM_EVERY_N) {
      trimCounters.set(entry.userId, 0);
      sqlite.prepare(
        `DELETE FROM mock_requests
           WHERE user_id = ?
             AND id NOT IN (
               SELECT id FROM mock_requests WHERE user_id = ? ORDER BY id DESC LIMIT ?
             )`
      ).run(entry.userId, entry.userId, KEEP_PER_USER);
    } else {
      trimCounters.set(entry.userId, count);
    }
  } catch {
    // 任何异常都吞掉
  }
}

/** 测试用：暴露 trim 的显式入口（不触发 counter）。 */
export function trimUserAccessLog(userId: number, keep: number = KEEP_PER_USER): void {
  sqlite.prepare(
    `DELETE FROM mock_requests
       WHERE user_id = ?
         AND id NOT IN (
           SELECT id FROM mock_requests WHERE user_id = ? ORDER BY id DESC LIMIT ?
         )`
  ).run(userId, userId, keep);
}
