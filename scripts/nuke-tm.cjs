const Database = require('better-sqlite3');
const fs = require('fs');
const { resolve } = require('path');
const db = new Database('data/mockforge.db');

// Drop all tm_reconcile related stuff: tables (any casing), module row, files
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%direct_hotel%' OR name LIKE '%DirectHotel%' OR name LIKE '%supplier_hotel%' OR name LIKE '%SupplierHotel%' OR name LIKE '%owner_candidate%' OR name LIKE '%OwnerCandidate%' OR name LIKE '%export_task%' OR name LIKE '%ExportTask%' OR name LIKE '%tm_reconcile%')`).all();
for (const t of tables) {
  console.log('DROP TABLE', t.name);
  db.exec('DROP TABLE IF EXISTS `' + t.name + '`');
}
const r = db.prepare(`DELETE FROM modules WHERE name = ? AND user_id = 1`).run('tm_reconcile');
console.log('Deleted module rows:', r.changes);
const s = db.prepare(`UPDATE sessions SET run_status = 'done' WHERE module_name = ? AND run_status = 'running'`).run('tm_reconcile');
console.log('Cleared running sessions:', s.changes);
db.close();

const dir = resolve('generated', '1', 'tm_reconcile');
if (fs.existsSync(dir)) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Removed dir:', dir);
}
