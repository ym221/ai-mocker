/**
 * 模块文件样例库 — 由 get_module_template Agent 工具按需拉取。
 *
 * 目的:
 *   把大块样例(~8KB)从 system-prompt 移出,只在 AI 需要时按 kind 读。
 *   system-prompt 里只留一行指引"若需完整示例,调 get_module_template(kind)"。
 *
 * 当前提供:
 *   - 'crud-basic' — 最小可跑 todo 模块 5 文件(_meta / schema.sql / controller / test / api-doc)
 *   - 'with-constraints' — 带 _meta.json 字段约束 + 跨字段 constraints 的进阶样例
 */

export type TemplateKind = 'crud-basic' | 'with-constraints';

const CRUD_BASIC = `# 完整模块样例(kind=crud-basic)

假设模块名 todo,表名 mock__todo。以下 5 个文件用 write_files 一次性落盘即可。

## 1. todo/_meta.json
\`\`\`json
{
  "name": "todo",
  "displayName": "待办事项",
  "description": "简单的待办管理",
  "basePath": "/mock/todo",
  "version": 1,
  "status": "active",
  "entities": [{
    "name": "todo",
    "tableName": "mock__todo",
    "displayName": "待办",
    "fields": [
      { "name": "title", "type": "string", "displayName": "标题", "required": true },
      { "name": "done", "type": "boolean", "displayName": "完成", "required": false, "default": false }
    ]
  }],
  "endpoints": [
    { "method": "GET", "path": "/", "name": "列表", "type": "list" },
    { "method": "GET", "path": "/:id", "name": "详情", "type": "detail" },
    { "method": "POST", "path": "/", "name": "创建", "type": "create" },
    { "method": "PUT", "path": "/:id", "name": "更新", "type": "update" },
    { "method": "DELETE", "path": "/:id", "name": "删除", "type": "delete" }
  ],
  "config": { "delay": { "min": 0, "max": 0 }, "errorRate": 0 }
}
\`\`\`

endpoints.type 枚举: list/detail/create/update/delete/custom。path 不要加模块名前缀。

## 2. todo/schema.sql
\`\`\`sql
CREATE TABLE IF NOT EXISTS \`mock__todo\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`title\` TEXT NOT NULL,
  \`done\` INTEGER DEFAULT 0
);

-- 种子数据(若 spec 要求"种子 N 条" / "seed M rows" 必须写,否则 GET list 返空数组用户必报错)
INSERT OR IGNORE INTO \`mock__todo\` (id, title, done) VALUES
  (1, '示例任务1', 0),
  (2, '示例任务2', 1),
  (3, '示例任务3', 0);
\`\`\`

表名 === \`mock__\${entity.name}\`,系统 exec 时自动注入 userId 前缀。

**关键:种子数据写在 schema.sql 末尾**(用 \`INSERT OR IGNORE\`),不要等到所有文件写完后再去调 manage_data 补 — 那样多耗 5 个 LLM round-trip。schema.sql 是唯一在写盘时自动执行的文件,seed 写在它里面是最快、最稳的路径。

**时间戳字段(可选,框架不要求)**:用户需求里若提到创建/更新时间,自己加列,如
\`created_at TEXT DEFAULT (datetime('now'))\`、\`updated_at TEXT DEFAULT (datetime('now'))\`。
没提就不加。NOT NULL 必带 DEFAULT。

## 3. todo/controller.ts
必须命名导出 list/getById/create/update/remove,禁 default export。每个 handler 签名 \`async (req) => ...\`,其中 \`req = { body, query, params }\`。用 \`.withMeta('todo')\` 自动接 _meta.json 约束。

\`\`\`ts
import { BaseModel, ValidationError } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';

const model = new BaseModel('mock__todo').withMeta('todo');

function asValidationFail(e: unknown) {
  if (e instanceof ValidationError) {
    return { success: false, message: e.message, statusCode: 400 };
  }
  throw e;
}

export const list = async (req) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 20;
  const where: Record<string, unknown> = {};
  if (req.query.done !== undefined) where.done = req.query.done === 'true' ? 1 : 0;
  const result = model.findAll({ page, pageSize, where });
  return paginated(result.list, result.total, result.page, result.pageSize);
};

export const getById = async (req) => {
  const item = model.findById(Number(req.params.id));
  if (!item) return { success: false, message: '记录不存在', statusCode: 404 };
  return success(item);
};

export const create = async (req) => {
  try { return success(model.create(req.body), '创建成功'); }
  catch (e) { return asValidationFail(e); }
};

export const update = async (req) => {
  const id = Number(req.params.id);
  const existing = model.findById(id);
  if (!existing) return { success: false, message: '记录不存在', statusCode: 404 };
  try { return success(model.update(id, req.body), '更新成功'); }
  catch (e) { return asValidationFail(e); }
};

export const remove = async (req) => {
  const deleted = model.delete(Number(req.params.id));
  if (!deleted) return { success: false, message: '记录不存在', statusCode: 404 };
  return success(null, '删除成功');
};
\`\`\`

## 4. todo/test.ts
必须 import 自 \`@core/test-runner.js\`。不要 describe/expect/chai/jest。

\`\`\`ts
import { test, assert, request } from '@core/test-runner.js';

test('创建待办', async (ctx) => {
  const res = await request.post('/mock/todo', { title: '测试', done: false });
  assert.eq(res.status, 200);
  assert.ok(res.body.success);
  return res.body.data.id;
});

test('获取列表', async () => {
  const res = await request.get('/mock/todo');
  assert.eq(res.status, 200);
  assert.ok(res.body.data.list.length > 0);
});

test('获取详情', async (ctx) => {
  const res = await request.get(\`/mock/todo/\${ctx.lastId}\`);
  assert.eq(res.status, 200);
  assert.exists(res.body.data);
});

test('更新', async (ctx) => {
  const res = await request.put(\`/mock/todo/\${ctx.lastId}\`, { done: true });
  assert.eq(res.status, 200);
});

test('删除', async (ctx) => {
  const res = await request.delete(\`/mock/todo/\${ctx.lastId}\`);
  assert.eq(res.status, 200);
});
\`\`\`

## 5. todo/api-doc.md
- 每个接口列出: method/path/请求参数/Body/响应 JSON 示例 + 字段说明
- 不要 cURL 示例,不要 bash
- 响应示例必须采用本模块实际响应信封
- 字段说明用表格: | 字段 | 类型 | 说明 |

## 6. todo/_context.md(简短,<500 字)
\`\`\`md
# todo 模块
字段: title(必填), done(布尔)
接口: /mock/todo GET列表/POST创建, /mock/todo/:id GET详情/PUT更新/DELETE删除
\`\`\`
`;

const WITH_CONSTRAINTS = `# 带约束的模块样例(kind=with-constraints)

基于 crud-basic,演示如何在 _meta.json 里表达单字段约束 + 跨字段规则。
示例:库存管理模块 warehouse,字段 qty / status,规则"qty=0 时 status 必须 out_of_stock"。

## 关键差异:_meta.json 的 entities[0] 里带字段约束 + entity.constraints[]

\`\`\`json
{
  "name": "warehouse",
  "displayName": "库存",
  "basePath": "/mock/warehouse",
  "version": 1,
  "status": "active",
  "entities": [{
    "name": "warehouse",
    "tableName": "mock__warehouse",
    "displayName": "库存项",
    "fields": [
      { "name": "sku", "type": "string", "displayName": "SKU", "required": true,
        "pattern": "^[A-Z0-9-]+$", "minLength": 3, "maxLength": 32, "unique": true },
      { "name": "qty", "type": "integer", "displayName": "数量", "required": true,
        "min": 0, "max": 100000 },
      { "name": "status", "type": "string", "displayName": "状态", "required": true,
        "enum": ["in_stock", "low_stock", "out_of_stock"] }
    ],
    "constraints": [
      { "id": "qty-zero-outofstock",
        "when": { "qty": 0 }, "must": { "status": "out_of_stock" },
        "message": "qty=0 时 status 必须为 out_of_stock" },
      { "id": "qty-low-lowstock",
        "when": { "qty": { "gt": 0, "lte": 10 } }, "must": { "status": "low_stock" },
        "message": "qty ∈ (0, 10] 时必须 low_stock" }
    ]
  }],
  "endpoints": [
    { "method": "GET", "path": "/", "name": "列表", "type": "list" },
    { "method": "POST", "path": "/", "name": "创建", "type": "create" },
    { "method": "PUT", "path": "/:id", "name": "更新", "type": "update" }
  ],
  "config": { "delay": { "min": 0, "max": 0 }, "errorRate": 0 }
}
\`\`\`

## controller.ts 完全复用 crud-basic 模板

\`new BaseModel('mock__warehouse').withMeta('warehouse')\` 会把上面所有约束接入 create/update,违反即抛 ValidationError,controller 统一 catch 转 400。

\`\`\`ts
const model = new BaseModel('mock__warehouse').withMeta('warehouse');
// create/update 里 try/catch,不手写 if-throw 校验
\`\`\`

## 约束表达优先级(重申)

| 约束 | 写在哪 |
|------|-------|
| 必填 / 枚举 / 范围 / 长度 / 正则 / 唯一 | _meta.json field |
| 跨字段 | _meta.json entity.constraints[] |
| 状态机 / 外键级联 / 复杂流转 | controller.ts 手写 |

**禁止**在 controller.ts 手写单字段 / 跨字段 if-throw 校验(会导致 OpenAPI 看不到约束,diff_with_openapi 对账失效)。
`;

const TEMPLATES: Record<TemplateKind, string> = {
  'crud-basic': CRUD_BASIC,
  'with-constraints': WITH_CONSTRAINTS,
};

export function getModuleTemplate(kind: TemplateKind): string {
  return TEMPLATES[kind];
}

export function listTemplateKinds(): TemplateKind[] {
  return Object.keys(TEMPLATES) as TemplateKind[];
}
