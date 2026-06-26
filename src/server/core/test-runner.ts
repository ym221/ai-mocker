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
async function doRequest(method: string, path: string, data?: unknown) {
  const init: RequestInit = { method: method.toUpperCase() };
  // Only advertise a JSON body when there is one. Sending `Content-Type:
  // application/json` with an empty body makes the server reject the request
  // before the handler runs — body-less action endpoints (pay/ship/...) must work.
  if (data !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(data);
  }
  const res = await fetch(`${BASE_URL}${path}`, init);
  const body = await res.json();
  return { status: res.status, body };
}

/**
 * Callable request supporting both conventions models naturally emit:
 *   request.post(path, data) / request.get(path)            — object style
 *   request('POST', path, data) / request('GET', path)      — (method, path, data)
 *   request(path) / request(path, data)                     — bare path defaults to GET
 * Plus .get/.post/.put/.patch/.delete/.del method aliases.
 */
type ReqResult = Promise<{ status: number; body: any }>;
interface UploadOpts {
  /** form field name for the file (default 'img'). */
  field?: string;
  /** file name (default 'upload.bin'). */
  filename?: string;
  /** file content — string or binary (default a small placeholder). */
  content?: string | Uint8Array | ArrayBuffer;
  /** MIME type (default 'application/octet-stream'). */
  contentType?: string;
  /** extra non-file form fields. */
  fields?: Record<string, string | number | boolean>;
}
interface RequestFn {
  (methodOrPath: string, pathOrData?: unknown, data?: unknown): ReqResult;
  get(path: string): ReqResult;
  post(path: string, data?: unknown): ReqResult;
  put(path: string, data?: unknown): ReqResult;
  patch(path: string, data?: unknown): ReqResult;
  delete(path: string): ReqResult;
  del(path: string): ReqResult;
  /** multipart/form-data upload — for endpoints that accept a file. Returns the JSON envelope. */
  upload(path: string, opts?: UploadOpts): ReqResult;
  /** GET a (possibly absolute) URL as raw bytes — use to assert an uploaded file is fetchable. */
  getFile(url: string): Promise<{ status: number; contentType: string | null; size: number; text: string }>;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const request = ((arg1: string, arg2?: unknown, arg3?: unknown) => {
  // request('POST', '/path', body) — first arg is an HTTP method
  if (typeof arg1 === 'string' && HTTP_METHODS.has(arg1.toUpperCase()) && typeof arg2 === 'string') {
    return doRequest(arg1, arg2, arg3);
  }
  // request('/path') or request('/path', body) — bare path defaults to GET (body → POST)
  return doRequest(arg2 === undefined ? 'GET' : 'POST', arg1, arg2);
}) as RequestFn;

request.get = (path: string) => doRequest('GET', path);
request.post = (path: string, data?: unknown) => doRequest('POST', path, data);
request.put = (path: string, data?: unknown) => doRequest('PUT', path, data);
request.patch = (path: string, data?: unknown) => doRequest('PATCH', path, data);
request.delete = (path: string) => doRequest('DELETE', path);
// del 别名(部分模型生成 test.ts 时习惯写 request.del,跟 axios/got 类库一致)
request.del = request.delete;

request.upload = async (path: string, opts: UploadOpts = {}) => {
  const form = new FormData();
  const field = opts.field || 'img';
  const filename = opts.filename || 'upload.bin';
  const content = opts.content ?? `mock-upload-${Date.now()}`;
  const blob = new Blob([content as BlobPart], { type: opts.contentType || 'application/octet-stream' });
  form.append(field, blob, filename);
  for (const [k, v] of Object.entries(opts.fields || {})) form.append(k, String(v));
  // Let fetch set the multipart boundary Content-Type itself — do NOT set it manually.
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', body: form });
  const body = await res.json();
  return { status: res.status, body };
};

request.getFile = async (url: string) => {
  const full = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  const res = await fetch(full);
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type'), size: text.length, text };
};

export { request };
