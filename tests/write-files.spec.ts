/**
 * Task M1.2 — batch write_files 单元测试.
 *
 * 验证:
 * - WF01 一次写 5 个文件,磁盘可见 + SQL 表建好 + _meta.json 同步到 modules 表
 * - WF02 中间 SQL 失败 → 整批回滚,磁盘恢复原状,modules 表不受影响
 * - WF03 二次写同一组文件 === overwrite 语义,schema 有新列自动 ALTER
 * - WF04 路径穿越攻击被拒,整批不写
 * - WF05 _meta.json 解析失败不破坏整批(soft warning 兼容 write_file 旧行为)
 */
import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resolve, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { waitForBackend } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const USER_ID = 1;
const MODULE = 'wf_test_mod';
const MOD_DIR = resolve(process.cwd(), 'generated', String(USER_ID), MODULE);

function cleanFixture() {
  // Remove module dir
  if (existsSync(MOD_DIR)) rmSync(MOD_DIR, { recursive: true, force: true });
  // Remove modules row + physical table
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(MODULE, USER_ID);
    db.exec(`DROP TABLE IF EXISTS mock__${USER_ID}_${MODULE}`);
  } finally { db.close(); }
}

function buildFiveFiles() {
  return [
    {
      path: `${MODULE}/schema.sql`,
      content: `CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`title\` TEXT NOT NULL,
  \`done\` INTEGER DEFAULT 0
);`,
    },
    {
      path: `${MODULE}/_meta.json`,
      content: JSON.stringify({
        name: MODULE,
        displayName: 'WF Test',
        description: 'batch test module',
        basePath: `/mock/${MODULE}`,
        version: 1,
        status: 'active',
        entities: [{
          name: MODULE,
          tableName: `mock__${MODULE}`,
          displayName: 'WF',
          fields: [
            { name: 'title', type: 'string', required: true },
            { name: 'done', type: 'boolean', required: false, default: false },
          ],
        }],
        endpoints: [
          { method: 'GET', path: '/', name: '列表', type: 'list' },
          { method: 'POST', path: '/', name: '创建', type: 'create' },
        ],
      }, null, 2),
    },
    { path: `${MODULE}/controller.ts`, content: `export function list() { return { success: true, data: [] }; }` },
    { path: `${MODULE}/test.ts`, content: `// placeholder` },
    { path: `${MODULE}/api-doc.md`, content: `# ${MODULE}\nTest module.` },
  ];
}

test.beforeAll(async () => { await waitForBackend(); });

test.describe('Task M1.2 — batch write_files', () => {
  test.beforeEach(() => cleanFixture());
  test.afterAll(() => cleanFixture());

  test('WF01 一次写 5 个文件 → 磁盘 + SQL 表 + modules 行都建好', async () => {
    const { writeFiles } = await import('../src/server/agent/tools/write-files.js');
    const r = await writeFiles(USER_ID, { files: buildFiveFiles() });

    expect(r.success).toBe(true);
    expect(r.filesWritten).toBe(5);

    // All 5 files on disk
    for (const f of buildFiveFiles()) {
      const p = resolve(process.cwd(), 'generated', String(USER_ID), f.path);
      expect(existsSync(p)).toBe(true);
    }

    // Physical table exists
    const db = new Database(DB_PATH);
    try {
      const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(`mock__${USER_ID}_${MODULE}`) as { name: string } | undefined;
      expect(tbl?.name).toBe(`mock__${USER_ID}_${MODULE}`);

      // modules row synced
      const mod = db.prepare(`SELECT name, display_name FROM modules WHERE name = ? AND user_id = ?`)
        .get(MODULE, USER_ID) as { name: string; display_name: string } | undefined;
      expect(mod?.name).toBe(MODULE);
      expect(mod?.display_name).toBe('WF Test');
    } finally { db.close(); }
  });

  test('WF02 SQL 执行失败 → 整批回滚, 磁盘和 DB 都不变', async () => {
    const { writeFiles } = await import('../src/server/agent/tools/write-files.js');

    // Pre-populate ONE file with known content so we can detect restoration
    mkdirSync(MOD_DIR, { recursive: true });
    const keepPath = join(MOD_DIR, 'keep.md');
    writeFileSync(keepPath, 'original content', 'utf-8');

    const files = [
      { path: `${MODULE}/keep.md`, content: 'NEW CONTENT (should be rolled back)' },
      // intentionally broken SQL — will fail exec
      { path: `${MODULE}/schema.sql`, content: 'THIS IS NOT VALID SQL ;;;' },
      { path: `${MODULE}/controller.ts`, content: 'export function list() {}' },
    ];

    const r = await writeFiles(USER_ID, { files });
    expect(r.success).toBe(false);
    expect(r.error).toContain('SQL execution failed');

    // keep.md restored to original content
    expect(readFileSync(keepPath, 'utf-8')).toBe('original content');
    // schema.sql created during write but removed on rollback (didn't exist before)
    expect(existsSync(join(MOD_DIR, 'schema.sql'))).toBe(false);
    // controller.ts also rolled back
    expect(existsSync(join(MOD_DIR, 'controller.ts'))).toBe(false);

    // modules row NOT created (transaction rolled back)
    const db = new Database(DB_PATH);
    try {
      const mod = db.prepare(`SELECT name FROM modules WHERE name = ? AND user_id = ?`)
        .get(MODULE, USER_ID) as { name: string } | undefined;
      expect(mod).toBeUndefined();
    } finally { db.close(); }
  });

  test('WF03 二次写同组文件 = overwrite + schema ALTER 新列', async () => {
    const { writeFiles } = await import('../src/server/agent/tools/write-files.js');

    // First write
    const r1 = await writeFiles(USER_ID, { files: buildFiveFiles() });
    expect(r1.success).toBe(true);

    // Second write: add a new column in schema + bump displayName in meta
    const v2 = buildFiveFiles();
    v2[0].content = `CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`title\` TEXT NOT NULL,
  \`done\` INTEGER DEFAULT 0,
  \`priority\` INTEGER DEFAULT 0
);`;
    const meta = JSON.parse(v2[1].content);
    meta.displayName = 'WF Test v2';
    v2[1].content = JSON.stringify(meta, null, 2);

    const r2 = await writeFiles(USER_ID, { files: v2 });
    expect(r2.success).toBe(true);

    // Physical table should have the new priority column
    const db = new Database(DB_PATH);
    try {
      const cols = db.prepare(`PRAGMA table_info(\`mock__${USER_ID}_${MODULE}\`)`).all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('priority');

      // modules row updated
      const mod = db.prepare(`SELECT display_name FROM modules WHERE name = ? AND user_id = ?`)
        .get(MODULE, USER_ID) as { display_name: string };
      expect(mod.display_name).toBe('WF Test v2');
    } finally { db.close(); }

    // Per-file note should mention reconcile
    const sqlFile = r2.perFile.find(p => p.path.endsWith('schema.sql'));
    expect(sqlFile?.note).toContain('+column');
  });

  test('WF04 路径穿越 → 整批拒绝, 即便其他路径合法', async () => {
    const { writeFiles } = await import('../src/server/agent/tools/write-files.js');

    const r = await writeFiles(USER_ID, {
      files: [
        { path: `${MODULE}/ok.md`, content: 'ok' },
        { path: `../../../etc/passwd`, content: 'evil' },
      ],
    });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/traversal|within/);
    // ok.md must NOT exist — batch aborted before any write
    expect(existsSync(join(MOD_DIR, 'ok.md'))).toBe(false);
  });

  test('WF05 _meta.json 解析失败 = soft warning, 其他文件正常落地', async () => {
    const { writeFiles } = await import('../src/server/agent/tools/write-files.js');

    const files = [
      {
        path: `${MODULE}/schema.sql`,
        content: `CREATE TABLE IF NOT EXISTS \`mock__${MODULE}\` (\`id\` INTEGER PRIMARY KEY AUTOINCREMENT, \`name\` TEXT);`,
      },
      { path: `${MODULE}/_meta.json`, content: 'this is not json' },
      { path: `${MODULE}/controller.ts`, content: `// ok` },
    ];

    const r = await writeFiles(USER_ID, { files });
    expect(r.success).toBe(true);  // meta parse failure is soft
    expect(r.filesWritten).toBe(3);

    // _meta.json file still written (disk write doesn't validate JSON)
    expect(existsSync(join(MOD_DIR, '_meta.json'))).toBe(true);
    expect(readFileSync(join(MOD_DIR, '_meta.json'), 'utf-8')).toBe('this is not json');

    // Warnings captured in perFile
    const metaFile = r.perFile.find(p => p.path.endsWith('_meta.json'));
    expect(metaFile?.warnings?.length ?? 0).toBeGreaterThan(0);
  });

  test('WF06 空 files 数组 → 错误信息引导 AI 切换到 write_file', async () => {
    const { writeFiles } = await import('../src/server/agent/tools/write-files.js');
    const r = await writeFiles(USER_ID, { files: [] });
    expect(r.success).toBe(false);
    expect(r.message).toContain('write_file(path, content)');  // explicit fallback hint
    expect(r.message).toMatch(/schema is \{ files: \[/);        // shows correct schema
    expect(r.error).toContain('switch to write_file');
  });
});
