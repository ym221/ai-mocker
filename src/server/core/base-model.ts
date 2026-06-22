import { AsyncLocalStorage } from 'async_hooks';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { sqlite } from './database.js';
import { normalizeMeta, getEntities, type MetaEntity } from './meta-schema.js';
import { validate, ValidationError } from './validator.js';
import { injectUserIdToTableNames } from './table-name-prefix.js';

export { ValidationError } from './validator.js';

const GENERATED_DIR = resolve('generated');

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

/**
 * orderBy 接受三种自然写法,都被框架归一化为安全的 SQL ORDER BY 子句:
 *   - 'createdAt DESC' / 'id ASC'                              (string)
 *   - { createdAt: 'DESC' }                                    (single-field object — AI 最常用)
 *   - [{ createdAt: 'DESC' }, { id: 'ASC' }]                   (multi-field array)
 *   - ['createdAt DESC', 'id ASC']                             (string-array)
 *
 * 列名做白名单(字母/数字/下划线),DESC/ASC 默认 ASC。
 */
type OrderByValue = 'ASC' | 'DESC' | 'asc' | 'desc' | string;
export type OrderByInput =
  | string
  | string[]
  | Record<string, OrderByValue>
  | Array<Record<string, OrderByValue>>;

interface FindAllOptions {
  page?: number;
  pageSize?: number;
  where?: Record<string, unknown>;
  orderBy?: OrderByInput;
}

function normalizeOrderBy(raw: OrderByInput | undefined, defaultClause: string): string {
  if (raw == null) return defaultClause;
  const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const parts: string[] = [];
  const pushPair = (col: string, dirRaw: OrderByValue) => {
    if (!SAFE.test(col)) return;  // 静默丢弃不安全列名,绝不拼进 SQL
    const dir = String(dirRaw).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    parts.push(`\`${col}\` ${dir}`);
  };
  const handleStr = (s: string) => {
    // 'createdAt DESC' / 'createdAt'
    const m = s.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(ASC|DESC|asc|desc)?$/);
    if (m) pushPair(m[1], m[2] || 'ASC');
  };
  if (typeof raw === 'string') handleStr(raw);
  else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') handleStr(item);
      else if (item && typeof item === 'object') {
        for (const [k, v] of Object.entries(item)) pushPair(k, v);
      }
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) pushPair(k, v);
  }
  return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : defaultClause;
}

interface FindAllResult {
  list: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

export class BaseModel {
  private baseTableName: string;
  /**
   * Optional metadata entity bound via withMeta(). When set, create()/update()
   * automatically validate against field + cross-field constraints. Failures
   * throw ValidationError, which controllers should catch and return as
   * { success: false, message, statusCode: 400 }.
   */
  private boundEntity: MetaEntity | null = null;

  constructor(tableName: string) {
    // Store the base table name (e.g., 'mock__order')
    this.baseTableName = tableName;
  }

  /**
   * Bind this model to the entity in `{moduleName}/_meta.json` whose tableName
   * matches this model's table (or, if no exact match, the first entity).
   * Once bound, create()/update() perform automatic validation against the
   * declared field + cross-field constraints. If the meta file doesn't exist
   * the model degrades gracefully (no validation), preserving back-compat.
   */
  withMeta(moduleName: string): this {
    const ctx = mockContext.getStore();
    // We can be called outside mockContext (controllers run inside it, but
    // module loading happens at import time). Use getStore() lazily in get
    // path; meta lookup itself doesn't need userId.
    const userIdHint = ctx?.userId ?? 1;
    const metaPath = join(GENERATED_DIR, String(userIdHint), moduleName, '_meta.json');
    if (!existsSync(metaPath)) return this;
    try {
      const meta = normalizeMeta(JSON.parse(readFileSync(metaPath, 'utf-8')));
      const entities = getEntities(meta);
      // Forgiving match: accept any of
      //   new BaseModel('mock__Item')  → tableName exact
      //   new BaseModel('Item')         → entity.name exact (bare form)
      //   new BaseModel('Item')         → "mock__Item" === entity.tableName
      // This unsticks multi-entity AI-generated controllers that pass bare entity names.
      const bare = this.baseTableName.replace(/^mock__/, '');
      const matched = entities.find(e =>
        e.tableName === this.baseTableName
        || e.tableName === `mock__${this.baseTableName}`
        || e.name === this.baseTableName
        || e.name === bare
      ) || entities[0];
      if (matched) this.boundEntity = matched;
    } catch { /* malformed meta — silently skip validation */ }
    return this;
  }

  /**
   * Coerce a DB row's columns back to the types declared in _meta, so the API
   * output matches the contract regardless of how the controller was written:
   *   - boolean fields: SQLite stores 0/1 → emit false/true
   *   - json/array/object fields: stored as JSON text → emit the parsed value
   * Only runs when withMeta() bound an entity; unknown/scalar columns pass through
   * untouched. Idempotent: a value already of the target type is left as-is, so
   * controllers that also coerce by hand keep working.
   */
  private hydrateRow<T extends Record<string, unknown> | null>(row: T): T {
    if (!row || !this.boundEntity?.fields) return row;
    for (const f of this.boundEntity.fields) {
      if (!(f.name in row)) continue;
      const v = (row as Record<string, unknown>)[f.name];
      if (v === null || v === undefined) continue;
      const type = String(f.type || '').toLowerCase();
      if (type === 'boolean' || type === 'bool') {
        if (typeof v === 'number') (row as Record<string, unknown>)[f.name] = v !== 0;
        else if (typeof v === 'string') (row as Record<string, unknown>)[f.name] = v === '1' || v.toLowerCase() === 'true';
      } else if (type === 'json' || type === 'array' || type === 'object' || type === 'list') {
        if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
          try { (row as Record<string, unknown>)[f.name] = JSON.parse(v); } catch { /* leave raw */ }
        }
      }
    }
    return row;
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

  /** If meta is bound, throw ValidationError on constraint failure. No-op otherwise. */
  private maybeValidate(data: Record<string, unknown>, ctx: 'create' | 'update', existingRow?: Record<string, unknown> | null): void {
    if (!this.boundEntity) return;
    validate(this.boundEntity, data, { context: ctx, existingRow });
    // unique check: only on create (update would need exclusion of self by id;
    // can be added later if needed). Falls back to DB UNIQUE constraint if
    // schema.sql declares it.
    if (ctx === 'create') {
      for (const f of this.boundEntity.fields || []) {
        if (!f.unique) continue;
        if (!(f.name in data)) continue;
        const v = data[f.name];
        if (v === null || v === undefined) continue;
        const tableName = this.getTableName();
        const dup = sqlite.prepare(
          `SELECT id FROM \`${tableName}\` WHERE \`${f.name}\` = ? LIMIT 1`
        ).get(v as string | number);
        if (dup) {
          throw new ValidationError(
            `${f.displayName || f.name}已存在(${String(v)})`,
            f.name,
          );
        }
      }
    }
  }

  /** Re-load the bound entity from _meta.json. Useful if AI rewrote the file mid-test. */
  reloadMeta(moduleName: string): this {
    this.boundEntity = null;
    return this.withMeta(moduleName);
  }

  /** Real column names of this table (empty set if the table doesn't exist). */
  private tableColumns(): Set<string> {
    try {
      const cols = sqlite.prepare(`PRAGMA table_info(\`${this.getTableName()}\`)`).all() as Array<{ name: string }>;
      return new Set(cols.map(c => c.name));
    } catch {
      return new Set();
    }
  }

  /** Build WHERE clause from conditions */
  private buildWhere(where?: Record<string, unknown>): { clause: string; params: unknown[] } {
    if (!where || Object.keys(where).length === 0) {
      return { clause: '', params: [] };
    }

    // Drop filter keys that aren't real columns. Controllers commonly forward the
    // whole query string into `where` (const {page,pageSize,...where}=req.query),
    // so junk params (pageNumber, itemsPerPage, _t cache-busters, etc.) would
    // otherwise produce "no such column" 500s. A mock server should be forgiving:
    // ignore unknown filters rather than crash the list endpoint.
    const cols = this.tableColumns();
    if (cols.size > 0) {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(where)) if (cols.has(k)) filtered[k] = v;
      where = filtered;
      if (Object.keys(where).length === 0) return { clause: '', params: [] };
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
    const orderBy = normalizeOrderBy(options.orderBy, 'ORDER BY `id` DESC');

    const countSql = `SELECT COUNT(*) as count FROM \`${tableName}\` ${whereClause}`;
    const countResult = sqlite.prepare(countSql).get(...whereParams) as { count: number };
    const total = countResult?.count ?? 0;

    const dataSql = `SELECT * FROM \`${tableName}\` ${whereClause} ${orderBy} LIMIT ? OFFSET ?`;
    const rows = sqlite.prepare(dataSql).all(...whereParams, pageSize, offset) as Record<string, unknown>[];

    return {
      list: rows.map(r => this.hydrateRow(r)),
      total,
      page,
      pageSize,
    };
  }

  findById(id: number): Record<string, unknown> | null {
    const tableName = this.getTableName();
    const row = sqlite.prepare(`SELECT * FROM \`${tableName}\` WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return this.hydrateRow(row ?? null);
  }

  create(data: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.getTableName();
    const cleanData = { ...data };

    // Step-Loosen 修复:detect PK column from PRAGMA table_info,而不是硬假设是 id。
    // 实测场景:SupplierHotel 用 supplierHotelCode(TEXT)作为 PK,OwnerCandidate 用 userId(INTEGER)。
    // 此前硬 `delete cleanData.id` + findById(lastInsertRowid) 在这些表上必坏:
    //   - 无 id 列 → findById 查 "WHERE id = ?" → "no such column: id"
    //   - 非 ROWID alias 的 PK → lastInsertRowid = 0
    const pragmaCols = sqlite.prepare(`PRAGMA table_info(\`${tableName}\`)`).all() as Array<{ name: string; type: string; pk: number; notnull: number }>;
    const pkCols = pragmaCols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const isIdRowidAlias =
      pkCols.length === 1 && pkCols[0].name === 'id' && /INTEGER/i.test(pkCols[0].type);

    if (isIdRowidAlias) {
      // 经典 AUTOINCREMENT 路径:用户不能传 id;lastInsertRowid 是正确 PK
      delete cleanData.id;
    }

    this.maybeValidate(cleanData, 'create');

    const columns = Object.keys(cleanData);
    const placeholders = columns.map(() => '?').join(', ');
    const values = Object.values(cleanData).map(normalizeBindValue);

    const sql = `INSERT INTO \`${tableName}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES (${placeholders})`;
    const result = sqlite.prepare(sql).run(...values);

    if (isIdRowidAlias) {
      const insertId = result.lastInsertRowid;
      if (insertId == null || insertId === 0n || insertId === 0) {
        throw new Error(
          `BaseModel.create: insert into "${tableName}" returned no auto-incremented id `
          + `(lastInsertRowid=${insertId}). Most likely schema.sql declares `
          + `"id TEXT PRIMARY KEY" — change it to "id INTEGER PRIMARY KEY AUTOINCREMENT" and re-run.`
        );
      }
      const created = this.findById(Number(insertId));
      if (!created) {
        throw new Error(
          `BaseModel.create: row with id=${insertId} not found after INSERT. `
          + `Check that the table's id column is INTEGER PRIMARY KEY AUTOINCREMENT.`
        );
      }
      return created;
    }

    // 非 id-rowid-alias PK:用 PK 列(可能是 single 也可能是 composite)做 SELECT 拿回完整行。
    // 用户的 cleanData 里必然有这些 PK 字段(否则 INSERT 会因 NOT NULL 失败)。
    if (pkCols.length === 0) {
      // 无显式 PK 列(罕见,通常是 AUTOINCREMENT rowid 但 schema 没 INTEGER PRIMARY KEY) — 直接返 cleanData
      return cleanData;
    }
    const pkWhere = pkCols.map(c => `\`${c.name}\` = ?`).join(' AND ');
    const pkValues = pkCols.map(c => cleanData[c.name]);
    const found = sqlite.prepare(`SELECT * FROM \`${tableName}\` WHERE ${pkWhere}`).get(...(pkValues as any[])) as Record<string, unknown> | undefined;
    return found ?? cleanData;
  }

  update(id: number | string, data: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.getTableName();
    const numId = typeof id === 'string' ? Number(id) : id;
    const cleanData = { ...data };

    // 主键 id 不允许 update,其它字段全透传。时间戳刷新交给 controller 显式赋值
    // 或 schema UPDATE TRIGGER。
    delete cleanData.id;

    // Auto-validate (partial-merge with existing row so cross-field rules see
    // the post-update state, not just the patch fragment)
    if (this.boundEntity) {
      const existing = this.findById(numId);
      this.maybeValidate(cleanData, 'update', existing);
    }

    // 空 patch 直接返当前行,避免空 SET 子句让 SQL 报错
    if (Object.keys(cleanData).length === 0) {
      return this.findById(numId)!;
    }

    const setClauses = Object.keys(cleanData).map(c => `\`${c}\` = ?`).join(', ');
    const values = Object.values(cleanData).map(normalizeBindValue);

    const sql = `UPDATE \`${tableName}\` SET ${setClauses} WHERE id = ?`;
    sqlite.prepare(sql).run(...values, numId);

    return this.findById(numId)!;
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
    // 与 write-file 的 schema.sql 注入对称:AI 写 controller raw SQL 时只能用 bare 表名
    // (无法预知 runtime userId),框架在这一层自动改写成 `mock__{userId}_Xxx`。
    const ctx = mockContext.getStore();
    if (!ctx) {
      throw new Error('BaseModel.raw: mockContext not set. mock-router must wrap controller dispatch in mockContext.run({ userId }).');
    }
    return sqlite.prepare(injectUserIdToTableNames(sql, ctx.userId)).all(...params);
  }

  // ==================== Outward-facing aliases (Step-Fix-1.6) ====================
  //
  // mock-router dispatches to controller exports named list/getById/create/update/remove
  // (the outward HTTP-layer convention). When controllers delegate to BaseModel,
  // AI-generated code frequently mirrors that same naming on BaseModel itself
  // (e.g. `model.list(req.query)` / `model.getById(req.params.id)` / `model.remove(id)`).
  //
  // Historically BaseModel only exposed inward DB-style names (findAll/findById/delete),
  // so those AI-generated controllers 500'd at first request. Adding the aliases makes
  // BaseModel accept both conventions, eliminating an entire class of generation errors
  // without touching the single-entity helper module that uses findAll/findById/delete.

  /** Alias for findAll — accepts the same options, returns the same { list, total, page, pageSize }. */
  list(options: FindAllOptions = {}): FindAllResult {
    return this.findAll(options);
  }

  /** Alias for findById — accepts number or numeric string (URL params). */
  getById(id: number | string): Record<string, unknown> | null {
    const n = typeof id === 'string' ? Number(id) : id;
    return this.findById(n);
  }

  /** Alias for delete — accepts number or numeric string. */
  remove(id: number | string): boolean {
    const n = typeof id === 'string' ? Number(id) : id;
    return this.delete(n);
  }

  // Raw SQL aliases — 适配 AI 常写的 rawQuery/query 命名,委托给 raw()。
  // 注:userId 注入依赖外层 mockContext,SQL 里表名要写明 mock__{userId}_xxx。

  rawQuery(sql: string, params: unknown[] = []): unknown[] {
    return this.raw(sql, params);
  }

  query(sql: string, params: unknown[] = []): unknown[] {
    return this.raw(sql, params);
  }
}
