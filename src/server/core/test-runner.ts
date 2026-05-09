const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

interface TestCase {
  name: string;
  fn: (ctx: TestContext) => Promise<unknown>;
}

interface TestContext {
  lastId?: unknown;
  [key: string]: unknown;
}

interface TestResult {
  passed: number;
  total: number;
  failures: { name: string; error: string }[];
}

const testCases: TestCase[] = [];

/** Register a test case */
export function test(name: string, fn: (ctx: TestContext) => Promise<unknown>) {
  testCases.push({ name, fn });
}

/** Reset registered tests (called before each run) */
export function resetTests() {
  testCases.length = 0;
}

/** Run all registered tests sequentially */
export async function runAllTests(): Promise<TestResult> {
  const ctx: TestContext = {};
  const failures: { name: string; error: string }[] = [];
  let passed = 0;

  for (const tc of testCases) {
    try {
      const result = await tc.fn(ctx);
      if (result !== undefined) {
        ctx.lastId = result;
      }
      passed++;
    } catch (err) {
      failures.push({
        name: tc.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { passed, total: testCases.length, failures };
}

/** Assertion utilities */
export const assert = {
  ok(value: unknown, message?: string) {
    if (!value) throw new Error(message || `Expected truthy, got ${JSON.stringify(value)}`);
  },
  not(value: unknown, message?: string) {
    if (value) throw new Error(message || `Expected falsy, got ${JSON.stringify(value)}`);
  },
  eq(actual: unknown, expected: unknown, message?: string) {
    if (actual !== expected) {
      throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  exists(value: unknown, message?: string) {
    if (value === null || value === undefined) {
      throw new Error(message || `Expected non-null/undefined, got ${JSON.stringify(value)}`);
    }
  },
};

/** HTTP request utilities */
export const request = {
  async get(path: string) {
    const res = await fetch(`${BASE_URL}${path}`);
    const body = await res.json();
    return { status: res.status, body };
  },
  async post(path: string, data?: unknown) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
    const body = await res.json();
    return { status: res.status, body };
  },
  async put(path: string, data?: unknown) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
    const body = await res.json();
    return { status: res.status, body };
  },
  async delete(path: string) {
    const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
    const body = await res.json();
    return { status: res.status, body };
  },
};

// del 别名(部分模型生成 test.ts 时习惯写 request.del,跟 axios/got 类库一致)
(request as Record<string, unknown>).del = (request as Record<string, (path: string) => unknown>).delete;
