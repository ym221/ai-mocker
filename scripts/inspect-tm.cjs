const Database = require('better-sqlite3');
const db = new Database('data/mockforge.db');
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mock__1_%'`).all();
console.log('All mock tables:', tables.map(t => t.name).join(', '));
const interesting = tables.filter(t =>
  t.name.includes('tm_reconcile') ||
  t.name.includes('Direct') || t.name.includes('direct') ||
  t.name.includes('Supplier') || t.name.includes('supplier') ||
  t.name.includes('Owner') || t.name.includes('owner') ||
  t.name.includes('Export') || t.name.includes('export')
);
console.log('\n--- Tables related to tm_reconcile ---');
for (const t of interesting) {
  try {
    const cnt = db.prepare('SELECT COUNT(*) as c FROM `' + t.name + '`').get();
    console.log('  ' + t.name + ': ' + cnt.c + ' rows');
    if (cnt.c > 0 && cnt.c < 5) {
      const rows = db.prepare('SELECT * FROM `' + t.name + '` LIMIT 2').all();
      console.log('    sample:', JSON.stringify(rows[0]).slice(0, 200));
    }
  } catch (e) {
    console.log('  ' + t.name + ': error - ' + e.message);
  }
}
db.close();
