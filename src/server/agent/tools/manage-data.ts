import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { faker } from '@faker-js/faker';
import { BaseModel, mockContext } from '../../core/base-model.js';

const GENERATED_DIR = resolve('generated');

interface MetaField {
  name: string;
  type: string;
  enumValues?: string[];
  defaultValue?: unknown;
  required?: boolean;
}

function generateFakerValue(field: MetaField): unknown {
  switch (field.type) {
    case 'string':
      if (field.name.toLowerCase().includes('name')) return faker.person.fullName();
      if (field.name.toLowerCase().includes('email')) return faker.internet.email();
      if (field.name.toLowerCase().includes('phone')) return faker.phone.number();
      if (field.name.toLowerCase().includes('address')) return faker.location.streetAddress();
      if (field.name.toLowerCase().includes('url')) return faker.internet.url();
      if (field.name.toLowerCase().includes('description')) return faker.lorem.sentence();
      if (field.name.toLowerCase().includes('no') || field.name.toLowerCase().includes('number')) return faker.string.alphanumeric(10).toUpperCase();
      return faker.lorem.word();
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

function getModuleMeta(userId: number, moduleName: string) {
  const metaPath = join(GENERATED_DIR, String(userId), moduleName, '_meta.json');
  if (!existsSync(metaPath)) {
    throw new Error(`Module meta not found: ${moduleName}/_meta.json`);
  }
  return JSON.parse(readFileSync(metaPath, 'utf-8'));
}

export async function manageData(
  userId: number,
  action: string,
  moduleName: string,
  data?: Record<string, unknown>,
  options?: { count?: number; id?: number; entityName?: string }
): Promise<unknown> {
  const meta = getModuleMeta(userId, moduleName);
  const entityName = options?.entityName || meta.entities?.[0]?.name || moduleName;
  const tableName = `mock__${entityName}`;

  return mockContext.run({ userId }, () => {
    const model = new BaseModel(tableName);

    switch (action) {
      case 'insert': {
        if (!data) throw new Error('Data required for insert');
        return model.create(data);
      }

      case 'bulk_generate': {
        const count = options?.count || 10;
        const entity = meta.entities?.find((e: { name: string }) => e.name === entityName);
        const fields: MetaField[] = entity?.fields || [];
        const results: Record<string, unknown>[] = [];

        for (let i = 0; i < count; i++) {
          const record: Record<string, unknown> = {};
          for (const field of fields) {
            record[field.name] = generateFakerValue(field);
          }
          results.push(model.create(record));
        }
        return { generated: results.length };
      }

      case 'delete': {
        const id = options?.id;
        if (!id) throw new Error('ID required for delete');
        return model.delete(id);
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
