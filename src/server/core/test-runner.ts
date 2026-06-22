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

/** Assertion utilities — Step-Workflow-1:加 jest/chai 风格别名,让 AI 各种自然
 *  写法(truthy/equal/notEqual/deepEqual)都能跑通,而不是卡在 "assert.truthy is
 *  not a function" 这种纯命名层的报错上 */
const _ok = (value: unknown, message?: string) => {
  if (!value) throw new Error(message || `Expected truthy, got ${JSON.stringify(value)}`);
};
const _not = (value: unknown, message?: string) => {
  if (value) throw new Error(message || `Expected falsy, got ${JSON.stringify(value)}`);
};
const _eq = (actual: unknown, expected: unknown, message?: string) => {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};
const _notEq = (actual: unknown, expected: unknown, message?: string) => {
  if (actual === expected) {
    throw new Error(message || `Expected not equal to ${JSON.stringify(expected)}, but got the same`);
  }
};
const _exists = (value: unknown, message?: string) => {
  if (value === null || value === undefined) {
    throw new Error(message || `Expected non-null/undefined, got ${JSON.stringify(value)}`);
  }
};
const _deepEq = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Expected deep-equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

export const assert = {
  ok: _ok, truthy: _ok, true: _ok, isTrue: _ok,
  not: _not, falsy: _not, false: _not, isFalse: _not,
  eq: _eq, equal: _eq, equals: _eq, strictEqual: _eq,
  notEq: _notEq, notEqual: _notEq,
  exists: _exists, defined: _exists, notNull: _exists,
  deepEqual: _deepEq, deepEq: _deepEq,
};

/** HTTP request utilities */
export const request = {
  async get(path: string) {
    const res = await fetch(`${BASE_URL}${path}`);
    const body = await res.json();
    return { status: res.status, body };
  },
  async post(path: string, data?: unknown) {
    // Only advertise a JSON body when there is one. Sending `Content-Type:
    // application/json` with an empty body makes the server reject the request
    // before the handler runs — body-less action endpoints (pay/ship/...) must work.
    const init: RequestInit = { method: 'POST' };
    if (data !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(data);
    }
    const res = await fetch(`${BASE_URL}${path}`, init);
    const body = await res.json();
    return { status: res.status, body };
  },
  async put(path: string, data?: unknown) {
    const init: RequestInit = { method: 'PUT' };
    if (data !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(data);
    }
    const res = await fetch(`${BASE_URL}${path}`, init);
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
