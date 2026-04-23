/**
 * openapi-export 把 _meta.json 的字段约束 + 跨字段规则映射进 OpenAPI 3 spec。
 */
import { test, expect } from '@playwright/test';
import { buildOpenApi } from '../src/server/core/openapi-export';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';

const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;
const MODULE = 'oapi_constraint_test';

function setupMeta(meta: Record<string, unknown>) {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '_meta.json'), JSON.stringify({
    name: MODULE,
    displayName: 'OAPI Constraints Test',
    basePath: `/mock/${MODULE}`,
    version: 1,
    config: { delay: { min: 0, max: 0 }, errorRate: 0 },
    ...meta,
  }, null, 2), 'utf-8');
}

function cleanup() {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (existsSync(dir)) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test.describe('openapi-export 约束映射', () => {
  test.afterEach(() => cleanup());

  test('OC01 enum 字段映射到 schema.enum', () => {
    setupMeta({
      entities: [{
        name: MODULE,
        tableName: `mock__${MODULE}`,
        fields: [{
          name: 'status',
          type: 'string',
          enum: ['in_stock', 'low_stock', 'out_of_stock'],
        }],
      }],
      endpoints: [{ method: 'POST', path: '/', name: '创建', type: 'create' }],
    });
    const spec = buildOpenApi(USER_ID, MODULE) as any;
    const schema = spec.components.schemas[MODULE].properties.status;
    expect(schema.enum).toEqual(['in_stock', 'low_stock', 'out_of_stock']);
    expect(schema.type).toBe('string');
  });

  test('OC02 enumValues (旧别名) 映射到 schema.enum', () => {
    setupMeta({
      entities: [{
        name: MODULE,
        tableName: `mock__${MODULE}`,
        fields: [{
          name: 'status', type: 'string',
          enumValues: ['a', 'b', 'c'],
        }],
      }],
      endpoints: [{ method: 'POST', path: '/', name: '创建', type: 'create' }],
    });
    const spec = buildOpenApi(USER_ID, MODULE) as any;
    expect(spec.components.schemas[MODULE].properties.status.enum).toEqual(['a', 'b', 'c']);
  });

  test('OC03 数值 min/max 映射到 minimum/maximum', () => {
    setupMeta({
      entities: [{
        name: MODULE,
        tableName: `mock__${MODULE}`,
        fields: [{
          name: 'quantity', type: 'integer', min: 0, max: 1000,
        }],
      }],
      endpoints: [{ method: 'POST', path: '/', name: '创建', type: 'create' }],
    });
    const spec = buildOpenApi(USER_ID, MODULE) as any;
    const schema = spec.components.schemas[MODULE].properties.quantity;
    expect(schema.minimum).toBe(0);
    expect(schema.maximum).toBe(1000);
  });

  test('OC04 字符串 pattern + minLength/maxLength 映射', () => {
    setupMeta({
      entities: [{
        name: MODULE,
        tableName: `mock__${MODULE}`,
        fields: [{
          name: 'sku', type: 'string',
          pattern: '^[A-Z0-9-]{3,32}$',
          minLength: 3,
          maxLength: 32,
        }],
      }],
      endpoints: [{ method: 'POST', path: '/', name: '创建', type: 'create' }],
    });
    const spec = buildOpenApi(USER_ID, MODULE) as any;
    const schema = spec.components.schemas[MODULE].properties.sku;
    expect(schema.pattern).toBe('^[A-Z0-9-]{3,32}$');
    expect(schema.minLength).toBe(3);
    expect(schema.maxLength).toBe(32);
  });

  test('OC05 description / default 字段映射', () => {
    setupMeta({
      entities: [{
        name: MODULE,
        tableName: `mock__${MODULE}`,
        fields: [
          { name: 'note', type: 'string', description: '备注信息' },
          { name: 'status', type: 'string', default: 'active' },
        ],
      }],
      endpoints: [{ method: 'POST', path: '/', name: '创建', type: 'create' }],
    });
    const spec = buildOpenApi(USER_ID, MODULE) as any;
    expect(spec.components.schemas[MODULE].properties.note.description).toBe('备注信息');
    expect(spec.components.schemas[MODULE].properties.status.default).toBe('active');
  });

  test('OC06 entity.constraints 跨字段规则进入 write-endpoint description', () => {
    setupMeta({
      entities: [{
        name: MODULE,
        tableName: `mock__${MODULE}`,
        fields: [
          { name: 'quantity', type: 'integer', required: true },
          { name: 'status', type: 'string', enum: ['in_stock', 'out_of_stock'] },
        ],
        constraints: [{
          id: 'qty-zero',
          when: { quantity: 0 },
          must: { status: 'out_of_stock' },
          message: '数量为 0 时,状态必须为 out_of_stock',
        }],
      }],
      endpoints: [
        { method: 'GET', path: '/', name: '列表', type: 'list' },
        { method: 'POST', path: '/', name: '创建', type: 'create' },
        { method: 'PUT', path: '/:id', name: '更新', type: 'update' },
      ],
    });
    const spec = buildOpenApi(USER_ID, MODULE) as any;
    // POST/PUT description 含约束块
    expect(spec.paths[`/mock/${MODULE}/`].post.description).toContain('业务约束');
    expect(spec.paths[`/mock/${MODULE}/`].post.description).toContain('qty-zero');
    expect(spec.paths[`/mock/${MODULE}/`].post.description).toContain('数量为 0');
    expect(spec.paths[`/mock/${MODULE}/{id}`].put.description).toContain('业务约束');
    // GET (read) 不带约束 description
    expect(spec.paths[`/mock/${MODULE}/`].get.description).toBeUndefined();
  });

  test('OC07 Patch schema 也继承字段约束 (enum/min/max 同步)', () => {
    setupMeta({
      entities: [{
        name: MODULE,
        tableName: `mock__${MODULE}`,
        fields: [
          { name: 'status', type: 'string', enum: ['a', 'b'] },
          { name: 'quantity', type: 'integer', min: 0 },
        ],
      }],
      endpoints: [
        { method: 'POST', path: '/', name: '创建', type: 'create' },
        { method: 'PUT', path: '/:id', name: '更新', type: 'update' },
      ],
    });
    const spec = buildOpenApi(USER_ID, MODULE) as any;
    const patch = spec.components.schemas[`${MODULE}Patch`].properties;
    expect(patch.status.enum).toEqual(['a', 'b']);
    expect(patch.quantity.minimum).toBe(0);
    // Patch 仍然没有 required (PATCH 语义)
    expect(spec.components.schemas[`${MODULE}Patch`].required ?? []).toEqual([]);
  });
});
