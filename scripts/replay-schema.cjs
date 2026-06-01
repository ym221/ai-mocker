const Database = require('better-sqlite3');
const fs = require('fs');

const db = new Database('data/mockforge.db');
const sql = fs.readFileSync('generated/1/tm_reconcile/schema.sql', 'utf-8');

// Inject userId — same as framework does
const injected = sql.replace(/`mock__(?!\d+_)([a-zA-Z][a-zA-Z0-9_]*)`/g, `\`mock__1_$1\``)
  .replace(/(?<![`\w])mock__(?!\d+_)([a-zA-Z][a-zA-Z0-9_]*)(?![`\w])/g, `mock__1_$1`);

// Drop tables first
for (const t of ['DirectHotelFinance', 'SupplierHotel', 'OwnerCandidate', 'ExportTask']) {
  db.exec(`DROP TABLE IF EXISTS \`mock__1_${t}\``);
}

// Split into statements (naive on ; outside parens)
const stmts = [];
let buf = '';
let depth = 0;
for (const ch of injected) {
  if (ch === '(') depth++;
  if (ch === ')') depth--;
  buf += ch;
  if (ch === ';' && depth === 0) {
    if (buf.trim()) stmts.push(buf.trim());
    buf = '';
  }
}
if (buf.trim()) stmts.push(buf.trim());

console.log(`Total statements: ${stmts.length}`);
let ok = 0, fail = 0;
for (let i = 0; i < stmts.length; i++) {
  const s = stmts[i];
  try {
    db.exec(s);
    ok++;
    const kind = s.split(/\s+/)[0].toUpperCase();
    if (kind === 'INSERT' || kind === 'CREATE') {
      const tableMatch = s.match(/(?:INTO|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+`?(\w+)`?/i);
      console.log(`  [${i}] OK ${kind} ${tableMatch?.[1] || '?'}`);
    }
  } catch (e) {
    fail++;
    console.log(`  [${i}] FAIL: ${e.message.slice(0,200)}`);
    console.log(`    stmt: ${s.slice(0, 200)}`);
  }
}
console.log(`\n${ok} ok, ${fail} failed`);

console.log('\n=== Row counts ===');
for (const t of ['DirectHotelFinance', 'SupplierHotel', 'OwnerCandidate', 'ExportTask']) {
  try {
    const c = db.prepare(`SELECT COUNT(*) as c FROM \`mock__1_${t}\``).get();
    console.log(`  mock__1_${t}: ${c.c}`);
  } catch (e) { console.log(`  mock__1_${t}: err ${e.message}`); }
}

db.close();
