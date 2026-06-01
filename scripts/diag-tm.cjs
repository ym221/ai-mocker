const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database('data/mockforge.db');

const tables = ['mock__1_DirectHotelFinance', 'mock__1_SupplierHotel', 'mock__1_OwnerCandidate', 'mock__1_ExportTask'];

for (const t of tables) {
  console.log('\n=== ' + t + ' ===');
  const cnt = db.prepare('SELECT COUNT(*) as c FROM `' + t + '`').get();
  console.log('  rows:', cnt.c);
  const cols = db.prepare('PRAGMA table_info(`' + t + '`)').all();
  console.log('  cols:', cols.map(c => c.name + ':' + c.type + (c.notnull ? '!N' : '')).join(', '));
}

console.log('\n=== Try manual INSERT into mock__1_OwnerCandidate ===');
try {
  const res = db.prepare(`INSERT OR IGNORE INTO mock__1_OwnerCandidate (userId, userName, fullName, departmentId, departmentName) VALUES (?, ?, ?, ?, ?)`)
    .run(99, 'test', '测试', 1, '直签部');
  console.log('  inserted:', res.changes, 'rows');
} catch (e) {
  console.log('  ERROR:', e.message);
}

console.log('\n=== Re-run schema.sql line by line ===');
const sql = fs.readFileSync('generated/1/tm_reconcile/schema.sql', 'utf-8');
// Replace mock__ -> mock__1_
const injected = sql.replace(/mock__([A-Z][a-zA-Z0-9_]*)/g, 'mock__1_$1');
// Try as transaction
try {
  db.exec(injected);
  console.log('  re-exec OK');
} catch (e) {
  console.log('  RE-EXEC ERROR:', e.message);
}

console.log('\n=== After re-exec, row counts ===');
for (const t of tables) {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM `' + t + '`').get();
  console.log('  ' + t + ':', cnt.c);
}

db.close();
