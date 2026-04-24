/**
 * Task M2.1 — inspect_module MCP 工具.
 *
 * IM01 view='all' 同时返回 doc + openapi + health 三段
 * IM02 view='doc' 只返 doc
 * IM03 view='health' 只返 health, 不 build OpenAPI
 * IM04 不存在模块返 MODULE_NOT_FOUND
 * IM05 view 不传时默认 all
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
  const c = new Client({ name: 'mcp-inspect-module-spec', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

test.beforeAll(async () => {
  await waitForBackend();
  const token = await getToken();
  await ensureUserModule(token);
});

test.describe('Task M2.1 — inspect_module', () => {
  test('IM01 view="all" 同时返回 doc + openapi + health 三段', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'inspect_module',
        arguments: { moduleName: 'user', view: 'all' },
      }, undefined, { timeout: 10000 });
      expect((r as any).isError).toBeFalsy();
      const sc = (r as any).structuredContent as any;
      expect(sc.view).toBe('all');
      expect(sc.doc).toBeTruthy();
      expect(sc.doc.markdown).toContain('用户管理 API');
      expect(sc.openapi).toBeTruthy();
      expect(sc.openapi.spec.openapi).toBe('3.0.3');
      expect(sc.health).toBeTruthy();
      expect(sc.health.status).toBe('healthy');
    } finally { await c.close(); }
  });

  test('IM02 view="doc" 只返 doc, openapi/health 不存在', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'inspect_module',
        arguments: { moduleName: 'user', view: 'doc' },
      }, undefined, { timeout: 10000 });
      const sc = (r as any).structuredContent as any;
      expect(sc.view).toBe('doc');
      expect(sc.doc?.markdown).toContain('用户管理 API');
      expect(sc.openapi).toBeUndefined();
      expect(sc.health).toBeUndefined();
    } finally { await c.close(); }
  });

  test('IM03 view="health" 只返 health, openapi/doc 不存在', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'inspect_module',
        arguments: { moduleName: 'user', view: 'health' },
      }, undefined, { timeout: 10000 });
      const sc = (r as any).structuredContent as any;
      expect(sc.view).toBe('health');
      expect(sc.health?.status).toBe('healthy');
      expect(sc.doc).toBeUndefined();
      expect(sc.openapi).toBeUndefined();
    } finally { await c.close(); }
  });

  test('IM04 不存在模块返 MODULE_NOT_FOUND', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'inspect_module',
        arguments: { moduleName: '__nope__', view: 'all' },
      }, undefined, { timeout: 5000 });
      expect((r as any).isError).toBe(true);
      const sc = (r as any).structuredContent as any;
      expect(sc.code).toBe('MOCKFORGE_MODULE_NOT_FOUND');
      expect(sc.hint).toBeTruthy();
    } finally { await c.close(); }
  });

  test('IM05 view 不传时默认 all', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.callTool({
        name: 'inspect_module',
        arguments: { moduleName: 'user' },
      }, undefined, { timeout: 10000 });
      const sc = (r as any).structuredContent as any;
      expect(sc.view).toBe('all');
      expect(sc.doc).toBeTruthy();
      expect(sc.openapi).toBeTruthy();
      expect(sc.health).toBeTruthy();
    } finally { await c.close(); }
  });
});
