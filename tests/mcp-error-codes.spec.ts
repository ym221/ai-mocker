/**
 * Task 5.4 — unified MCP error codes (EC01-EC04).
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { waitForBackend, getToken, apiRequest, ensureUserModule } from './helpers';

const MCP_URL = new URL('http://localhost:3000/mcp');

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
  const c = new Client({ name: 'mcp-error-codes-spec', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

test.beforeAll(async () => {
  await waitForBackend();
  const token = await getToken();
  await ensureUserModule(token);
});

test.describe('Task 5.4 — unified error codes', () => {
  test('EC01 update_module 对不存在的模块返 MODULE_NOT_FOUND + hint', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'update_module',
        arguments: { moduleName: '__nope__', instruction: 'x', waitMaxSec: 5 },
      }, undefined, { timeout: 10000 });
      expect((r as any).isError).toBe(true);
      const sc = (r as any).structuredContent as any;
      expect(sc.code).toBe('MOCKFORGE_MODULE_NOT_FOUND');
      expect(sc.hint).toBeTruthy();
    } finally { await c.close(); }
  });

  test('EC02 get_api_doc 对不存在模块返 MODULE_NOT_FOUND + hint', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'get_api_doc',
        arguments: { moduleName: '__nope__' },
      }, undefined, { timeout: 10000 });
      expect((r as any).isError).toBe(true);
      const sc = (r as any).structuredContent as any;
      expect(sc.code).toBe('MOCKFORGE_MODULE_NOT_FOUND');
      expect(sc.hint).toBeTruthy();
    } finally { await c.close(); }
  });

  test('EC03 get_session_status 对不存在 session 返 SESSION_NOT_FOUND + hint', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'get_session_status',
        arguments: { sessionId: '__not-a-session__' },
      }, undefined, { timeout: 10000 });
      expect((r as any).isError).toBe(true);
      const sc = (r as any).structuredContent as any;
      expect(sc.code).toBe('MOCKFORGE_SESSION_NOT_FOUND');
      expect(sc.hint).toBeTruthy();
    } finally { await c.close(); }
  });

  test('EC04 delete_module 对不存在模块返 MODULE_NOT_FOUND + hint', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'delete_module',
        arguments: { moduleName: '__nope__' },
      }, undefined, { timeout: 10000 });
      expect((r as any).isError).toBe(true);
      const sc = (r as any).structuredContent as any;
      expect(sc.code).toBe('MOCKFORGE_MODULE_NOT_FOUND');
      expect(sc.hint).toBeTruthy();
    } finally { await c.close(); }
  });
});
