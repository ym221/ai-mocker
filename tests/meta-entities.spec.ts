/**
 * Step-Fix-1.2: `getEntities(meta)` folds legacy top-level `entity` into `entities[]`
 * so every downstream (openapi-export / manage_data / module-health / run-test /
 * delete-module / update-diff / handoff-report / BaseModel) reads from one source.
 *
 * Also covers pickEntityForEndpoint — per-endpoint entity resolution used by
 * openapi-export so multi-entity modules ref the right schema per endpoint.
 */
import { test, expect } from '@playwright/test';
import {
  getEntities,
  getPrimaryEntity,
  getPrimaryTableName,
  pickEntityForEndpoint,
  normalizeMeta,
  type ModuleMeta,
} from '../src/server/core/meta-schema';

test.describe('meta-entities helpers (Step-Fix-1.2)', () => {
  test('ME01 getEntities: new-style entities[] only — returns as-is', () => {
    const meta: ModuleMeta = {
      name: 'simple',
      entities: [{ name: 'User', tableName: 'mock__User', fields: [] }],
    };
    const out = getEntities(meta);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('User');
  });

  test('ME02 getEntities: legacy entity only → lifted into list', () => {
    const meta: ModuleMeta = {
      name: 'legacy',
      entity: { name: 'Warehouse', tableName: 'mock__Warehouse', fields: [{ name: 'id' }] },
    };
    const out = getEntities(meta);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Warehouse');
    expect(out[0].tableName).toBe('mock__Warehouse');
  });

  test('ME03 getEntities: hybrid (entity + entities[]) — legacy entity prepended', () => {
    const meta: ModuleMeta = {
      name: 'warehouse',
      entity: { name: 'Warehouse', tableName: 'mock__Warehouse', fields: [] },
      entities: [
        { name: 'Item', tableName: 'mock__Item', fields: [] },
        { name: 'InventoryRecord', tableName: 'mock__InventoryRecord', fields: [] },
      ],
    };
    const out = getEntities(meta);
    expect(out.map(e => e.name)).toEqual(['Warehouse', 'Item', 'InventoryRecord']);
  });

  test('ME04 getEntities: dup name in both — keep only one, no double-count', () => {
    const meta: ModuleMeta = {
      entity: { name: 'User', tableName: 'mock__User', fields: [] },
      entities: [{ name: 'User', tableName: 'mock__User_v2', fields: [] }],
    };
    const out = getEntities(meta);
    expect(out).toHaveLength(1);
    // When duplicate name, entities[] wins (legacy is skipped, no prepend)
    expect(out[0].tableName).toBe('mock__User_v2');
  });

  test('ME05 getEntities: null/empty safe', () => {
    expect(getEntities(null)).toEqual([]);
    expect(getEntities(undefined)).toEqual([]);
    expect(getEntities({})).toEqual([]);
    expect(getEntities({ entities: [] })).toEqual([]);
  });

  test('ME06 getPrimaryEntity + getPrimaryTableName on hybrid meta', () => {
    const meta: ModuleMeta = {
      entity: { name: 'Warehouse', tableName: 'mock__Warehouse', fields: [] },
      entities: [{ name: 'Item', tableName: 'mock__Item', fields: [] }],
    };
    expect(getPrimaryEntity(meta)?.name).toBe('Warehouse');
    expect(getPrimaryTableName(meta)).toBe('mock__Warehouse');
  });

  test('ME07 getEntities normalizes enumValues/defaultValue aliases', () => {
    const meta: ModuleMeta = {
      entity: {
        name: 'A',
        fields: [{ name: 'status', enumValues: ['on', 'off'], defaultValue: 'on' }],
      },
    };
    const [e] = getEntities(meta);
    const f = e.fields![0];
    expect(f.enum).toEqual(['on', 'off']);
    expect(f.default).toBe('on');
  });

  test('ME08 pickEntityForEndpoint: explicit ep.entity wins', () => {
    const entities = [
      { name: 'Warehouse', fields: [] },
      { name: 'Item', fields: [] },
    ];
    const ep = { method: 'GET', path: '/whatever', type: 'list', entity: 'Item' } as any;
    const hit = pickEntityForEndpoint(ep, entities);
    expect(hit?.name).toBe('Item');
  });

  test('ME09 pickEntityForEndpoint: controller name heuristic — listWarehouses → Warehouse', () => {
    const entities = [
      { name: 'Warehouse', fields: [] },
      { name: 'Item', fields: [] },
    ];
    const hit = pickEntityForEndpoint(
      { method: 'GET', path: '/warehouses', type: 'list', controller: 'listWarehouses' },
      entities
    );
    expect(hit?.name).toBe('Warehouse');
  });

  test('ME10 pickEntityForEndpoint: controller getItemById → Item (strip ById + verb)', () => {
    const entities = [
      { name: 'Warehouse', fields: [] },
      { name: 'Item', fields: [] },
    ];
    const hit = pickEntityForEndpoint(
      { method: 'GET', path: '/items/:id', type: 'detail', controller: 'getItemById' },
      entities
    );
    expect(hit?.name).toBe('Item');
  });

  test('ME11 pickEntityForEndpoint: path-segment heuristic — /inventory → Inventory', () => {
    const entities = [
      { name: 'Warehouse', fields: [] },
      { name: 'Item', fields: [] },
      { name: 'Inventory', fields: [] },
    ];
    const hit = pickEntityForEndpoint(
      { method: 'GET', path: '/inventory', type: 'list' },
      entities
    );
    expect(hit?.name).toBe('Inventory');
  });

  test('ME12 pickEntityForEndpoint: /items → Item (singular match on trailing s)', () => {
    const entities = [
      { name: 'Warehouse', fields: [] },
      { name: 'Item', fields: [] },
    ];
    const hit = pickEntityForEndpoint(
      { method: 'POST', path: '/items', type: 'create' },
      entities
    );
    expect(hit?.name).toBe('Item');
  });

  test('ME13 pickEntityForEndpoint: no heuristic match → fallback to first entity', () => {
    const entities = [
      { name: 'Warehouse', fields: [] },
      { name: 'Item', fields: [] },
    ];
    const hit = pickEntityForEndpoint(
      { method: 'GET', path: '/stats', type: 'custom' },
      entities
    );
    expect(hit?.name).toBe('Warehouse');
  });

  test('ME14 pickEntityForEndpoint: empty entity list → null', () => {
    const hit = pickEntityForEndpoint({ method: 'GET', path: '/foo', type: 'list' }, []);
    expect(hit).toBeNull();
  });

  test('ME15 normalizeMeta still works with legacy entity present (it does not drop it)', () => {
    const meta: ModuleMeta = {
      name: 'hybrid',
      entity: { name: 'Warehouse', tableName: 'mock__Warehouse', fields: [] },
      entities: [{ name: 'Item', tableName: 'mock__Item', fields: [] }],
    };
    const normalized = normalizeMeta(meta);
    // normalizeMeta does NOT fold legacy entity — only getEntities does.
    // This preserves file-on-disk structure for round-trip reads.
    expect(normalized.entity?.name).toBe('Warehouse');
    expect(normalized.entities?.[0].name).toBe('Item');
    // getEntities applied over the normalized meta still merges them.
    expect(getEntities(normalized).map(e => e.name)).toEqual(['Warehouse', 'Item']);
  });
});
