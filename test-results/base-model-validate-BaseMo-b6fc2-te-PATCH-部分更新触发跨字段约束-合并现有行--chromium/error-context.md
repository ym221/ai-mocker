# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: base-model-validate.spec.ts >> BaseModel.withMeta() 自动校验 + controller 转 400 >> B07 update PATCH 部分更新触发跨字段约束 (合并现有行)
- Location: tests\base-model-validate.spec.ts:202:3

# Error details

```
SqliteError: disk I/O error
```

# Test source

```ts
  32  |         { name: 'sku', type: 'string', required: true, displayName: 'SKU', unique: true },
  33  |         { name: 'qty', type: 'integer', required: true, min: 0, max: 1000, displayName: '数量' },
  34  |         { name: 'status', type: 'string', enum: ['in_stock', 'out_of_stock'], default: 'in_stock', displayName: '状态' },
  35  |       ],
  36  |       constraints: [{
  37  |         id: 'qty-zero',
  38  |         when: { qty: 0 },
  39  |         must: { status: 'out_of_stock' },
  40  |         message: '数量为 0 时,状态必须为 out_of_stock',
  41  |       }],
  42  |     }],
  43  |     endpoints: [
  44  |       { method: 'GET', path: '/', name: '列表', type: 'list' },
  45  |       { method: 'GET', path: '/:id', name: '详情', type: 'detail' },
  46  |       { method: 'POST', path: '/', name: '创建', type: 'create' },
  47  |       { method: 'PUT', path: '/:id', name: '更新', type: 'update' },
  48  |       { method: 'DELETE', path: '/:id', name: '删除', type: 'delete' },
  49  |     ],
  50  |     config: { delay: { min: 0, max: 0 }, errorRate: 0 },
  51  |   };
  52  |   writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  53  | 
  54  |   writeFileSync(join(dir, 'schema.sql'), `CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
  55  |   \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  56  |   \`sku\` TEXT NOT NULL,
  57  |   \`qty\` INTEGER NOT NULL,
  58  |   \`status\` TEXT,
  59  |   \`created_at\` TEXT DEFAULT (datetime('now')),
  60  |   \`updated_at\` TEXT DEFAULT (datetime('now'))
  61  | );`, 'utf-8');
  62  | 
  63  |   // Controller uses .withMeta() so BaseModel auto-validates
  64  |   writeFileSync(join(dir, 'controller.ts'), `import { BaseModel, ValidationError } from '@core/base-model.js';
  65  | import { success, paginated } from '@core/response.js';
  66  | const model = new BaseModel('mock__${MODULE}').withMeta('${MODULE}');
  67  | 
  68  | function asValidationFail(e: unknown) {
  69  |   if (e instanceof ValidationError) {
  70  |     return { success: false, message: e.message, statusCode: 400 };
  71  |   }
  72  |   throw e;
  73  | }
  74  | 
  75  | export function list(query: Record<string, string>) {
  76  |   const page = Number(query.page) || 1;
  77  |   const pageSize = Number(query.pageSize) || 20;
  78  |   const r = model.findAll({ page, pageSize });
  79  |   return paginated(r.list, r.total, r.page, r.pageSize);
  80  | }
  81  | export function getById(id: string) {
  82  |   const item = model.findById(Number(id));
  83  |   if (!item) return { success: false, message: '记录不存在', statusCode: 404 };
  84  |   return success(item);
  85  | }
  86  | export function create(body: Record<string, unknown>) {
  87  |   try { return success(model.create(body), '创建成功'); }
  88  |   catch (e) { return asValidationFail(e); }
  89  | }
  90  | export function update(id: string, body: Record<string, unknown>) {
  91  |   const existing = model.findById(Number(id));
  92  |   if (!existing) return { success: false, message: '记录不存在', statusCode: 404 };
  93  |   try { return success(model.update(Number(id), body), '更新成功'); }
  94  |   catch (e) { return asValidationFail(e); }
  95  | }
  96  | export function remove(id: string) {
  97  |   const deleted = model.delete(Number(id));
  98  |   if (!deleted) return { success: false, message: '记录不存在', statusCode: 404 };
  99  |   return success(null, '删除成功');
  100 | }
  101 | `, 'utf-8');
  102 | 
  103 |   writeFileSync(join(dir, 'test.ts'), `import { test, assert } from '@core/test-runner.js';\ntest('n', async () => { assert.ok(true); });\n`, 'utf-8');
  104 |   writeFileSync(join(dir, '_context.md'), `# ${MODULE}`, 'utf-8');
  105 |   writeFileSync(join(dir, 'api-doc.md'), `# ${MODULE} API`, 'utf-8');
  106 | 
  107 |   const db = new Database(DB_PATH);
  108 |   try {
  109 |     db.pragma('journal_mode = WAL');
  110 |     db.exec(`CREATE TABLE IF NOT EXISTS \`mock__${USER_ID}_${MODULE}\` (
  111 |       \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  112 |       \`sku\` TEXT NOT NULL,
  113 |       \`qty\` INTEGER NOT NULL,
  114 |       \`status\` TEXT,
  115 |       \`created_at\` TEXT DEFAULT (datetime('now')),
  116 |       \`updated_at\` TEXT DEFAULT (datetime('now'))
  117 |     );`);
  118 |     db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
  119 |     db.prepare(`INSERT INTO modules (name, user_id, display_name, description, base_path, status)
  120 |        VALUES (?, ?, ?, ?, ?, 'active')`
  121 |     ).run(MODULE, USER_ID, 'BM Validate', 'test', `/mock/${MODULE}`);
  122 |     // Clear table data
  123 |     db.prepare(`DELETE FROM \`mock__${USER_ID}_${MODULE}\``).run();
  124 |   } finally { db.close(); }
  125 | }
  126 | 
  127 | function cleanup() {
  128 |   const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  129 |   if (existsSync(dir)) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  130 |   const db = new Database(DB_PATH);
  131 |   try {
> 132 |     db.exec(`DROP TABLE IF EXISTS \`mock__${USER_ID}_${MODULE}\``);
      |        ^ SqliteError: disk I/O error
  133 |     db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
  134 |   } finally { db.close(); }
  135 | }
  136 | 
  137 | test.beforeAll(async () => { await waitForBackend(); });
  138 | test.beforeEach(() => { cleanup(); setupModuleWithConstraints(); });
  139 | test.afterAll(() => cleanup());
  140 | 
  141 | const API = 'http://localhost:3000';
  142 | 
  143 | async function postMock(body: unknown) {
  144 |   const res = await fetch(`${API}/mock/${MODULE}`, {
  145 |     method: 'POST',
  146 |     headers: { 'Content-Type': 'application/json' },
  147 |     body: JSON.stringify(body),
  148 |   });
  149 |   return { status: res.status, body: await res.json() };
  150 | }
  151 | 
  152 | async function putMock(id: number, body: unknown) {
  153 |   const res = await fetch(`${API}/mock/${MODULE}/${id}`, {
  154 |     method: 'PUT',
  155 |     headers: { 'Content-Type': 'application/json' },
  156 |     body: JSON.stringify(body),
  157 |   });
  158 |   return { status: res.status, body: await res.json() };
  159 | }
  160 | 
  161 | test.describe('BaseModel.withMeta() 自动校验 + controller 转 400', () => {
  162 |   test('B01 缺 required 字段 → 400 + 中文 message', async () => {
  163 |     const r = await postMock({ qty: 5 });
  164 |     expect(r.status).toBe(400);
  165 |     expect(r.body.success).toBe(false);
  166 |     expect(r.body.message).toMatch(/SKU是必填项/);
  167 |   });
  168 | 
  169 |   test('B02 enum 越界 → 400', async () => {
  170 |     const r = await postMock({ sku: 'A1', qty: 5, status: 'unknown' });
  171 |     expect(r.status).toBe(400);
  172 |     expect(r.body.message).toMatch(/状态.*必须是.*in_stock.*out_of_stock/);
  173 |   });
  174 | 
  175 |   test('B03 数值 min 越界 → 400', async () => {
  176 |     const r = await postMock({ sku: 'A2', qty: -1 });
  177 |     expect(r.status).toBe(400);
  178 |     expect(r.body.message).toMatch(/数量不能小于 0/);
  179 |   });
  180 | 
  181 |   test('B04 跨字段 qty=0 ↔ status=out_of_stock 违反 → 400', async () => {
  182 |     const r = await postMock({ sku: 'A3', qty: 0, status: 'in_stock' });
  183 |     expect(r.status).toBe(400);
  184 |     expect(r.body.message).toMatch(/数量为 0 时.*out_of_stock/);
  185 |   });
  186 | 
  187 |   test('B05 跨字段满足 + 字段全合法 → 200 创建成功', async () => {
  188 |     const r = await postMock({ sku: 'A4', qty: 0, status: 'out_of_stock' });
  189 |     expect(r.status).toBe(200);
  190 |     expect(r.body.success).toBe(true);
  191 |     expect(r.body.data.sku).toBe('A4');
  192 |   });
  193 | 
  194 |   test('B06 unique 字段重复 → 400', async () => {
  195 |     const r1 = await postMock({ sku: 'DUP', qty: 5, status: 'in_stock' });
  196 |     expect(r1.status).toBe(200);
  197 |     const r2 = await postMock({ sku: 'DUP', qty: 5, status: 'in_stock' });
  198 |     expect(r2.status).toBe(400);
  199 |     expect(r2.body.message).toMatch(/SKU已存在/);
  200 |   });
  201 | 
  202 |   test('B07 update PATCH 部分更新触发跨字段约束 (合并现有行)', async () => {
  203 |     const created = await postMock({ sku: 'B7', qty: 5, status: 'in_stock' });
  204 |     expect(created.status).toBe(200);
  205 |     const id = created.body.data.id as number;
  206 |     // 仅 PATCH qty=0 (没传 status), 与现有 status=in_stock 合并 → 触发跨字段
  207 |     const r = await putMock(id, { qty: 0 });
  208 |     expect(r.status).toBe(400);
  209 |     expect(r.body.message).toMatch(/数量为 0 时.*out_of_stock/);
  210 |     // 同时改 status 则通过
  211 |     const r2 = await putMock(id, { qty: 0, status: 'out_of_stock' });
  212 |     expect(r2.status).toBe(200);
  213 |   });
  214 | 
  215 |   test('B08 老模块 (无 .withMeta()) 不受影响 — back-compat', async () => {
  216 |     // 写一个没 withMeta 的 controller 覆盖,验证 BaseModel 不会强制校验
  217 |     const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  218 |     writeFileSync(join(dir, 'controller.ts'), `import { BaseModel } from '@core/base-model.js';
  219 | import { success, paginated } from '@core/response.js';
  220 | const model = new BaseModel('mock__${MODULE}');  // 无 .withMeta() — 走旧路径
  221 | export function list(q: Record<string, string>) {
  222 |   const r = model.findAll({ page: 1, pageSize: 20 });
  223 |   return paginated(r.list, r.total, r.page, r.pageSize);
  224 | }
  225 | export function getById(id: string) {
  226 |   const item = model.findById(Number(id));
  227 |   if (!item) return { success: false, message: '记录不存在' };
  228 |   return success(item);
  229 | }
  230 | export function create(b: Record<string, unknown>) { return success(model.create(b)); }
  231 | export function update(id: string, b: Record<string, unknown>) { return success(model.update(Number(id), b)); }
  232 | export function remove(id: string) { return success(null, model.delete(Number(id)) ? 'ok' : 'not found'); }
```