/** Wipe ALL test modules for user_id=1: tables, module rows, sessions, files. */
const Database = require('better-sqlite3');
const fs = require('fs');
const { resolve, join } = require('path');

const db = new Database('data/mockforge.db');

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mock__1_%'`).all();
for (const t of tables) {
  db.exec('DROP TABLE IF EXISTS `' + t.name + '`');
  console.log('DROP', t.name);
}

const modR = db.prepare(`DELETE FROM modules WHERE user_id = 1`).run();
console.log('Deleted modules:', modR.changes);

const sesR = db.prepare(`UPDATE sessions SET run_status = 'done' WHERE run_status = 'running'`).run();
console.log('Cleared running sessions:', sesR.changes);

db.close();

const dir = resolve('generated', '1');
if (fs.existsSync(dir)) {
  for (const sub of fs.readdirSync(dir)) {
    const subPath = join(dir, sub);
    if (fs.statSync(subPath).isDirectory()) {
      fs.rmSync(subPath, { recursive: true, force: true });
      console.log('RMDIR', subPath);
    }
  }
}

console.log('\n✓ All modules wiped.');
