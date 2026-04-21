import { AsyncLocalStorage } from 'async_hooks';
import { sqlite } from './database.js';

// AsyncLocalStorage for userId context
export interface MockContext {
  userId: number;
}

export const mockContext = new AsyncLocalStorage<MockContext>();

// Normalize JS values for SQLite binding (SQLite can't bind booleans / objects)
function normalizeBindValue(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
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
      const column = key;

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
        params.push(normalizeBindValue(value));
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
      list: rows,
      total,
      page,
      pageSize,
    };
  }

  findById(id: number): Record<string, unknown> | null {
    const tableName = this.getTableName();
    const row = sqlite.prepare(`SELECT * FROM \`${tableName}\` WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  create(data: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.getTableName();
    const cleanData = { ...data };

    // Remove system fields — let DB handle them
    delete cleanData.id;
    delete cleanData.created_at;
    delete cleanData.updated_at;
    delete (cleanData as Record<string, unknown>).createdAt;
    delete (cleanData as Record<string, unknown>).updatedAt;

    const columns = Object.keys(cleanData);
    const placeholders = columns.map(() => '?').join(', ');
    const values = Object.values(cleanData).map(normalizeBindValue);

    const sql = `INSERT INTO \`${tableName}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES (${placeholders})`;
    const result = sqlite.prepare(sql).run(...values);

    return this.findById(result.lastInsertRowid as number)!;
  }

  update(id: number, data: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.getTableName();
    const cleanData = { ...data };

    // Remove system fields — don't update these
    delete cleanData.id;
    delete cleanData.created_at;
    delete (cleanData as Record<string, unknown>).createdAt;

    // Set updated_at
    cleanData.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const setClauses = Object.keys(cleanData).map(c => `\`${c}\` = ?`).join(', ');
    const values = Object.values(cleanData).map(normalizeBindValue);

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
