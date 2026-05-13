import { AsyncLocalStorage } from 'async_hooks';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { sqlite } from './database.js';
import { normalizeMeta, getEntities, type MetaEntity } from './meta-schema.js';
import { validate, ValidationError } from './validator.js';

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

    // id 是 AUTOINCREMENT 主键,用户不能传(否则覆盖 lastInsertRowid 语义)。
    // 其它字段一律透传:框架不再对 created_at/updated_at/createdAt/updatedAt 做特殊
    // 处理。用户/AI 想要时间戳:要么 schema.sql 写 DEFAULT CURRENT_TIMESTAMP / DEFAULT
    // (datetime('now')) 由 DB 管;要么 controller create 时显式赋值。框架不替用户决策。
    delete cleanData.id;

    // Auto-validate against bound meta (no-op if .withMeta() was never called)
    this.maybeValidate(cleanData, 'create');

    const columns = Object.keys(cleanData);
    const placeholders = columns.map(() => '?').join(', ');
    const values = Object.values(cleanData).map(normalizeBindValue);

    const sql = `INSERT INTO \`${tableName}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES (${placeholders})`;
    const result = sqlite.prepare(sql).run(...values);

    // SQLite returns lastInsertRowid=0 (not the actual rowid) when the table's
    // PRIMARY KEY isn't an INTEGER ROWID alias — the most common cause is
    // `id TEXT PRIMARY KEY` without AUTOINCREMENT. In that case findById(0)
    // returns null and the controller passes a null `data` to the wrap()
    // helper, breaking every subsequent endpoint. Detect early and surface a
    // clear, actionable error so the AI's run_test step fails loudly instead
    // of silently producing 200 + null payloads.
    const insertId = result.lastInsertRowid;
    if (insertId == null || insertId === 0n || insertId === 0) {
      throw new Error(
        `BaseModel.create: insert into "${tableName}" returned no auto-incremented id `
        + `(lastInsertRowid=${insertId}). Most likely schema.sql declares `
        + `"id TEXT PRIMARY KEY" — change it to `
        + `"id INTEGER PRIMARY KEY AUTOINCREMENT" and re-run.`
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

  update(id: number | string, data: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.getTableName();
    const numId = typeof id === 'string' ? Number(id) : id;
    const cleanData = { ...data };

    // 只剥 id(主键不允许 update)。其它字段全透传 — 框架不再硬塞 updated_at。
    // 用户/AI 想要"更新时自动刷新时间戳":controller update 时显式赋 updatedAt,
    // 或在 schema.sql 加 UPDATE TRIGGER。框架不替用户决策。
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
    return sqlite.prepare(sql).all(...params);
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

  // ==================== Raw SQL aliases ====================
  // AI 训练数据里 ORM 通常叫 rawQuery/query/exec,凭习惯写 `model.rawQuery(sql, params)`
  // 而框架原始 API 叫 `raw()` → controller 必报 "rawQuery is not a function" 500。
  // 这跟 list/getById/remove 同种"框架适应 AI 写法"的别名,不是新增能力。
  // 注:userId 注入还是依赖外层 mockContext,这些 raw 调用不绕过沙箱(只是绑同一张
  // 物理表,因为 BaseModel.raw 直接走 sqlite.prepare,sql 里要写明 mock__{userId}_xxx)。

  /** Alias for raw — AI 常写 `model.rawQuery(sql, params)`,等同于 raw()。 */
  rawQuery(sql: string, params: unknown[] = []): unknown[] {
    return this.raw(sql, params);
  }

  /** Alias for raw — AI 常写 `model.query(sql, params)`,等同于 raw()。 */
  query(sql: string, params: unknown[] = []): unknown[] {
    return this.raw(sql, params);
  }
}
