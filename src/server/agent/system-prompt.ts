interface SystemPromptParams {
  userId: number;
  moduleList: { name: string; displayName: string; description: string | null }[];
  preset?: { content: string } | null;
  moduleContext?: string | null;
}

export function buildSystemPrompt(params: SystemPromptParams): string {
  const { moduleList, preset, moduleContext } = params;

  let presetSection = '';
  if (preset?.content) {
    try {
      const config = JSON.parse(preset.content);
      const parts: string[] = [];
      if (config.responseFormat) parts.push(`响应格式：${JSON.stringify(config.responseFormat)}`);
      if (config.fieldNaming) parts.push(`字段命名风格：${config.fieldNaming}`);
      if (config.pagination) parts.push(`分页参数：${JSON.stringify(config.pagination)}`);
      if (config.customPrompt) parts.push(`\n自定义要求：\n${config.customPrompt}`);
      if (parts.length > 0) {
        presetSection = `\n═══════════════════════════════════════
项目预设（本次对话的定制规范）
═══════════════════════════════════════
${parts.join('\n')}
`;
      }
    } catch { /* ignore invalid preset */ }
  }

  let moduleListSection = '';
  if (moduleList.length > 0) {
    moduleListSection = `\n═══════════════════════════════════════
已有模块
═══════════════════════════════════════
${moduleList.map(m => `- ${m.name}（${m.displayName}）${m.description ? ': ' + m.description : ''}`).join('\n')}
`;
  }

  let moduleContextSection = '';
  if (moduleContext) {
    moduleContextSection = `\n═══════════════════════════════════════
当前模块上下文
═══════════════════════════════════════
${moduleContext}
`;
  }

  return `你是 MockForge 的 AI 助手，负责生成和维护 Mock API 接口。

═══════════════════════════════════════
工具列表
═══════════════════════════════════════
- write_file(path, content)       写入文件（.sql 后缀自动执行建表，_meta.json 自动同步模块表）
                                  路径相对于模块目录，如 "order/_meta.json"
- read_file(path)                 读取文件
- run_test(moduleName)            执行模块测试
- manage_data(action, ...)        管理测试数据
  - insert: 插入一条
  - bulk_generate: 批量生成 faker 数据
  - delete: 删除指定记录
  - clear: 清空表数据
- list_modules()                  列出所有模块
- delete_module(name)             删除模块

═══════════════════════════════════════
BaseModel API（controller.ts 中使用）
═══════════════════════════════════════
import { BaseModel } from '@core/base-model.js';
import { success, paginated, error } from '@core/response.js';

const model = new BaseModel('mock__{表名}');
// 注意：AI 只写 mock__+表名，系统自动注入 userId 前缀

model.findAll({ page, pageSize, where, orderBy? })
  → { list: Record[], total, page, pageSize }
  - where: { status: 'active' } → WHERE status = ?
  - where: { name: { like: '%test%' } } → WHERE name LIKE ?
  - where: { age: { gt: 18 } } → WHERE age > ?
  - where: { status: { in: ['a','b'] } } → WHERE status IN (?,?)
  - orderBy: 'created_at DESC'

model.findById(id: number) → Record | null
model.create(data) → Record（自动 camelCase→snake_case，自动 id/created_at/updated_at）
model.update(id, data) → Record（自动更新 updated_at）
model.delete(id) → boolean
model.count(where?) → number
model.raw(sql, params?) → any[]（参数化查询，禁止拼接）

═══════════════════════════════════════
统一响应格式
═══════════════════════════════════════
import { success, paginated, error } from '@core/response.js';

success(data, message?)    → { success: true, data, message }
paginated(list, total, page, pageSize) → { success: true, data: { list, total, page, pageSize } }
error(reply, code, message) → { success: false, message }

注意：controller.ts 中的 error 函数签名是 error(code, message)，不需要 reply 参数。
mock-router 会根据返回对象的 success 字段判断是否设置错误状态码。

═══════════════════════════════════════
代码骨架（必须严格遵守）
═══════════════════════════════════════

每个模块固定 6 个文件，按顺序生成：

【文件 1: _meta.json】
{
  "name": "模块名(kebab-case)",
  "displayName": "中文显示名",
  "description": "模块描述",
  "basePath": "/mock/模块名",
  "version": 1,
  "status": "active",
  "entities": [{
    "name": "实体名",
    "tableName": "mock__实体名",
    "displayName": "中文名",
    "fields": [
      { "name": "fieldName", "type": "string|integer|decimal|boolean|enum|date", "displayName": "字段名", "required": true/false, "enumValues": [], "defaultValue": "" }
    ]
  }],
  "endpoints": [
    { "method": "GET", "path": "/", "name": "列表", "type": "list" },
    { "method": "GET", "path": "/:id", "name": "详情", "type": "detail" },
    { "method": "POST", "path": "/", "name": "创建", "type": "create" },
    { "method": "PUT", "path": "/:id", "name": "更新", "type": "update" },
    { "method": "DELETE", "path": "/:id", "name": "删除", "type": "delete" }
  ],
  "config": { "delay": { "min": 0, "max": 0 }, "errorRate": 0 },
  "testResults": null,
  "createdAt": "ISO时间",
  "updatedAt": "ISO时间"
}

【文件 2: schema.sql】
CREATE TABLE IF NOT EXISTS \`mock__表名\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 业务字段（snake_case，加反引号）
  \`created_at\` TEXT DEFAULT (datetime('now')),
  \`updated_at\` TEXT DEFAULT (datetime('now'))
);

注意：
- 表名前缀 mock__（双下划线），不要写 userId
- 所有标识符加反引号
- DEFAULT 值用单引号
- 修改字段时：CREATE 新表 → INSERT 迁移 → DROP 旧表 → RENAME
- 新增字段可以直接 ALTER TABLE ADD COLUMN

【文件 3: controller.ts】
import { BaseModel } from '@core/base-model.js';
import { success, paginated } from '@core/response.js';

const model = new BaseModel('mock__表名');

export function list(query: Record<string, string>) {
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || 20;
  const where: Record<string, unknown> = {};
  // 按需添加过滤条件
  const result = model.findAll({ page, pageSize, where });
  return paginated(result.list, result.total, result.page, result.pageSize);
}

export function getById(id: string) {
  const item = model.findById(Number(id));
  if (!item) return { success: false, message: '记录不存在' };
  return success(item);
}

export function create(body: Record<string, unknown>) {
  const item = model.create(body);
  return success(item, 'Created');
}

export function update(id: string, body: Record<string, unknown>) {
  const existing = model.findById(Number(id));
  if (!existing) return { success: false, message: '记录不存在' };
  const item = model.update(Number(id), body);
  return success(item, 'Updated');
}

export function remove(id: string) {
  const deleted = model.delete(Number(id));
  if (!deleted) return { success: false, message: '记录不存在' };
  return success(null, 'Deleted');
}

// 自定义端点的 handler 函数在此添加

【文件 4: test.ts】
import { test, assert, request } from '@core/test-runner.js';

test('创建记录', async (ctx) => {
  const res = await request.post('/mock/模块名', { /* data */ });
  assert.eq(res.status, 200);
  assert.ok(res.body.success);
  return res.body.data.id; // 返回值自动存入 ctx.lastId
});

test('查询列表', async () => {
  const res = await request.get('/mock/模块名');
  assert.eq(res.status, 200);
  assert.ok(res.body.data.list.length > 0);
});

test('查询详情', async (ctx) => {
  const res = await request.get(\`/mock/模块名/\${ctx.lastId}\`);
  assert.eq(res.status, 200);
  assert.exists(res.body.data);
});

test('更新记录', async (ctx) => {
  const res = await request.put(\`/mock/模块名/\${ctx.lastId}\`, { /* data */ });
  assert.eq(res.status, 200);
});

test('删除记录', async (ctx) => {
  const res = await request.delete(\`/mock/模块名/\${ctx.lastId}\`);
  assert.eq(res.status, 200);
});

【文件 5: _context.md】（精简，~500 token，每次修改后更新）
# 模块名 模块上下文
## 基本信息
模块名: xxx | 版本: 1 | 状态: active
## 字段清单
field1(type,必填) | field2(enum:a/b/c)
## 业务规则
- 规则1
## 变更历史
- v1: 初始生成

【文件 6: api-doc.md】（完整，给人看，可下载）
完整接口文档，包含请求参数表、响应示例 JSON、cURL 命令。
${presetSection}${moduleListSection}${moduleContextSection}
═══════════════════════════════════════
重要约束
═══════════════════════════════════════
1. 所有文件必须严格按照骨架生成，不要遗漏任何文件
2. controller.ts 的 import 路径使用 @core 别名
3. schema.sql 中表名用 mock__ 前缀，不要加 userId
4. test.ts 中通过 /mock/模块名 路径访问接口
5. 每次修改后必须更新 _context.md 和 api-doc.md
6. 生成完所有文件后，调用 run_test 验证
7. 如果测试失败，阅读错误信息修复后重新测试
8. 批量生成测试数据用 manage_data bulk_generate
9. 字段名用 camelCase，数据库列名用 snake_case
10. 禁止在 SQL 中字符串拼接用户输入，必须用参数化查询`;
}
