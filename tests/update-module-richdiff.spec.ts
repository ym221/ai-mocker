/**
 * update_module 富 diff 单元测试 (snapshotMeta + diffSnapshots)。
 *
 * 起因: 旧版只识别 entity/field/endpoint 增删,改了 controller / 加了 test
 * 用例 / 加了跨字段约束都返回 "no structural diff detected",AI 误判改了等于没改。
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import {
  snapshotMeta, diffSnapshots,
  extractTestNames, countErrorBranches, constraintFingerprint,
} from '../src/server/mcp/lib/update-diff';

const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;
const MODULE = 'rd_test';

function setupModule(opts: {
  fields?: Array<{ name: string; type: string; required?: boolean; enum?: string[] }>;
  constraints?: Array<{ id?: string; when: any; must: any; message: string }>;
  endpoints?: Array<{ method: string; path: string; type: string; name?: string }>;
  testCode?: string;
  controllerCode?: string;
  apiDocLines?: number;
}) {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const meta = {
    name: MODULE,
    displayName: 'RD',
    basePath: `/mock/${MODULE}`,
    version: 1,
    entities: [{
      name: 'item',
      tableName: `mock__${MODULE}`,
      fields: opts.fields ?? [{ name: 'name', type: 'string', required: true }],
      constraints: opts.constraints ?? [],
    }],
    endpoints: opts.endpoints ?? [
      { method: 'GET', path: '/', name: '列表', type: 'list' },
      { method: 'POST', path: '/', name: '创建', type: 'create' },
    ],
    config: { delay: { min: 0, max: 0 }, errorRate: 0 },
  };
  writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  writeFileSync(join(dir, 'controller.ts'), opts.controllerCode ?? `import { BaseModel } from '@core/base-model.js';\nimport { success } from '@core/response.js';\nconst m = new BaseModel('mock__${MODULE}');\nexport function create(b) { return success(m.create(b)); }\n`, 'utf-8');
  writeFileSync(join(dir, 'test.ts'), opts.testCode ?? `import { test, assert } from '@core/test-runner.js';\ntest('baseline', async () => { assert.ok(true); });\n`, 'utf-8');
  const docLines = opts.apiDocLines ?? 3;
  writeFileSync(join(dir, 'api-doc.md'), '# doc\n'.repeat(docLines), 'utf-8');
  writeFileSync(join(dir, 'schema.sql'), `CREATE TABLE \`mock__${MODULE}\` (\`id\` INTEGER PRIMARY KEY);`, 'utf-8');
  writeFileSync(join(dir, '_context.md'), `# ${MODULE}`, 'utf-8');
}

function cleanup() {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (existsSync(dir)) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test.afterEach(() => cleanup());

test.describe('update-diff: extractTestNames', () => {
  test('RD01 提取 test(\'name\') 单引号', () => {
    const names = extractTestNames(`test('foo', async () => {});\ntest('bar baz', async () => {});`);
    expect([...names]).toEqual(['foo', 'bar baz']);
  });
  test('RD02 提取 test("name") 双引号', () => {
    const names = extractTestNames(`test("a"); test("b");`);
    expect([...names]).toEqual(['a', 'b']);
  });
  test('RD03 没 test 调用 → 空集合', () => {
    expect([...extractTestNames(`function noop() { return 1; }`)]).toEqual([]);
  });
});

test.describe('update-diff: countErrorBranches', () => {
  test('RD04 统计 success:false / statusCode:4xx / throw Error', () => {
    const src = `
      return { success: false, message: 'x' };
      return { success: false, statusCode: 404 };
      throw new ValidationError('y');
      return success(item);
    `;
    expect(countErrorBranches(src)).toBeGreaterThanOrEqual(3);
  });
});

test.describe('update-diff: constraintFingerprint', () => {
  test('RD05 有 id 用 id', () => {
    expect(constraintFingerprint({ id: 'qty-zero', when: {}, must: {} })).toBe('qty-zero');
  });
  test('RD06 无 id 用 when=>must JSON', () => {
    const fp = constraintFingerprint({ when: { qty: 0 }, must: { status: 'a' } });
    expect(fp).toBe('{"qty":0}=>{"status":"a"}');
  });
});

test.describe('update-diff: diffSnapshots e2e', () => {
  test('RD07 加字段 → +field', () => {
    setupModule({ fields: [{ name: 'name', type: 'string' }] });
    const before = snapshotMeta(USER_ID, MODULE);
    setupModule({ fields: [{ name: 'name', type: 'string' }, { name: 'sku', type: 'string', required: true }] });
    const after = snapshotMeta(USER_ID, MODULE);
    const d = diffSnapshots(before, after);
    expect(d.lines).toContain('+field item.sku');
    expect(d.hasChange).toBe(true);
  });

  test('RD08 加端点 → +endpoint', () => {
    setupModule({});
    const before = snapshotMeta(USER_ID, MODULE);
    setupModule({
      endpoints: [
        { method: 'GET', path: '/', name: '列表', type: 'list' },
        { method: 'POST', path: '/', name: '创建', type: 'create' },
        { method: 'PUT', path: '/:id', name: '更新', type: 'update' },
      ],
    });
    const after = snapshotMeta(USER_ID, MODULE);
    const d = diffSnapshots(before, after);
    expect(d.lines).toContain('+endpoint PUT /:id');
  });

  test('RD09 加 entity.constraints → +constraint <id>', () => {
    setupModule({});
    const before = snapshotMeta(USER_ID, MODULE);
    setupModule({
      constraints: [
        { id: 'qty-zero', when: { qty: 0 }, must: { status: 'out_of_stock' }, message: 'x' },
      ],
    });
    const after = snapshotMeta(USER_ID, MODULE);
    const d = diffSnapshots(before, after);
    expect(d.lines).toContain('+constraint qty-zero');
  });

  test('RD10 加 test 用例 → +test "..."', () => {
    setupModule({ testCode: `import { test, assert } from '@core/test-runner.js';\ntest('one', async () => { assert.ok(true); });\n` });
    const before = snapshotMeta(USER_ID, MODULE);
    setupModule({ testCode: `import { test, assert } from '@core/test-runner.js';\ntest('one', async () => { assert.ok(true); });\ntest('two', async () => { assert.ok(true); });\ntest('three', async () => { assert.ok(true); });\n` });
    const after = snapshotMeta(USER_ID, MODULE);
    const d = diffSnapshots(before, after);
    expect(d.lines).toContain('+test "two"');
    expect(d.lines).toContain('+test "three"');
  });

  test('RD11 controller 改动 → warnings 提示 (不计入 lines)', () => {
    setupModule({ controllerCode: `import { BaseModel } from '@core/base-model.js';\nconst m = new BaseModel('x');\nexport function create(b) { return m.create(b); }\n` });
    const before = snapshotMeta(USER_ID, MODULE);
    setupModule({ controllerCode: `import { BaseModel } from '@core/base-model.js';\nconst m = new BaseModel('x');\nexport function create(b) {\n  if (b.qty < 0) return { success: false, message: 'bad', statusCode: 400 };\n  return m.create(b);\n}\n` });
    const after = snapshotMeta(USER_ID, MODULE);
    const d = diffSnapshots(before, after);
    expect(d.warnings.find(w => w.includes('controller.ts changed'))).toBeTruthy();
    // 添加 1 行 if + statusCode → countErrorBranches 上升
    expect(d.warnings.find(w => /error-branches \+[1-9]/.test(w))).toBeTruthy();
  });

  test('RD12 api-doc 行数变化 → warnings', () => {
    setupModule({ apiDocLines: 3 });
    const before = snapshotMeta(USER_ID, MODULE);
    setupModule({ apiDocLines: 15 });
    const after = snapshotMeta(USER_ID, MODULE);
    const d = diffSnapshots(before, after);
    expect(d.warnings.find(w => w.includes('api-doc.md +12'))).toBeTruthy();
  });

  test('RD13 完全没变 → hasChange=false + 显式 warning 提醒 AI', () => {
    setupModule({});
    const before = snapshotMeta(USER_ID, MODULE);
    const after = snapshotMeta(USER_ID, MODULE);
    const d = diffSnapshots(before, after);
    expect(d.hasChange).toBe(false);
    expect(d.lines).toEqual([]);
    expect(d.warnings.find(w => w.includes('AI claimed change but no'))).toBeTruthy();
  });

  test('RD14 同时改 entity + constraint + test → 全部出现在 lines', () => {
    setupModule({});
    const before = snapshotMeta(USER_ID, MODULE);
    setupModule({
      fields: [
        { name: 'name', type: 'string', required: true },
        { name: 'qty', type: 'integer' },
        { name: 'status', type: 'string' },
      ],
      constraints: [
        { id: 'qty-zero', when: { qty: 0 }, must: { status: 'out_of_stock' }, message: 'x' },
      ],
      testCode: `import { test, assert } from '@core/test-runner.js';\ntest('baseline', async () => { assert.ok(true); });\ntest('quantity zero ↔ out_of_stock', async () => { assert.ok(true); });\n`,
    });
    const after = snapshotMeta(USER_ID, MODULE);
    const d = diffSnapshots(before, after);
    expect(d.lines).toContain('+field item.qty');
    expect(d.lines).toContain('+field item.status');
    expect(d.lines).toContain('+constraint qty-zero');
    expect(d.lines).toContain('+test "quantity zero ↔ out_of_stock"');
    expect(d.hasChange).toBe(true);
  });
});
