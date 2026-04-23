/**
 * Schema reconciliation 回归测试 (Bug 2 from MCP user testing).
 *
 * 现象: AI 用 update_module 给 warehouse 加字段后,后续 POST /mock/warehouse
 * 报 "no such column: sku" — SQLite 的 CREATE TABLE IF NOT EXISTS 是 no-op,
 * 物理表新列从来没被加上。
 *
 * 修复: write-file.ts 在 exec schema.sql 之后,parse CREATE TABLE 语句,
 * diff 物理列,缺的用 ALTER TABLE ADD COLUMN 补上(保留数据)。
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const GENERATED_DIR = resolve(process.cwd(), 'generated');
const USER_ID = 1;
const MODULE = 'sr_test';

function cleanup() {
  const dir = join(GENERATED_DIR, String(USER_ID), MODULE);
  if (existsSync(dir)) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  const db = new Database(DB_PATH);
  try {
    db.exec(`DROP TABLE IF EXISTS \`mock__${USER_ID}_${MODULE}\``);
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
  } finally { db.close(); }
}

test.beforeAll(async () => { await waitForBackend(); });
test.beforeEach(() => { cleanup(); });
test.afterAll(() => cleanup());

test.describe('write-file schema reconciliation', () => {
  test('SR01 重写 schema.sql 加新列时 ALTER TABLE ADD COLUMN', async () => {
    const { writeFile } = await import('../src/server/agent/tools/write-file.js');

    // 1) 初次创建表 (a, b 两列)
    const r1 = await writeFile(USER_ID, `${MODULE}/schema.sql`, `
      CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`a\` TEXT NOT NULL,
        \`b\` TEXT,
        \`created_at\` TEXT DEFAULT (datetime('now')),
        \`updated_at\` TEXT DEFAULT (datetime('now'))
      );
    `);
    expect(r1).toContain('SQL executed');

    // 插入一行老数据
    const db1 = new Database(DB_PATH);
    try {
      db1.prepare(`INSERT INTO \`mock__${USER_ID}_${MODULE}\` (a, b) VALUES (?, ?)`).run('hello', 'world');
    } finally { db1.close(); }

    // 2) 改写 schema.sql 加 c 列 + d 列(都新加)
    const r2 = await writeFile(USER_ID, `${MODULE}/schema.sql`, `
      CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`a\` TEXT NOT NULL,
        \`b\` TEXT,
        \`c\` TEXT,
        \`d\` INTEGER DEFAULT 0,
        \`created_at\` TEXT DEFAULT (datetime('now')),
        \`updated_at\` TEXT DEFAULT (datetime('now'))
      );
    `);
    expect(r2).toContain('Schema reconciled');
    expect(r2).toContain(`+column mock__${USER_ID}_${MODULE}.c`);
    expect(r2).toContain(`+column mock__${USER_ID}_${MODULE}.d`);

    // 3) 验证物理表确实有 c + d 列,且老数据保留
    const db2 = new Database(DB_PATH);
    try {
      const cols = db2.prepare(`PRAGMA table_info(\`mock__${USER_ID}_${MODULE}\`)`).all() as Array<{ name: string }>;
      const names = cols.map(c => c.name);
      expect(names).toContain('a');
      expect(names).toContain('b');
      expect(names).toContain('c');
      expect(names).toContain('d');

      // 老数据还在
      const row = db2.prepare(`SELECT * FROM \`mock__${USER_ID}_${MODULE}\` WHERE a = ?`).get('hello') as any;
      expect(row).toBeTruthy();
      expect(row.b).toBe('world');
      expect(row.c).toBeNull();
      expect(row.d).toBe(0);

      // 4) 验证 INSERT 新行使用新列工作 (这是 user 报告 "no such column" 修复点)
      db2.prepare(`INSERT INTO \`mock__${USER_ID}_${MODULE}\` (a, b, c, d) VALUES (?, ?, ?, ?)`)
        .run('new', 'row', 'extra', 99);
      const newRow = db2.prepare(`SELECT * FROM \`mock__${USER_ID}_${MODULE}\` WHERE a = ?`).get('new') as any;
      expect(newRow.c).toBe('extra');
      expect(newRow.d).toBe(99);
    } finally { db2.close(); }
  });

  test('SR02 加 NOT NULL 新列(无 DEFAULT)→ 自动转为 NULL-able + warning', async () => {
    const { writeFile } = await import('../src/server/agent/tools/write-file.js');

    await writeFile(USER_ID, `${MODULE}/schema.sql`, `
      CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`a\` TEXT
      );
    `);
    // 插入一行旧数据
    const db1 = new Database(DB_PATH);
    try { db1.prepare(`INSERT INTO \`mock__${USER_ID}_${MODULE}\` (a) VALUES ('x')`).run(); } finally { db1.close(); }

    // 加 NOT NULL 列 (无 DEFAULT) — SQLite 不允许直接 ADD,需要剥 NOT NULL
    const r = await writeFile(USER_ID, `${MODULE}/schema.sql`, `
      CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`a\` TEXT,
        \`required_field\` TEXT NOT NULL
      );
    `);
    expect(r).toContain('+column');
    expect(r).toContain('NULL-able');  // warning 提示

    // 物理表确实有该列且为 NULL-able
    const db2 = new Database(DB_PATH);
    try {
      const cols = db2.prepare(`PRAGMA table_info(\`mock__${USER_ID}_${MODULE}\`)`).all() as Array<{ name: string; notnull: number }>;
      const required = cols.find(c => c.name === 'required_field');
      expect(required).toBeTruthy();
      expect(required!.notnull).toBe(0);  // NOT NULL 被剥掉了
    } finally { db2.close(); }
  });

  test('SR03 表不存在时 schema 正常创建 (无 reconcile noise)', async () => {
    const { writeFile } = await import('../src/server/agent/tools/write-file.js');

    const r = await writeFile(USER_ID, `${MODULE}/schema.sql`, `
      CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`name\` TEXT
      );
    `);
    expect(r).toContain('SQL executed');
    // 第一次创建 — reconcile 没东西可对账,不该出 "+column" 行
    expect(r).not.toContain('Schema reconciled');

    const db = new Database(DB_PATH);
    try {
      const cols = db.prepare(`PRAGMA table_info(\`mock__${USER_ID}_${MODULE}\`)`).all() as Array<{ name: string }>;
      expect(cols.map(c => c.name)).toContain('name');
    } finally { db.close(); }
  });

  test('SR04 schema 没变化 → no-op', async () => {
    const { writeFile } = await import('../src/server/agent/tools/write-file.js');
    const sql = `
      CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`a\` TEXT
      );
    `;
    await writeFile(USER_ID, `${MODULE}/schema.sql`, sql);
    const r2 = await writeFile(USER_ID, `${MODULE}/schema.sql`, sql);
    // 不应有 "+column" 输出
    expect(r2).not.toContain('+column');
  });

  test('SR05 删除字段(仅 schema.sql 移除)→ 物理列保留 + warning', async () => {
    const { writeFile } = await import('../src/server/agent/tools/write-file.js');

    // 初始有 a, b, c
    await writeFile(USER_ID, `${MODULE}/schema.sql`, `
      CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`a\` TEXT, \`b\` TEXT, \`c\` TEXT
      );
    `);
    // 改成只保留 a (b, c 在新 schema 里"消失")
    const r = await writeFile(USER_ID, `${MODULE}/schema.sql`, `
      CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`a\` TEXT
      );
    `);
    expect(r).toContain('Warnings');
    expect(r).toMatch(/no longer in schema/);
    expect(r).toContain('.b');
    expect(r).toContain('.c');

    // 物理列 b, c 仍在 (SQLite < 3.35 无安全 DROP COLUMN; 留着无害)
    const db = new Database(DB_PATH);
    try {
      const cols = db.prepare(`PRAGMA table_info(\`mock__${USER_ID}_${MODULE}\`)`).all() as Array<{ name: string }>;
      const names = cols.map(c => c.name);
      expect(names).toContain('b');
      expect(names).toContain('c');
    } finally { db.close(); }
  });
});
