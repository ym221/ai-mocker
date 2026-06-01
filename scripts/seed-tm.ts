/**
 * Iterate path validation:用 manage_data bulk_generate 给已 created 的 tm_reconcile
 * 4 个空表种数据,然后验证 mock endpoint 返回非空。
 *
 * 这是 Step-Loosen Phase 2 "ship-then-iterate" 流程的真实演示:
 *   1) create_module_from_spec 已通过(smoke pass + 17 test failures)
 *   2) 调用方通过 quality.warnings 看到细节问题(无种子)
 *   3) 用低成本工具 manage_data 修复(秒级,不走 LLM)
 *   4) 再验
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = new URL('http://localhost:3000/mcp');
const MODULE = 'tm_reconcile';

async function getKey(): Promise<string> {
  const login = await (await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json() as any;
  const token = login.data.token;
  await fetch('http://localhost:3000/api/users/me/api-key', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  const r = await (await fetch('http://localhost:3000/api/users/me/api-key', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  })).json() as any;
  return r.data.apiKey;
}

async function main() {
  const key = await getKey();
  const tr = new StreamableHTTPClientTransport(MCP_URL, { requestInit: { headers: { 'X-API-Key': key } } });
  const c = new Client({ name: 'seed-tm', version: '0.0.0' });
  await c.connect(tr);

  // Bulk-generate 5 rows for each entity
  for (const entity of ['DirectHotelFinance', 'SupplierHotel', 'OwnerCandidate', 'ExportTask']) {
    console.log(`\n--- bulk_generate ${entity} (5 rows) ---`);
    const r = await c.callTool({
      name: 'manage_data',
      arguments: { moduleName: MODULE, action: 'bulk_generate', count: 5, entityName: entity },
    }, undefined, { timeout: 30_000 });
    const sc = (r as any).structuredContent;
    console.log('  result:', JSON.stringify(sc).slice(0, 300));
  }

  await c.close();

  // Now verify endpoints
  console.log('\n=== Verify mock endpoints ===');
  for (const [m, p, body] of [
    ['GET', `/mock/${MODULE}/direct_hotel_finance_info/owner_options`, null],
    ['GET', `/mock/${MODULE}/api/get_exporders_list/ExportDirectHotelFinanceInfo`, null],
    ['POST', `/mock/${MODULE}/direct_hotel_finance_info/search`, JSON.stringify({ paginationInfo: { pageNumber: 1, itemsPerPage: 3 } })],
  ] as Array<[string, string, string|null]>) {
    const res = await fetch(`http://localhost:3000${p}`, {
      method: m,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body } : {}),
    });
    const text = await res.text();
    console.log(`\n${m} ${p}`);
    console.log(`  status: ${res.status}`);
    console.log(`  body: ${text.slice(0, 400)}`);
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
