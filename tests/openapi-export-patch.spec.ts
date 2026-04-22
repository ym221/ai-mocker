/**
 * 回归测试: openapi-export 必须为 PUT/PATCH 输出 Patch schema (所有字段 optional)。
 *
 * 起因: 以前 PUT 引用完整 entity schema (含 required 字段),导致 diff_with_openapi
 *   把"部分更新"(PATCH 语义的 PUT)误报为"缺必填"。
 *
 * 现在: buildOpenApi 自动为每个 entity 额外生成 `{name}Patch` schema;
 *   PUT/PATCH 使用 Patch，POST 仍用 full entity schema。
 */
import { test, expect } from '@playwright/test';
import { buildOpenApi } from '../src/server/core/openapi-export';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';

const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;
const MODULE = 'oapi_patch_test';

function setupMeta(fields: Array<{ name: string; type: string; required?: boolean }>) {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const meta = {
    name: MODULE,
    displayName: 'OAPI Patch Test',
    basePath: `/mock/${MODULE}`,
    version: 1,
    entities: [{
      name: MODULE,
      tableName: `mock__${MODULE}`,
      displayName: 'E',
      fields,
    }],
    endpoints: [
      { method: 'GET', path: '/', name: '列表', type: 'list' },
      { method: 'GET', path: '/:id', name: '详情', type: 'detail' },
      { method: 'POST', path: '/', name: '创建', type: 'create' },
      { method: 'PUT', path: '/:id', name: '更新', type: 'update' },
      { method: 'PATCH', path: '/:id', name: '局部更新', type: 'custom', handler: 'patchItem' },
      { method: 'DELETE', path: '/:id', name: '删除', type: 'delete' },
    ],
    config: { delay: { min: 0, max: 0 }, errorRate: 0 },
  };
  writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

function cleanup() {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (existsSync(dir)) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test.describe('openapi-export Patch schema', () => {
  test.afterEach(() => cleanup());

  test('OP01 components.schemas 同时包含 entity 与 {entity}Patch', () => {
    setupMeta([
      { name: 'title', type: 'string', required: true },
      { name: 'note', type: 'string', required: false },
    ]);
    const spec = buildOpenApi(USER_ID, MODULE) as any;
    expect(spec).toBeTruthy();
    const schemas = spec.components.schemas;
    expect(schemas).toHaveProperty(MODULE);
    expect(schemas).toHaveProperty(`${MODULE}Patch`);

    // 完整 schema: required 包含 title
    expect(schemas[MODULE].required).toContain('title');
    // Patch schema: 无 required 或空
    expect(schemas[`${MODULE}Patch`].required ?? []).toEqual([]);
    // Patch schema: 不含 id / created_at / updated_at(这些是系统字段)
    expect(schemas[`${MODULE}Patch`].properties).not.toHaveProperty('id');
    expect(schemas[`${MODULE}Patch`].properties).not.toHaveProperty('created_at');
    expect(schemas[`${MODULE}Patch`].properties).not.toHaveProperty('updated_at');
    // Patch schema: 含所有用户字段
    expect(schemas[`${MODULE}Patch`].properties).toHaveProperty('title');
    expect(schemas[`${MODULE}Patch`].properties).toHaveProperty('note');
  });

  test('OP02 POST 引用完整 schema, PUT/PATCH 引用 Patch schema', () => {
    setupMeta([{ name: 'title', type: 'string', required: true }]);
    const spec = buildOpenApi(USER_ID, MODULE) as any;

    const basePost = spec.paths[`/mock/${MODULE}/`]?.post;
    const putOp = spec.paths[`/mock/${MODULE}/{id}`]?.put;
    const patchOp = spec.paths[`/mock/${MODULE}/{id}`]?.patch;

    expect(basePost.requestBody.content['application/json'].schema.$ref)
      .toBe(`#/components/schemas/${MODULE}`);
    expect(putOp.requestBody.content['application/json'].schema.$ref)
      .toBe(`#/components/schemas/${MODULE}Patch`);
    expect(patchOp.requestBody.content['application/json'].schema.$ref)
      .toBe(`#/components/schemas/${MODULE}Patch`);
  });

  test('OP03 Patch schema 字段类型与原 schema 一致', () => {
    setupMeta([
      { name: 'title', type: 'string', required: true },
      { name: 'count', type: 'integer', required: false },
      { name: 'active', type: 'boolean', required: false },
    ]);
    const spec = buildOpenApi(USER_ID, MODULE) as any;
    const patch = spec.components.schemas[`${MODULE}Patch`].properties;
    expect(patch.title.type).toBe('string');
    expect(patch.count.type).toBe('integer');
    expect(patch.active.type).toBe('boolean');
  });
});
