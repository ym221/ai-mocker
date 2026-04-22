import { resolve, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { faker } from '@faker-js/faker';
import { BaseModel, mockContext } from '../../core/base-model.js';
import { sqlite } from '../../core/database.js';

const GENERATED_DIR = resolve('generated');

interface MetaField {
  name: string;
  type: string;
  enumValues?: string[];
  defaultValue?: unknown;
  required?: boolean;
}

export type FieldRule =
  | { kind: 'faker' }
  | { kind: 'sequence'; prefix?: string; start?: number }
  | { kind: 'fixed'; value: unknown };

function fakerByFieldName(field: MetaField): unknown {
  const n = field.name.toLowerCase();
  if (n.includes('email')) return faker.internet.email();
  if (n.includes('phone') || n.includes('mobile') || n.includes('tel')) return faker.phone.number();
  if (n.includes('address')) return faker.location.streetAddress();
  if (n.includes('city')) return faker.location.city();
  if (n.includes('country')) return faker.location.country();
  if (n.includes('url') || n.includes('link') || n.includes('website')) return faker.internet.url();
  if (n.includes('avatar') || n.includes('image') || n.includes('photo')) return faker.image.avatar();
  if (n.includes('description') || n.includes('remark') || n.includes('comment') || n.includes('note')) return faker.lorem.sentence();
  if (n.includes('title')) return faker.lorem.words(3);
  if (n.includes('username') || n.includes('account')) return faker.internet.username();
  if (n.includes('firstname')) return faker.person.firstName();
  if (n.includes('lastname')) return faker.person.lastName();
  if (n.includes('name')) return faker.person.fullName();
  if (n.includes('company')) return faker.company.name();
  if (n.includes('product')) return faker.commerce.productName();
  if (n.includes('color')) return faker.color.human();
  if (n.includes('no') || n.includes('number') || n.includes('code')) return faker.string.alphanumeric(10).toUpperCase();
  return faker.lorem.word();
}

function generateFakerValue(field: MetaField): unknown {
  switch (field.type) {
    case 'string':
    case 'text':
      return fakerByFieldName(field);
    case 'integer':
    case 'int':
      return faker.number.int({ min: 1, max: 1000 });
    case 'decimal':
    case 'float':
    case 'number':
      return Number(faker.finance.amount({ min: 1, max: 10000, dec: 2 }));
    case 'boolean':
      return faker.datatype.boolean() ? 1 : 0;
    case 'enum':
      if (field.enumValues?.length) {
        return faker.helpers.arrayElement(field.enumValues);
      }
      return field.defaultValue || 'unknown';
    case 'date':
    case 'datetime':
      return faker.date.recent().toISOString().slice(0, 19).replace('T', ' ');
    default:
      return faker.lorem.word();
  }
}

function applyRule(field: MetaField, rule: FieldRule | undefined, index: number): unknown {
  if (!rule || rule.kind === 'faker') return generateFakerValue(field);
  if (rule.kind === 'fixed') return rule.value;
  if (rule.kind === 'sequence') {
    const n = (rule.start ?? 1) + index;
    return rule.prefix ? `${rule.prefix}${n}` : n;
  }
  return generateFakerValue(field);
}

function getModuleMeta(userId: number, moduleName: string) {
  const metaPath = join(GENERATED_DIR, String(userId), moduleName, '_meta.json');
  if (!existsSync(metaPath)) {
    throw new Error(`Module meta not found: ${moduleName}/_meta.json`);
  }
  return JSON.parse(readFileSync(metaPath, 'utf-8'));
}

function resolveTableName(userId: number, moduleName: string, entityName?: string): { tableName: string; meta: Record<string, unknown>; entityName: string } {
  const meta = getModuleMeta(userId, moduleName);
  const entities = (meta.entities as Array<{ name: string; tableName?: string }> | undefined) ?? [];
  const entity = entityName ? entities.find(e => e.name === entityName) : entities[0];
  if (!entity) {
    throw new Error(`Entity ${entityName ? `"${entityName}"` : '[0]'} not found in ${moduleName}/_meta.json`);
  }
  // Prefer the explicit tableName field declared in _meta.json — it's the
  // ground truth that write-file.ts / schema.sql actually created. Fall back
  // to the `mock__{name}` convention only when tableName is absent.
  const tableName = entity.tableName || `mock__${entity.name}`;
  return { tableName, meta, entityName: entity.name };
}

/**
 * Ensure the physical SQLite table exists. If not, try to heal by executing
 * the module's schema.sql with userId injection — same logic as write-file.ts.
 * Throws a user-friendly error when healing is not possible.
 */
function ensureTableExists(userId: number, moduleName: string, tableName: string): string {
  const bare = tableName.replace(/^mock__/, '');
  const physical = `mock__${userId}_${bare}`;
  const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(physical);
  if (row) return physical;

  // Try to self-heal by executing schema.sql
  const sqlPath = join(GENERATED_DIR, String(userId), moduleName, 'schema.sql');
  if (!existsSync(sqlPath)) {
    throw new Error(`数据表 ${physical} 不存在，且找不到 ${moduleName}/schema.sql，请让 AI 重新生成模块。`);
  }

  // Snapshot tables before executing
  const before = new Set(
    (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`)
      .all(`mock__${userId}_%`) as { name: string }[]).map(r => r.name)
  );

  const raw = readFileSync(sqlPath, 'utf-8');
  const injected = raw
    .replace(/`mock__([a-zA-Z0-9_]+)`/g, `\`mock__${userId}_$1\``)
    .replace(/(?<![`\w])mock__([a-zA-Z0-9_]+)(?![`\w])/g, `mock__${userId}_$1`);
  try {
    sqlite.exec(injected);
  } catch (e) {
    throw new Error(`数据表自愈失败：${(e as Error).message}。请让 AI 修复 schema.sql。`);
  }

  // Check if expected table now exists
  const afterRow = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(physical);
  if (afterRow) return physical;

  // Expected name not found — find any NEW table created by schema.sql and use that instead
  const afterAll = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`)
    .all(`mock__${userId}_%`) as { name: string }[]).map(r => r.name);
  const newTables = afterAll.filter(n => !before.has(n));

  if (newTables.length > 0) {
    // Auto-fix: update _meta.json tableName to match what schema.sql actually created
    const actualBare = newTables[0].replace(`mock__${userId}_`, 'mock__');
    const metaPath = join(GENERATED_DIR, String(userId), moduleName, '_meta.json');
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        if (meta.entities?.[0]) {
          meta.entities[0].tableName = actualBare;
          writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        }
      } catch { /* non-critical */ }
    }
    return newTables[0];
  }

  throw new Error(`schema.sql 执行后仍未创建表 ${physical}。请让 AI 修复 schema.sql 和 _meta.json 的表名一致性。`);
}

export interface ManageDataOptions {
  count?: number;
  id?: number;
  entityName?: string;
  ids?: number[];
  page?: number;
  pageSize?: number;
  orderBy?: string;
  where?: Record<string, unknown>;
  rules?: Record<string, FieldRule>;
}

export async function manageData(
  userId: number,
  action: string,
  moduleName: string,
  data?: Record<string, unknown>,
  options?: ManageDataOptions
): Promise<unknown> {
  const { tableName, meta, entityName } = resolveTableName(userId, moduleName, options?.entityName);

  // Self-heal: ensure underlying physical table exists before any DB operation.
  // Also heal on 'list' so the UI doesn't show misleading empty state for missing tables.
  const healedPhysical = ensureTableExists(userId, moduleName, tableName);
  // If ensureTableExists auto-corrected the table name (schema.sql vs _meta mismatch),
  // derive the corrected BaseModel-compatible name (without userId prefix).
  const effectiveTable = healedPhysical.replace(new RegExp(`^mock__${userId}_`), 'mock__');

  return mockContext.run({ userId }, () => {
    const model = new BaseModel(effectiveTable);

    switch (action) {
      case 'list': {
        return model.findAll({
          page: options?.page ?? 1,
          pageSize: options?.pageSize ?? 20,
          orderBy: options?.orderBy,
          where: options?.where,
        });
      }

      case 'insert': {
        if (!data) throw new Error('Data required for insert');
        return model.create(data);
      }

      case 'update': {
        const id = options?.id;
        if (!id) throw new Error('ID required for update');
        if (!data) throw new Error('Data required for update');
        return model.update(id, data);
      }

      case 'bulk_generate': {
        const count = options?.count ?? 10;
        const entity = meta.entities?.find((e: { name: string }) => e.name === entityName);
        const fields: MetaField[] = entity?.fields || [];
        const rules = options?.rules || {};
        const results: Record<string, unknown>[] = [];

        for (let i = 0; i < count; i++) {
          const record: Record<string, unknown> = {};
          for (const field of fields) {
            record[field.name] = applyRule(field, rules[field.name], i);
          }
          results.push(model.create(record));
        }
        return { generated: results.length };
      }

      case 'delete': {
        const id = options?.id;
        if (!id) throw new Error('ID required for delete');
        return { deleted: model.delete(id) };
      }

      case 'batch_delete': {
        const ids = options?.ids;
        if (!Array.isArray(ids) || ids.length === 0) throw new Error('IDs required for batch_delete');
        let deleted = 0;
        for (const id of ids) {
          if (model.delete(id)) deleted++;
        }
        return { deleted };
      }

      case 'clear': {
        const all = model.findAll({ page: 1, pageSize: 100000 });
        let deleted = 0;
        for (const item of all.list) {
          if (model.delete(item.id as number)) deleted++;
        }
        return { cleared: deleted };
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  });
}
