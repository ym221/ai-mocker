import { AsyncLocalStorage } from 'async_hooks';
import { sqlite } from './database.js';

// AsyncLocalStorage for userId context
export interface MockContext {
  userId: number;
}

export const mockContext = new AsyncLocalStorage<MockContext>();

// camelCase → snake_case
function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// snake_case → camelCase
function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

// Convert object keys from camelCase to snake_case
function keysToSnake(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[toSnakeCase(key)] = value;
  }
  return result;
}

// Convert object keys from snake_case to camelCase
function keysToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[toCamelCase(key)] = value;
  }
  return result;
}

interface WhereCondition {
  like?: string;
  gt?: number | string;
  gte?: number | string;
  lt?: number | string;
  lte?: number | string;
  in?: (string | number)[];
}

interface FindAllOptions {
  page?: number;
  pageSize?: number;
  where?: Record<string, unknown>;
  orderBy?: string;
}

interface FindAllResult {
  list: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

export class BaseModel {
  private baseTableName: string;

  constructor(tableName: string) {
    // Store the base table name (e.g., 'mock__order')
    this.baseTableName = tableName;
  }

  /** Get the actual table name with userId prefix */
  private getTableName(): string {
    const ctx = mockContext.getStore();
    if (!ctx) {
      throw new Error('BaseModel: mockContext not set. Ensure mock-router sets userId via AsyncLocalStorage.');
    }
    // mock__order → mock__{userId}_order
    // Extract the part after 'mock__'
    const suffix = this.baseTableName.replace(/^mock__/, '');
    return `mock__${ctx.userId}_${suffix}`;
  }

  /** Build WHERE clause from conditions */
  private buildWhere(where?: Record<string, unknown>): { clause: string; params: unknown[] } {
    if (!where || Object.keys(where).length === 0) {
      return { clause: '', params: [] };
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(where)) {
      const column = toSnakeCase(key);

      if (value === null || value === undefined) {
        conditions.push(`\`${column}\` IS NULL`);
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        const cond = value as WhereCondition;
        if (cond.like !== undefined) {
          conditions.push(`\`${column}\` LIKE ?`);
          params.push(cond.like);
        }
        if (cond.gt !== undefined) {
          conditions.push(`\`${column}\` > ?`);
          params.push(cond.gt);
        }
        if (cond.gte !== undefined) {
          conditions.push(`\`${column}\` >= ?`);
          params.push(cond.gte);
        }
        if (cond.lt !== undefined) {
          conditions.push(`\`${column}\` < ?`);
          params.push(cond.lt);
        }
        if (cond.lte !== undefined) {
          conditions.push(`\`${column}\` <= ?`);
          params.push(cond.lte);
        }
        if (cond.in !== undefined && Array.isArray(cond.in)) {
          const placeholders = cond.in.map(() => '?').join(',');
          conditions.push(`\`${column}\` IN (${placeholders})`);
          params.push(...cond.in);
        }
      } else {
        conditions.push(`\`${column}\` = ?`);
        params.push(value);
      }
    }

    return {
      clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  findAll(options: FindAllOptions = {}): FindAllResult {
    const tableName = this.getTableName();
    const page = options.page || 1;
    const pageSize = options.pageSize || 20;
    const offset = (page - 1) * pageSize;

    const { clause: whereClause, params: whereParams } = this.buildWhere(options.where);
    const orderBy = options.orderBy ? `ORDER BY ${options.orderBy}` : 'ORDER BY id DESC';

    const countSql = `SELECT COUNT(*) as count FROM \`${tableName}\` ${whereClause}`;
    const countResult = sqlite.prepare(countSql).get(...whereParams) as { count: number };
    const total = countResult?.count ?? 0;

    const dataSql = `SELECT * FROM \`${tableName}\` ${whereClause} ${orderBy} LIMIT ? OFFSET ?`;
    const rows = sqlite.prepare(dataSql).all(...whereParams, pageSize, offset) as Record<string, unknown>[];

    return {
      list: rows.map(keysToCamel),
      total,
      page,
      pageSize,
    };
  }

  findById(id: number): Record<string, unknown> | null {
    const tableName = this.getTableName();
    const row = sqlite.prepare(`SELECT * FROM \`${tableName}\` WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? keysToCamel(row) : null;
  }

  create(data: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.getTableName();
    const snakeData = keysToSnake(data);

    // Remove id, created_at, updated_at — let DB handle them
    delete snakeData.id;
    delete snakeData.created_at;
    delete snakeData.updated_at;

    const columns = Object.keys(snakeData);
    const placeholders = columns.map(() => '?').join(', ');
    const values = Object.values(snakeData);

    const sql = `INSERT INTO \`${tableName}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES (${placeholders})`;
    const result = sqlite.prepare(sql).run(...values);

    return this.findById(result.lastInsertRowid as number)!;
  }

  update(id: number, data: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.getTableName();
    const snakeData = keysToSnake(data);

    // Remove id, created_at — don't update these
    delete snakeData.id;
    delete snakeData.created_at;

    // Set updated_at
    snakeData.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const setClauses = Object.keys(snakeData).map(c => `\`${c}\` = ?`).join(', ');
    const values = Object.values(snakeData);

    const sql = `UPDATE \`${tableName}\` SET ${setClauses} WHERE id = ?`;
    sqlite.prepare(sql).run(...values, id);

    return this.findById(id)!;
  }

  delete(id: number): boolean {
    const tableName = this.getTableName();
    const result = sqlite.prepare(`DELETE FROM \`${tableName}\` WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  count(where?: Record<string, unknown>): number {
    const tableName = this.getTableName();
    const { clause: whereClause, params: whereParams } = this.buildWhere(where);
    const sql = `SELECT COUNT(*) as count FROM \`${tableName}\` ${whereClause}`;
    const result = sqlite.prepare(sql).get(...whereParams) as { count: number };
    return result?.count ?? 0;
  }

  raw(sql: string, params: unknown[] = []): unknown[] {
    return sqlite.prepare(sql).all(...params);
  }
}
