import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { resetTests, runAllTests } from '../../core/test-runner.js';
import { mockContext } from '../../core/base-model.js';
import { sqlite } from '../../core/database.js';
import { getEntities } from '../../core/meta-schema.js';
import { injectUserIdToTableNames } from '../../core/table-name-prefix.js';

const GENERATED_DIR = resolve('generated');

/** 抽取 schema.sql 里的 INSERT 语句,用于 run_test 清表后重灌种子。
 *  按 ';' 切语句,保留所有 INSERT 变体(INSERT INTO / INSERT OR IGNORE INTO /
 *  INSERT OR REPLACE INTO 等 — AI 常用 OR IGNORE 防重复);假设 VALUES 内不嵌
 *  套真实分号。 */
function extractInsertStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map(s => s.trim())
    .filter(s => /^INSERT(\s+OR\s+(IGNORE|REPLACE|ABORT|FAIL|ROLLBACK))?\s+INTO\s+/i.test(s));
}

export async function runTest(userId: number, moduleName: string): Promise<{
  passed: number;
  total: number;
  failures: { name: string; error: string }[];
}> {
  const testPath = join(GENERATED_DIR, String(userId), moduleName, 'test.ts');

  if (!existsSync(testPath)) {
    throw new Error(`Test file not found: ${moduleName}/test.ts`);
  }

  // 每次跑测试前 reset 到种子态:清表 + 重置自增 + 重放 schema.sql 的 INSERT。
  // 让 spec 要求的"种子数据 N 条"在测试中始终可见,test case "列表 ≥1 条" 可重复通过。
  const metaPath = join(GENERATED_DIR, String(userId), moduleName, '_meta.json');
  const schemaPath = join(GENERATED_DIR, String(userId), moduleName, 'schema.sql');
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      for (const entity of getEntities(meta)) {
        const bare = (entity.tableName || `mock__${entity.name}`).replace(/^mock__/, '');
        const tableName = `mock__${userId}_${bare}`;
        try {
          sqlite.exec(`DELETE FROM \`${tableName}\``);
          try { sqlite.exec(`DELETE FROM sqlite_sequence WHERE name = '${tableName}'`); }
          catch { /* sqlite_sequence 可能不存在 */ }
        } catch { /* 表还没建 */ }
      }

      if (existsSync(schemaPath)) {
        const schemaContent = readFileSync(schemaPath, 'utf-8');
        for (const stmt of extractInsertStatements(schemaContent)) {
          const injected = injectUserIdToTableNames(stmt, userId);
          try { sqlite.exec(injected); }
          catch (err) {
            console.warn(`[run_test] seed re-insert failed for ${moduleName}: ${(err as Error).message}`);
          }
        }
      }
    } catch { /* 非关键路径 */ }
  }

  // Reset test registry
  resetTests();

  // Dynamic import with cache busting
  const fileUrl = pathToFileURL(testPath).href + `?t=${Date.now()}`;

  // Step-Workflow-1 fix:AI 经常在 test.ts 自写 fetch(url) 用相对路径(忽略框架的
  // request helper),Node fetch 拒绝相对 URL → "Failed to parse URL"。临时 wrap
  // globalThis.fetch:遇到以 / 开头的 url 自动加 base,绝对 URL 透传。
  const PORT = Number(process.env.PORT) || 3000;
  const BASE_URL = `http://127.0.0.1:${PORT}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch(BASE_URL + input, init);
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  try {
    return await mockContext.run({ userId }, async () => {
      await import(fileUrl);
      return runAllTests();
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * Lightweight syntax check: does test.ts actually transpile/parse?
 *
 * A weak model can emit a truncated test.ts (token cut-off → "Unexpected end of
 * file"). Smoke-test passes (it only calls a controller), so the broken self-test
 * ships silently and only fails when the user later calls run_test. Running this
 * at finalize lets us surface it as a warning instead.
 *
 * Does NOT execute the tests — just imports the file (tsx transpiles via esbuild;
 * a malformed file rejects). Resets the test registry before+after to mirror
 * runTest's own handling and not leak registrations.
 */
export async function checkTestFileParses(userId: number, moduleName: string): Promise<{ ok: boolean; error?: string }> {
  const testPath = join(GENERATED_DIR, String(userId), moduleName, 'test.ts');
  if (!existsSync(testPath)) return { ok: true };
  resetTests();
  try {
    await import(pathToFileURL(testPath).href + `?syntax=${Date.now()}`);
    return { ok: true };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // esbuild puts the useful bit ("...test.ts:140:3: ERROR: Unexpected end of file")
    // on a line after the "Transform failed" header — surface that line if present.
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const detail = lines.find(l => /ERROR:/.test(l)) ?? lines[0] ?? raw;
    return { ok: false, error: detail.replace(/^.*test\.ts:/, 'test.ts:') };
  } finally {
    resetTests();
  }
}
