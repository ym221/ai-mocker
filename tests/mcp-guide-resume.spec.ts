/**
 * Task 5.5 — guide + tool descriptions explain attach-on-resend.
 */
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { waitForBackend, getToken, apiRequest } from './helpers';

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
  const c = new Client({ name: 'mcp-guide-resume-spec', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

test.beforeAll(async () => { await waitForBackend(); });

test.describe('Task 5.5 — guide + tool descriptions', () => {
  test('GR01 guide 含 attach + 续接 + onConflict 关键词', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const r = await c.readResource({ uri: 'mockforge://guide' });
      const text = (r.contents[0] as any).text as string;
      expect(text).toContain('自动续接');
      expect(text).toContain('重发');
      expect(text).toContain('onConflict');
      expect(text).toContain('waitMaxSec');
      expect(text).toContain('attach');
      expect(text).toContain('get_session_status');
      expect(text).toContain('cancel_session');
      expect(text).toContain('MOCKFORGE_BUSY');
      expect(text).toContain('MOCKFORGE_ALREADY_PROCESSING');
    } finally { await c.close(); }
  });

  test('GR02 写工具 description 含 onConflict + waitMaxSec', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const { tools } = await c.listTools();
      const update = tools.find((t: any) => t.name === 'update_module') as any;
      expect(update).toBeTruthy();
      expect(update.description).toContain('waitMaxSec');
      expect(update.description).toContain('onConflict');
      expect(update.description).toContain('still-running');

      const create = tools.find((t: any) => t.name === 'create_module_from_spec') as any;
      expect(create).toBeTruthy();
      expect(create.description).toContain('waitMaxSec');
      expect(create.description).toContain('onConflict');
    } finally { await c.close(); }
  });

  test('GR03 会话工具 description 互相提及 + 13 tools total (新增 list_models)', async () => {
    const key = await generateApiKey();
    const c = await connect(key);
    try {
      const { tools } = await c.listTools();
      expect(tools.length).toBe(13);

      const getStatus = tools.find((t: any) => t.name === 'get_session_status') as any;
      const cancel = tools.find((t: any) => t.name === 'cancel_session') as any;
      expect(getStatus).toBeTruthy();
      expect(cancel).toBeTruthy();

      // Cross-link: get_session_status mentions cancel_session, cancel mentions update_module
      expect(getStatus.description).toContain('cancel_session');
      expect(cancel.description).toContain('update_module');
    } finally { await c.close(); }
  });
});
