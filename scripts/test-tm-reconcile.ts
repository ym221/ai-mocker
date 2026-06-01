/**
 * Standalone MCP test — calls create_module_from_spec for the tm_reconcile spec
 * defined in Step-Loosen verification.
 *
 * Usage: pnpm tsx scripts/test-tm-reconcile.ts
 *
 * Prerequisite: dev server running on :3000 (`pnpm dev:server`).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolve } from 'path';
import Database from 'better-sqlite3';

const MCP_URL = new URL('http://localhost:3000/mcp');
const DB_PATH = resolve(process.cwd(), 'data', 'mockforge.db');
const MODULE_NAME = 'tm_reconcile';

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

## 不实现: DELETE / 鉴权 / Vendor 候选接口
`;

async function cleanupModule(name: string) {
  const db = new Database(DB_PATH);
  try {
    const mod = db.prepare(`SELECT id FROM modules WHERE name = ? AND user_id = 1`).get(name) as { id: number } | undefined;
    if (mod) {
      db.prepare(`DELETE FROM modules WHERE id = ?`).run(mod.id);
      console.log(`[cleanup] removed module ${name} (id=${mod.id})`);
    }
    db.exec(`DROP TABLE IF EXISTS \`mock__1_${name}\``);
    db.exec(`DROP TABLE IF EXISTS \`mock__1_DirectHotelFinance\``);
    db.exec(`DROP TABLE IF EXISTS \`mock__1_SupplierHotel\``);
    db.exec(`DROP TABLE IF EXISTS \`mock__1_OwnerCandidate\``);
    db.exec(`DROP TABLE IF EXISTS \`mock__1_ExportTask\``);
    // Also clear any running session for this module
    db.prepare(`UPDATE sessions SET run_status = 'done' WHERE module_name = ? AND run_status = 'running'`).run(name);
  } finally {
    db.close();
  }
  // Remove dir
  const dir = resolve(process.cwd(), 'generated', '1', name);
  try {
    const fs = await import('fs');
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[cleanup] removed dir ${dir}`);
  } catch { /* ignore */ }
}

async function generateApiKey(): Promise<string> {
  const loginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const login = await loginRes.json() as any;
  const token = login.data.token;
  await fetch('http://localhost:3000/api/users/me/api-key', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const keyRes = await fetch('http://localhost:3000/api/users/me/api-key', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const key = await keyRes.json() as any;
  return key.data.apiKey as string;
}

async function main() {
  console.log('=== Step-Loosen tm_reconcile MCP test ===');
  console.log('Pre-cleaning previous attempt...');
  await cleanupModule(MODULE_NAME);

  console.log('Generating API key...');
  const apiKey = await generateApiKey();
  console.log('API key:', apiKey.slice(0, 16) + '...');

  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { 'X-API-Key': apiKey } },
  });
  const client = new Client({ name: 'step-loosen-test', version: '0.0.0' });
  await client.connect(transport);
  console.log('Connected to MCP.');

  const tools = await client.listTools();
  console.log(`Available tools (${tools.tools.length}):`, tools.tools.map(t => t.name).join(', '));

  // Verify our new patch tools are there
  const expected = ['patch_module_field', 'patch_module_endpoint'];
  for (const e of expected) {
    if (!tools.tools.find(t => t.name === e)) {
      console.error(`MISSING new tool: ${e}`);
      process.exit(1);
    }
  }
  console.log('✓ patch_module_field and patch_module_endpoint registered');

  console.log('\n=== Calling create_module_from_spec(tm_reconcile) ===');
  const t0 = Date.now();
  // Loop: re-call with same args when still-running (auto-resume).
  // Each call waits up to perCallWaitSec; total budget is overall 1800s.
  const PER_CALL_WAIT_SEC = 120;
  const TOTAL_DEADLINE_MS = Date.now() + 30 * 60 * 1000;
  let result: any = null;
  let attempt = 0;
  while (Date.now() < TOTAL_DEADLINE_MS) {
    attempt++;
    const tStart = Date.now();
    result = await client.callTool({
      name: 'create_module_from_spec',
      arguments: {
        spec: SPEC,
        moduleName: MODULE_NAME,
        waitMaxSec: PER_CALL_WAIT_SEC,
        provider: 285,  // deepseek-chat (verified, stronger than gemma-31b for complex specs)
      },
    }, undefined, { timeout: (PER_CALL_WAIT_SEC + 30) * 1000 });
    const elapsedThisCall = Math.round((Date.now() - tStart) / 1000);
    const sc = result.structuredContent as any;
    const totalElapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`[attempt ${attempt}] elapsed_call=${elapsedThisCall}s total=${totalElapsed}s status=${sc?.status} isError=${result.isError ?? false}`);
    if (sc?.status === 'still-running') {
      console.log(`  stage: ${sc.stageDescription ?? sc.stage}, expected_remaining: ~${sc.expectedRemainingSec}s`);
      continue;  // resume
    }
    break;  // terminal: done / created / error
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n--- Tool terminal after ${elapsed}s ---`);
  console.log('isError:', result?.isError);
  console.log('content[0].text:', result?.content && Array.isArray(result.content) ? (result.content[0] as any)?.text : '(none)');
  console.log('structuredContent:', JSON.stringify(result?.structuredContent, null, 2));

  await client.close();

  // Final report
  console.log('\n=== Final state ===');
  const sc = result.structuredContent as any;
  if (sc?.status === 'created') {
    console.log(`✓ Module created via path: ${sc.generationPath ?? 'ChatRunner (tier 3)'} (tier=${sc.tier ?? 3})`);
    console.log(`  Quality: smokeTested=${sc.quality?.smokeTested}, smokeEndpoint=${sc.quality?.smokeEndpoint}`);
    if (sc.quality?.runTestCases) {
      console.log(`  Run tests: ${sc.quality.runTestCases.passed}/${sc.quality.runTestCases.total} passed (${sc.quality.runTestCases.failures} failures)`);
    }
    console.log(`  Warnings:`, sc.warnings ?? sc.quality?.warnings ?? []);
    console.log(`  mockBaseUrl: ${sc.mockBaseUrl}`);
    console.log(`  Endpoints:`, sc.endpoints);
  } else if (sc?.status === 'still-running') {
    console.log(`⏳ Generation still running after ${elapsed}s — sessionId=${sc.sessionId}`);
    console.log(`  Stage: ${sc.stageDescription ?? sc.stage}`);
    console.log(`  Expected remaining: ~${sc.expectedRemainingSec}s`);
    console.log(`  Resume: call create_module_from_spec with same args.`);
  } else if (result.isError) {
    console.log(`✗ ERROR — ${sc?.code}: ${sc?.message}`);
    console.log(`  Hint: ${sc?.hint}`);
    if (sc?.recovery_steps) console.log(`  Recovery steps:`, JSON.stringify(sc.recovery_steps, null, 2));
  } else {
    console.log(`? Unexpected status: ${sc?.status}`);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
