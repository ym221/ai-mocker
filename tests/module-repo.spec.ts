/**
 * Task M2.3 — module-repo unit tests.
 */
import { test, expect } from '@playwright/test';
import { join, resolve } from 'path';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { waitForBackend } from './helpers';
import {
  getModuleRow, moduleExists, moduleDir, moduleFilePath, readModuleFile, loadMeta,
} from '../src/server/core/module-repo';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const USER_ID = 1;
const MODULE = 'module_repo_test_mod';
const MOD_DIR = resolve(process.cwd(), 'generated', String(USER_ID), MODULE);

function cleanFixture() {
  if (existsSync(MOD_DIR)) rmSync(MOD_DIR, { recursive: true, force: true });
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
  } finally { db.close(); }
}

function seedFixture() {
  mkdirSync(MOD_DIR, { recursive: true });
  writeFileSync(join(MOD_DIR, '_meta.json'), JSON.stringify({
    name: MODULE, displayName: 'Test', basePath: `/mock/${MODULE}`,
    entities: [{ name: MODULE, tableName: `mock__${MODULE}`, fields: [] }],
    endpoints: [],
  }), 'utf-8');
  writeFileSync(join(MOD_DIR, 'controller.ts'), '// stub', 'utf-8');

  const db = new Database(DB_PATH);
  try {
    db.prepare(
      `INSERT INTO modules (name, user_id, display_name, description, base_path, status)
       VALUES (?, ?, ?, '', ?, 'active')`,
    ).run(MODULE, USER_ID, 'Test', `/mock/${MODULE}`);
  } finally { db.close(); }
}

test.beforeAll(async () => { await waitForBackend(); });

test.describe('Task M2.3 — module-repo', () => {
  test.beforeEach(() => { cleanFixture(); seedFixture(); });
  test.afterAll(() => cleanFixture());

  test('MR01 getModuleRow 返回正确行, moduleExists=true', () => {
    const row = getModuleRow(USER_ID, MODULE);
    expect(row).not.toBeNull();
    expect(row!.name).toBe(MODULE);
    expect(moduleExists(USER_ID, MODULE)).toBe(true);
  });

  test('MR02 getModuleRow 对不存在的模块返 null, moduleExists=false', () => {
    expect(getModuleRow(USER_ID, '__absent__')).toBeNull();
    expect(moduleExists(USER_ID, '__absent__')).toBe(false);
  });

  test('MR03 moduleDir + moduleFilePath 指向正确位置', () => {
    expect(moduleDir(USER_ID, MODULE)).toBe(MOD_DIR);
    expect(moduleFilePath(USER_ID, MODULE, 'x.md')).toBe(join(MOD_DIR, 'x.md'));
  });

  test('MR04 readModuleFile 读到文件内容, 不存在返 null', () => {
    expect(readModuleFile(USER_ID, MODULE, 'controller.ts')).toBe('// stub');
    expect(readModuleFile(USER_ID, MODULE, 'nonexistent.md')).toBeNull();
  });

  test('MR05 readModuleFile maxBytes 限制大小', () => {
    writeFileSync(join(MOD_DIR, 'big.md'), 'A'.repeat(1000), 'utf-8');
    expect(readModuleFile(USER_ID, MODULE, 'big.md', 100)!.length).toBe(100);
    expect(readModuleFile(USER_ID, MODULE, 'big.md')!.length).toBe(1000);
  });

  test('MR06 loadMeta 解析 _meta.json, 不存在/非法 JSON 返 null', () => {
    const meta = loadMeta(USER_ID, MODULE);
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe(MODULE);

    // overwrite with invalid JSON
    writeFileSync(join(MOD_DIR, '_meta.json'), 'not json', 'utf-8');
    expect(loadMeta(USER_ID, MODULE)).toBeNull();
  });
});
