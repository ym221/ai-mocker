import { test, expect } from '@playwright/test';
import { waitForBackend, getToken, apiRequest, ensureUserModule } from './helpers';

let adminToken: string;
const MODULE = 'user';

test.beforeAll(async () => {
  await waitForBackend();
  adminToken = await getToken('admin', 'admin123');
  // Make sure the fixture module + table exist before any assertion runs
  await ensureUserModule(adminToken);
  // Clean slate
  await apiRequest('POST', `/api/data/${MODULE}/clear`, adminToken);
});

test.describe('API - 数据管理', () => {
  test('D01 bulk-generate 批量生成 10 条', async () => {
    const { status, data } = await apiRequest('POST', `/api/data/${MODULE}/bulk-generate`, adminToken, { count: 10 });
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.generated).toBe(10);
  });

  test('D02 list 默认分页', async () => {
    const { status, data } = await apiRequest('GET', `/api/data/${MODULE}?page=1&pageSize=20`, adminToken);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.total).toBeGreaterThanOrEqual(10);
    expect(Array.isArray(data.data.list)).toBe(true);
    expect(data.data.list.length).toBeLessThanOrEqual(20);
  });

  test('D03 list 排序 orderBy', async () => {
    const { data } = await apiRequest('GET', `/api/data/${MODULE}?orderBy=id+ASC&pageSize=5`, adminToken);
    const ids = data.data.list.map((r: { id: number }) => r.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  test('D04 list filter 字段筛选', async () => {
    // Grab first row username
    const { data: listData } = await apiRequest('GET', `/api/data/${MODULE}?page=1&pageSize=1`, adminToken);
    const firstName = listData.data.list[0].username as string;
    const partial = firstName.slice(0, 3);
    const { data } = await apiRequest('GET', `/api/data/${MODULE}?filter[username]=${encodeURIComponent(partial)}`, adminToken);
    expect(data.success).toBe(true);
    // Every returned row must include the partial
    for (const row of data.data.list) {
      expect(String(row.username).toLowerCase()).toContain(partial.toLowerCase());
    }
  });

  test('D05 POST create 新行', async () => {
    const { status, data } = await apiRequest('POST', `/api/data/${MODULE}`, adminToken, {
      username: 'test_user_abc',
      email: 'abc@test.com',
      password: 'x',
      role: 'user',
      status: 1,
    });
    expect(status).toBe(200);
    expect(data.data.id).toBeTruthy();
    expect(data.data.username).toBe('test_user_abc');
  });

  test('D06 PUT update 单行', async () => {
    const { data: created } = await apiRequest('POST', `/api/data/${MODULE}`, adminToken, {
      username: 'update_me', email: 'u@test.com', password: 'x',
    });
    const id = created.data.id;
    const { status, data } = await apiRequest('PUT', `/api/data/${MODULE}/${id}`, adminToken, { email: 'updated@test.com' });
    expect(status).toBe(200);
    expect(data.data.email).toBe('updated@test.com');
    expect(data.data.username).toBe('update_me');
  });

  test('D07 DELETE 单行', async () => {
    const { data: created } = await apiRequest('POST', `/api/data/${MODULE}`, adminToken, {
      username: 'delete_me', email: 'd@test.com', password: 'x',
    });
    const id = created.data.id;
    const { status, data } = await apiRequest('DELETE', `/api/data/${MODULE}/${id}`, adminToken);
    expect(status).toBe(200);
    expect(data.data.deleted).toBe(true);
    // Confirm gone
    const { data: after } = await apiRequest('GET', `/api/data/${MODULE}?filter[id]=${id}`, adminToken);
    expect(after.data.list.find((r: { id: number }) => r.id === id)).toBeUndefined();
  });

  test('D08 batch-delete', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { data } = await apiRequest('POST', `/api/data/${MODULE}`, adminToken, {
        username: `batch_${i}`, email: `b${i}@test.com`, password: 'x',
      });
      ids.push(data.data.id);
    }
    const { status, data } = await apiRequest('POST', `/api/data/${MODULE}/batch-delete`, adminToken, { ids });
    expect(status).toBe(200);
    expect(data.data.deleted).toBe(3);
  });

  test('D09 bulk-generate with rules (sequence)', async () => {
    await apiRequest('POST', `/api/data/${MODULE}/clear`, adminToken);
    const { status, data } = await apiRequest('POST', `/api/data/${MODULE}/bulk-generate`, adminToken, {
      count: 5,
      rules: { username: { kind: 'sequence', prefix: 'seq_', start: 100 } },
    });
    expect(status).toBe(200);
    expect(data.data.generated).toBe(5);
    const { data: listData } = await apiRequest('GET', `/api/data/${MODULE}?pageSize=20&orderBy=id+ASC`, adminToken);
    const usernames = listData.data.list.map((r: { username: string }) => r.username);
    // Expect seq_100..seq_104 present
    for (let i = 0; i < 5; i++) {
      expect(usernames).toContain(`seq_${100 + i}`);
    }
  });

  test('D10 clear 清空', async () => {
    const { status, data } = await apiRequest('POST', `/api/data/${MODULE}/clear`, adminToken);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const { data: after } = await apiRequest('GET', `/api/data/${MODULE}?pageSize=1`, adminToken);
    expect(after.data.total).toBe(0);
  });

  test('D11 未认证拒绝', async () => {
    const res = await fetch('http://localhost:3000/api/data/user');
    expect(res.status).toBe(401);
  });

  test('D12 非法 module 400', async () => {
    const { status } = await apiRequest('GET', `/api/data/__nonexistent__`, adminToken);
    expect(status).toBe(400);
  });
});
