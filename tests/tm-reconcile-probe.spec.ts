/**
 * 一次性脚本:通过 MCP 用 tm_reconcile spec 创建模块,然后逐个调用 9 个接口
 * 对比 spec 期望,把每个 case 的实际响应 / status 打到控制台便于分析根因。
 * 不是常规回归测试,跑完一次就好。
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { resolve, join } from 'path';
import { existsSync, readFileSync, rmSync } from 'fs';
import { waitForBackend, getToken, apiRequest } from './helpers';

const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const MCP_URL = new URL('http://localhost:3000/mcp');
const GENERATED_DIR = resolve(process.cwd(), 'generated', '1');
const API_BASE = 'http://localhost:3000';
const MOD = 'tm_reconcile';

const SPEC = `# 直签酒店财务信息 mock

响应信封: \`{ Success: bool, Message: string, Data: any, paginationInfo?: object }\`(首字母大写)。例外 API-007 用 IsSuccess。

## 实体

### DirectHotelFinance(主表)
id(INTEGER PK 自增), kingdeeId(可空), supplierId(默认 23), supplierName(默认 "EBooking"), vendorCode, vendorName, supplierVendorLabel, sHotelId(int64), supplierHotelCode(UNIQUE), hotelName, hotelNameCn(可空), hotelDisplayName, countryCode, countryName, payeeFullName, signingEntity(enum 5 值), cooperationStatus(1=合作中,2=暂停), cooperationStatusName, firstPaymentDate(可空), cooperationMode(1=预付,2=包房,3=单结), cooperationModeName, settlementMethod(1=VCC,2=银行转账), settlementMethodName, reconciliationDimension(1=预订,2=入住,3=离店), reconciliationDimensionName, billCollectionMethod(1=酒店提供,2=我司提供), billCollectionMethodName, hotelContactEmails, productOwnerUser, productOwnerName, bdEmails, operationOwnerUser, operationOwnerName, operationEmails, payeeAddressPostcode, payeeBankName, payeeBankAccount, payeeBankAddress, swiftCodeIban, updatedBy, updatedAt, createdBy, createdAt, isDeleted(默认 0)
种子 5-10 条, 覆盖不同 signingEntity / cooperationStatus / cooperationMode / 国家。

### SupplierHotel(校验+自动带出源)
supplierHotelCode(PK,string), supplierId(23), supplierName(EBooking), vendorCode, vendorName, sHotelId(int64), hotelName, hotelNameCn, countryCode, countryName, productOwnerUser, productOwnerName, operationOwnerUser, operationOwnerName。
种子 4 条:
- tms#shengxing2 (同时插入到 DirectHotelFinance 触发重复校验)
- tms#newhotel1 / tms#newhotel2 / tms#newhotel3 (仅本表,用于新增成功流程)

### OwnerCandidate(负责人候选)
userId(int PK), userName, fullName(中文), departmentId, departmentName("直签部"/"产研")。种子 6 条 (3+3)。

### ExportTask(异步导出任务)
id(INTEGER PK 自增), file_name, http_url, applied_date(int64 毫秒时间戳), operator, status(0=导出中,1=失败,2=已完成), messages。种子 3 条 status 各 0/1/2。

## 端点

### API-001 列表查询
POST /direct_hotel_finance_info/search
body: 可选 kingdeeId / vendorCode / sHotelId / supplierHotelCode / hotelName(模糊匹配 hotelName 和 hotelNameCn) / cooperationStatus / cooperationMode / operationOwnerUser / productOwnerUser / createdAtStart / createdAtEnd(半开区间), 必填 paginationInfo: { pageNumber, itemsPerPage }
返: { Success: true, Message: "请求成功", Data: [...], paginationInfo: { pageNumber, itemsPerPage, totalItems, totalPages } }
排序: createdAt DESC

### API-002 详情查询
GET /direct_hotel_finance_info/detail?id=<id>
找到: { Success: true, Data: <主表完整字段> }
找不到: { Success: false, Message: "记录不存在" }

### API-003 供应商酒店ID 校验/带出
GET /direct_hotel_finance_info/supplier_hotel_info?supplierHotelCode=xxx&excludeId=<可选>
- SupplierHotel 查不到 → { Success: false, Message: "供应商酒店ID不存在" }
- DirectHotelFinance 已存在(isDeleted=0 且 id != excludeId) → { Success: false, Message: "该酒店已提交过财务信息" }
- 否则 → { Success: true, Data: { exists: true, duplicated: false, supplierId, supplierName, vendorCode, vendorName, sHotelId, hotelName, hotelNameCn, countryCode, countryName, productOwnerUser, productOwnerName, operationOwnerUser, operationOwnerName } }

### API-004 新增
POST /direct_hotel_finance_info
body 20 字段: supplierHotelCode, kingdeeId, cooperationStatus, hotelContactEmails, firstPaymentDate, productOwnerUser, bdEmails, operationOwnerUser, operationEmails, signingEntity, cooperationMode, settlementMethod, reconciliationDimension, billCollectionMethod, payeeFullName, payeeAddressPostcode, payeeBankName, payeeBankAccount, payeeBankAddress, swiftCodeIban
行为: 按 supplierHotelCode 查 SupplierHotel 自动带出 supplierId/supplierName/vendorCode/vendorName/sHotelId/hotelName/hotelNameCn/countryCode/countryName/productOwnerName/operationOwnerName 落库; 邮箱字段的中文逗号统一替换为英文逗号
返: { Success: true, Message: "新增成功", Data: { id: <新id> } }

### API-005 编辑
PUT /direct_hotel_finance_info/{id}
body 同 API-004
若入参 supplierHotelCode 与原记录不一致 → { Success: false, Message: "供应商酒店ID不允许修改" }
否则: 按 supplierHotelCode 重查并更新; 返 { Success: true, Message: "编辑成功" }

### API-006 提交导出
POST /direct_hotel_finance_info/export
body: 同 API-001 筛选字段(不带 paginationInfo)
行为: ExportTask 新增一条 status=0, operator="admin", file_name="direct_hotel_finance_info-<yyyyMMddHHmmss>.xlsx"
返: { Success: true, Message: "导出任务已提交,请稍后查看导出结果", Data: "<file_name>" }

### API-007 导出任务列表(注意外层是 IsSuccess 不是 Success)
GET /api/get_exporders_list/ExportDirectHotelFinanceInfo
返最近 10 条 ExportTask(applied_date DESC)
返: { IsSuccess: true, Data: [...] }

### API-008 下载文件
POST /api/download_exporders
body: form-urlencoded 字段 post_data(值是 JSON 字符串,含 file_name)
返: { Success: true, Message: "下载成功" }

### API-009 负责人候选
GET /direct_hotel_finance_info/owner_options
返: { Success: true, Data: [<全部 OwnerCandidate>] }

## 不实现: DELETE / 鉴权 / Vendor 候选接口`;

async function generateApiKey(): Promise<string> {
  const token = await getToken();
  await apiRequest('DELETE', '/api/users/me/api-key', token);
  const res = await apiRequest('POST', '/api/users/me/api-key', token);
  return res.data.data.apiKey as string;
}

async function connect(apiKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { 'X-API-Key': apiKey } },
  });
  const c = new Client({ name: 'tm-reconcile-probe', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

function cleanupModule(name: string) {
  const db = new Database(DB_PATH);
  try {
    const mod = db.prepare(`SELECT id FROM modules WHERE name = ? AND user_id = 1`).get(name) as { id: number } | undefined;
    if (mod) db.prepare(`DELETE FROM modules WHERE id = ?`).run(mod.id);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?`).all(`mock__1_${name}%`) as Array<{ name: string }>;
    for (const t of tables) try { db.exec(`DROP TABLE IF EXISTS \`${t.name}\``); } catch {}
    // tm_reconcile 业务实体表名不一定带模块名前缀,根据 spec 用 DirectHotelFinance/SupplierHotel/OwnerCandidate/ExportTask
    const looseTables = ['direct_hotel_finance', 'supplier_hotel', 'owner_candidate', 'export_task'];
    for (const t of looseTables) try { db.exec(`DROP TABLE IF EXISTS \`mock__1_${t}\``); } catch {}
    db.prepare(`UPDATE sessions SET run_status = 'done' WHERE module_name = ? AND run_status = 'running'`).run(name);
  } finally { db.close(); }
  const dir = join(GENERATED_DIR, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

async function runUntilDone(c: Client, args: Record<string, unknown>, maxPollMs = 1200_000): Promise<any> {
  const deadline = Date.now() + maxPollMs;
  while (Date.now() < deadline) {
    const r = await c.callTool({ name: 'create_module_from_spec', arguments: { ...args, waitMaxSec: 180 } } as any, undefined, { timeout: 200_000 });
    const sc = (r as any).structuredContent as any;
    if (sc?.status === 'still-running') {
      console.log(`[poll] stage=${sc.stage} elapsed=${sc.elapsedSec}s`);
      continue;
    }
    return { sc, isError: (r as any).isError === true, content: (r as any).content?.[0]?.text };
  }
  throw new Error(`Exceeded ${maxPollMs}ms`);
}

async function call(method: string, path: string, body?: any, opts: { contentType?: string } = {}): Promise<{ status: number; body: any; raw: string }> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (opts.contentType === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
  const raw = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* ignore */ }
  return { status: res.status, body: parsed, raw };
}

test.beforeAll(async () => { await waitForBackend(); });

test('tm_reconcile probe: MCP 生成 + 9 接口对账', async () => {
  test.setTimeout(1_500_000); // 25 min

  console.log('=== Phase 1: cleanup + MCP create ===');
  cleanupModule(MOD);

  const key = await generateApiKey();
  const client = await connect(key);

  let genResult: any;
  try {
    genResult = await runUntilDone(client, { spec: SPEC, moduleName: MOD });
  } finally {
    await client.close();
  }

  console.log('[gen]', JSON.stringify({
    moduleName: genResult.sc?.moduleName,
    status: genResult.sc?.status,
    isError: genResult.isError,
    contentPreview: genResult.content?.slice(0, 200),
  }, null, 2));

  console.log('\n=== Phase 2: 读 AI 生成的文件 ===');
  const dir = join(GENERATED_DIR, MOD);
  if (existsSync(dir)) {
    for (const f of ['_meta.json', 'schema.sql', 'controller.ts', 'test.ts']) {
      const p = join(dir, f);
      if (existsSync(p)) {
        const content = readFileSync(p, 'utf-8');
        console.log(`\n--- ${f} (${content.length} bytes) ---`);
        console.log(content.length > 6000 ? content.slice(0, 6000) + '\n...[truncated]' : content);
      } else {
        console.log(`MISSING: ${f}`);
      }
    }
  } else {
    console.log(`MODULE DIR NOT EXISTS: ${dir}`);
  }

  console.log('\n=== Phase 3: 调 9 接口 ===');

  const results: Array<{ name: string; status: number; ok: boolean; body: any; note?: string }> = [];

  // API-009 (无依赖,先跑)
  {
    const r = await call('GET', `/mock/${MOD}/direct_hotel_finance_info/owner_options`);
    results.push({
      name: 'API-009 owner_options',
      status: r.status,
      ok: r.status === 200 && r.body?.Success === true && Array.isArray(r.body?.Data),
      body: r.body,
    });
  }

  // API-001 search
  {
    const r = await call('POST', `/mock/${MOD}/direct_hotel_finance_info/search`, {
      paginationInfo: { pageNumber: 1, itemsPerPage: 3 },
    });
    results.push({
      name: 'API-001 search (paginationInfo only)',
      status: r.status,
      ok: r.status === 200 && r.body?.Success === true && Array.isArray(r.body?.Data),
      body: r.body,
    });
  }

  // API-001 search with filter
  {
    const r = await call('POST', `/mock/${MOD}/direct_hotel_finance_info/search`, {
      paginationInfo: { pageNumber: 1, itemsPerPage: 10 },
      hotelName: 'a',
    });
    results.push({
      name: 'API-001 search (hotelName 模糊)',
      status: r.status,
      ok: r.status === 200 && r.body?.Success === true,
      body: r.body,
    });
  }

  // API-002 detail with id=1
  {
    const r = await call('GET', `/mock/${MOD}/direct_hotel_finance_info/detail?id=1`);
    results.push({
      name: 'API-002 detail (id=1)',
      status: r.status,
      ok: r.status === 200 && r.body?.Success === true,
      body: r.body,
    });
  }

  // API-002 detail 找不到
  {
    const r = await call('GET', `/mock/${MOD}/direct_hotel_finance_info/detail?id=99999`);
    results.push({
      name: 'API-002 detail (id=99999 找不到)',
      status: r.status,
      ok: r.body?.Success === false && /记录不存在/.test(r.body?.Message ?? ''),
      body: r.body,
    });
  }

  // API-003 supplier_hotel_info: 新酒店(应 Success:true)
  {
    const r = await call('GET', `/mock/${MOD}/direct_hotel_finance_info/supplier_hotel_info?supplierHotelCode=${encodeURIComponent('tms#newhotel1')}`);
    results.push({
      name: 'API-003 supplier_hotel_info (newhotel1 应通过)',
      status: r.status,
      ok: r.status === 200 && r.body?.Success === true && r.body?.Data?.exists === true,
      body: r.body,
    });
  }

  // API-003 supplier_hotel_info: 已重复
  {
    const r = await call('GET', `/mock/${MOD}/direct_hotel_finance_info/supplier_hotel_info?supplierHotelCode=${encodeURIComponent('tms#shengxing2')}`);
    results.push({
      name: 'API-003 supplier_hotel_info (shengxing2 应重复)',
      status: r.status,
      ok: r.body?.Success === false && /提交过/.test(r.body?.Message ?? ''),
      body: r.body,
    });
  }

  // API-003 supplier_hotel_info: 不存在
  {
    const r = await call('GET', `/mock/${MOD}/direct_hotel_finance_info/supplier_hotel_info?supplierHotelCode=NOT_EXISTS`);
    results.push({
      name: 'API-003 supplier_hotel_info (不存在)',
      status: r.status,
      ok: r.body?.Success === false && /不存在/.test(r.body?.Message ?? ''),
      body: r.body,
    });
  }

  // API-004 新增
  let createdId: number | null = null;
  {
    const r = await call('POST', `/mock/${MOD}/direct_hotel_finance_info`, {
      supplierHotelCode: 'tms#newhotel2',
      kingdeeId: 'KD-TEST',
      cooperationStatus: 1,
      hotelContactEmails: 'a@b.com,c@d.com',
      firstPaymentDate: '2025-01-15',
      productOwnerUser: 'zhangsan',
      bdEmails: 'bd@x.com',
      operationOwnerUser: 'lisi',
      operationEmails: 'ops@x.com',
      signingEntity: '深圳市天驴旅游科技有限公司',
      cooperationMode: 1,
      settlementMethod: 1,
      reconciliationDimension: 1,
      billCollectionMethod: 1,
      payeeFullName: 'Test Hotel Ltd',
      payeeAddressPostcode: 'Shenzhen 518000',
      payeeBankName: 'CMB',
      payeeBankAccount: '622848001234567890',
      payeeBankAddress: 'SZ Branch',
      swiftCodeIban: 'CMBCCNBS',
    });
    if (r.body?.Success === true && typeof r.body?.Data?.id === 'number') createdId = r.body.Data.id;
    results.push({
      name: 'API-004 新增 (newhotel2)',
      status: r.status,
      ok: r.body?.Success === true && typeof r.body?.Data?.id === 'number',
      body: r.body,
    });
  }

  // API-005 编辑 (改 cooperationStatus,保持 supplierHotelCode 不变)
  if (createdId != null) {
    const r = await call('PUT', `/mock/${MOD}/direct_hotel_finance_info/${createdId}`, {
      supplierHotelCode: 'tms#newhotel2',
      kingdeeId: 'KD-TEST-EDIT',
      cooperationStatus: 2,
      hotelContactEmails: 'a@b.com',
      firstPaymentDate: '2025-02-15',
      productOwnerUser: 'zhangsan',
      bdEmails: 'bd@x.com',
      operationOwnerUser: 'lisi',
      operationEmails: 'ops@x.com',
      signingEntity: '深圳市天驴旅游科技有限公司',
      cooperationMode: 2,
      settlementMethod: 2,
      reconciliationDimension: 2,
      billCollectionMethod: 2,
      payeeFullName: 'Test Hotel Ltd v2',
      payeeAddressPostcode: 'Shenzhen 518000',
      payeeBankName: 'CMB',
      payeeBankAccount: '622848001234567890',
      payeeBankAddress: 'SZ Branch',
      swiftCodeIban: 'CMBCCNBS',
    });
    results.push({
      name: 'API-005 编辑 (改 cooperationStatus)',
      status: r.status,
      ok: r.body?.Success === true,
      body: r.body,
    });
  }

  // API-005 编辑 (改 supplierHotelCode 应被拒)
  if (createdId != null) {
    const r = await call('PUT', `/mock/${MOD}/direct_hotel_finance_info/${createdId}`, {
      supplierHotelCode: 'tms#newhotel3', // 不同的 code
      kingdeeId: 'KD',
      cooperationStatus: 1,
      hotelContactEmails: 'x@y.com',
      firstPaymentDate: null,
      productOwnerUser: 'a',
      bdEmails: 'b@c.com',
      operationOwnerUser: 'a',
      operationEmails: 'a@b.com',
      signingEntity: '深圳市天驴旅游科技有限公司',
      cooperationMode: 1,
      settlementMethod: 1,
      reconciliationDimension: 1,
      billCollectionMethod: 1,
      payeeFullName: 'X',
      payeeAddressPostcode: 'X',
      payeeBankName: 'X',
      payeeBankAccount: 'X',
      payeeBankAddress: 'X',
      swiftCodeIban: 'X',
    });
    results.push({
      name: 'API-005 编辑 (改 supplierHotelCode 应拒)',
      status: r.status,
      ok: r.body?.Success === false && /不允许修改/.test(r.body?.Message ?? ''),
      body: r.body,
    });
  }

  // API-006 提交导出
  {
    const r = await call('POST', `/mock/${MOD}/direct_hotel_finance_info/export`, {
      cooperationStatus: 1,
    });
    results.push({
      name: 'API-006 提交导出',
      status: r.status,
      ok: r.body?.Success === true && typeof r.body?.Data === 'string' && r.body.Data.includes('.xlsx'),
      body: r.body,
    });
  }

  // API-007 导出任务列表
  {
    const r = await call('GET', `/mock/${MOD}/api/get_exporders_list/ExportDirectHotelFinanceInfo`);
    results.push({
      name: 'API-007 导出任务列表 (注意 IsSuccess)',
      status: r.status,
      ok: r.status === 200 && r.body?.IsSuccess === true && Array.isArray(r.body?.Data),
      body: r.body,
    });
  }

  // API-008 下载文件 form-urlencoded
  {
    const r = await call('POST', `/mock/${MOD}/api/download_exporders`, {
      post_data: JSON.stringify({ file_name: 'foo.xlsx' }),
    }, { contentType: 'form' });
    results.push({
      name: 'API-008 下载文件',
      status: r.status,
      ok: r.body?.Success === true,
      body: r.body,
    });
  }

  console.log('\n=== Phase 4: 接口对账总览 ===');
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} [${r.status}] ${r.name}`);
    if (!r.ok) {
      console.log(`  body: ${JSON.stringify(r.body).slice(0, 300)}`);
    }
  }
  const okCount = results.filter(r => r.ok).length;
  console.log(`\n通过率: ${okCount}/${results.length}`);
});
