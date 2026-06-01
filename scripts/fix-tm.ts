/**
 * 第二轮:用 update_module 让 AI 修 tm_reconcile 剩余的 controller bug。
 * Step-Workflow-1 强制 patch_file 局部修改,不准 write_file 大改 + cap=2 防 loop。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = new URL('http://localhost:3000/mcp');

const INSTRUCTION = `跑 run_test(moduleName: tm_reconcile),分析所有失败 case,修复 controller.ts 中的 bug 让全部 16 个测试通过。

已知主要问题(基于 run_test 报错):
- API-001 /search:controller 抛错或返回 Success:false,检查 findAll where 构造、orderBy 是否对、是否拼错字段
- API-003 /supplier_hotel_info:多个 case 返回"服务器内部错误"说明 controller throw。检查查询逻辑、auto-populate 字段、duplicated 重复检测分支
- API-004 POST:返回 Success:false,可能是 BaseModel 校验失败或 INSERT 失败
- API-005 PUT:测试依赖前面 case 创建的记录,检查整体顺序
- API-006 /export:返回 undefined(可能 res.body 是 null,controller 没返 envelope)
- **API-007** GET /api/get_exporders_list/...:必须返 \`{IsSuccess: true, Data: [...]}\`(注意是 IsSuccess,不是 Success!这是 spec 明说的例外)
- API-008 /download_exporders:返回 undefined,form-urlencoded body 解析或 controller 未返响应
- API-009 /owner_options:返回 Success:false,检查 BaseModel('OwnerCandidate').findAll() 是否能拿到 6 条种子数据

只允许用 patch_file 局部修改 controller.ts,不要重写。每次 patch 后用 run_test 验证。`;

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
  const c = new Client({ name: 'fix-tm', version: '0.0.0' });
  await c.connect(tr);

  console.log('Calling update_module(tm_reconcile) with focused fix instruction...');
  const t0 = Date.now();
  const PER_CALL = 120;
  const DEADLINE = Date.now() + 25 * 60 * 1000;
  let result: any = null;
  let attempt = 0;
  while (Date.now() < DEADLINE) {
    attempt++;
    const tCall = Date.now();
    result = await c.callTool({
      name: 'update_module',
      arguments: {
        moduleName: 'tm_reconcile',
        instruction: INSTRUCTION,
        waitMaxSec: PER_CALL,
        provider: 285, // deepseek-chat
      },
    }, undefined, { timeout: (PER_CALL + 30) * 1000 });
    const elapsed = Math.round((Date.now() - tCall) / 1000);
    const total = Math.round((Date.now() - t0) / 1000);
    const sc = result.structuredContent as any;
    console.log(`[attempt ${attempt}] call=${elapsed}s total=${total}s status=${sc?.status}`);
    if (sc?.status === 'still-running') continue;
    break;
  }
  console.log('\n--- terminal ---');
  console.log('status:', (result?.structuredContent as any)?.status);
  console.log('quality:', JSON.stringify((result?.structuredContent as any)?.quality, null, 2));
  console.log('warnings:', (result?.structuredContent as any)?.warnings);
  await c.close();
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
