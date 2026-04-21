import { test, expect } from '@playwright/test';
import { waitForBackend, getToken, apiRequest, apiRequestNoAuth } from './helpers';

let adminToken: string;

test.beforeAll(async () => {
  await waitForBackend();
  adminToken = await getToken('admin', 'admin123');
});

// ========== 8.1 认证 API ==========

test.describe('API - 认证', () => {
  test('I01 健康检查', async () => {
    const { status, data } = await apiRequestNoAuth('GET', '/api/health');
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data).toBe('ok');
  });

  test('I02 正确凭据登录', async () => {
    const { status, data } = await apiRequestNoAuth('POST', '/api/auth/login', {
      username: 'admin', password: 'admin123',
    });
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.token).toBeTruthy();
    expect(data.data.user.username).toBe('admin');
  });

  test('I03 空 body 登录', async () => {
    const { status } = await apiRequestNoAuth('POST', '/api/auth/login', {});
    expect([400, 401]).toContain(status);
  });

  test('I04 密码错误', async () => {
    const { status } = await apiRequestNoAuth('POST', '/api/auth/login', {
      username: 'admin', password: 'wrong',
    });
    expect(status).toBe(401);
  });

  test('I05 用户不存在', async () => {
    const { status } = await apiRequestNoAuth('POST', '/api/auth/login', {
      username: 'nobody_exists_999', password: 'any',
    });
    expect(status).toBe(401);
  });

  test('I06 注册有效数据', async () => {
    const name = `tu${Date.now().toString(36)}`;  // 短名称，确保 3-20 字符
    const { status, data } = await apiRequestNoAuth('POST', '/api/auth/register', {
      username: name, password: '123456',
    });
    // 注册可能被禁用 (403) 或成功 (200/201)
    expect([200, 201, 403]).toContain(status);
  });

  test('I07 注册用户名过短', async () => {
    const { status } = await apiRequestNoAuth('POST', '/api/auth/register', {
      username: 'ab', password: '123456',
    });
    expect([400, 403]).toContain(status);
  });

  test('I08 注册密码过短', async () => {
    const { status } = await apiRequestNoAuth('POST', '/api/auth/register', {
      username: 'validname123', password: '12345',
    });
    expect([400, 403]).toContain(status);
  });

  test('I09 重复用户名注册', async () => {
    const { status } = await apiRequestNoAuth('POST', '/api/auth/register', {
      username: 'admin', password: '123456',
    });
    expect([409, 403]).toContain(status);
  });
});

// ========== 8.2 会话 API ==========

test.describe('API - 会话', () => {
  let sessionId: string;

  test('I10 获取会话列表', async () => {
    const { status, data } = await apiRequest('GET', '/api/sessions', adminToken);
    expect(status).toBe(200);
    expect(Array.isArray(data.data)).toBe(true);
  });

  test('I11 未认证获取会话', async () => {
    const { status } = await apiRequestNoAuth('GET', '/api/sessions');
    expect(status).toBe(401);
  });

  test('I12 创建会话', async () => {
    const { status, data } = await apiRequest('POST', '/api/sessions', adminToken, {
      title: '测试会话',
    });
    expect(status).toBe(201);
    expect(data.data.id).toBeTruthy();
    sessionId = data.data.id;
  });

  test('I13 获取会话详情', async () => {
    if (!sessionId) test.skip();
    const { status, data } = await apiRequest('GET', `/api/sessions/${sessionId}`, adminToken);
    expect(status).toBe(200);
    expect(data.data.id).toBe(sessionId);
    expect(Array.isArray(data.data.messages)).toBe(true);
  });

  test('I14 更新会话标题', async () => {
    if (!sessionId) test.skip();
    const { status, data } = await apiRequest('PUT', `/api/sessions/${sessionId}`, adminToken, {
      title: '更新后的标题',
    });
    expect(status).toBe(200);
  });

  test('I15 删除会话', async () => {
    if (!sessionId) test.skip();
    const { status } = await apiRequest('DELETE', `/api/sessions/${sessionId}`, adminToken);
    expect(status).toBe(200);
  });

  test('I16 删除不存在的会话', async () => {
    const fakeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { status } = await apiRequest('DELETE', `/api/sessions/${fakeId}`, adminToken);
    expect([400, 404]).toContain(status);
  });
});

// ========== 8.3 Provider API ==========

test.describe('API - Provider', () => {
  let providerId: number;

  test('I17 获取 Provider 列表（key 脱敏）', async () => {
    const { status, data } = await apiRequest('GET', '/api/providers', adminToken);
    expect(status).toBe(200);
    expect(Array.isArray(data.data)).toBe(true);
    // 检查 API key 脱敏
    for (const p of data.data) {
      if (p.apiKeyEncrypted) {
        expect(p.apiKeyEncrypted).toBe('***');
      }
    }
  });

  test('I18 创建 Provider', async () => {
    const { status, data } = await apiRequest('POST', '/api/providers', adminToken, {
      name: `Test Provider ${Date.now()}`,
      type: 'openai',
      defaultModel: 'gpt-4o-mini',
      apiKey: 'sk-test-key',
    });
    expect(status).toBe(201);
    expect(data.data.id).toBeTruthy();
    providerId = data.data.id;
    // key 已脱敏
    expect(data.data.apiKeyEncrypted).toBe('***');
  });

  test('I19 创建 Provider 缺字段', async () => {
    const { status } = await apiRequest('POST', '/api/providers', adminToken, {
      name: 'No Model',
    });
    expect(status).toBe(400);
  });

  test('I20 更新 Provider', async () => {
    if (!providerId) test.skip();
    const { status } = await apiRequest('PUT', `/api/providers/${providerId}`, adminToken, {
      name: 'Updated Provider Name',
    });
    expect(status).toBe(200);
  });

  test('I21 非 owner 更新 Provider', async () => {
    // 需要另一个用户的 token，跳过如果无法创建
    // 用不存在的 provider ID 模拟
    const { status } = await apiRequest('PUT', '/api/providers/99999', adminToken, {
      name: 'hack',
    });
    expect([403, 404]).toContain(status);
  });

  test('I22 删除 Provider', async () => {
    if (!providerId) test.skip();
    const { status } = await apiRequest('DELETE', `/api/providers/${providerId}`, adminToken);
    expect(status).toBe(200);
  });
});

// ========== 8.4 Preset API ==========

test.describe('API - Preset', () => {
  let presetId: number;

  test('I23 获取 Preset 列表', async () => {
    const { status, data } = await apiRequest('GET', '/api/presets', adminToken);
    expect(status).toBe(200);
    expect(Array.isArray(data.data)).toBe(true);
  });

  test('I24 创建 Preset', async () => {
    const { status, data } = await apiRequest('POST', '/api/presets', adminToken, {
      name: `Test Preset ${Date.now()}`,
      content: '{"format":"json"}',
    });
    expect(status).toBe(201);
    presetId = data.data.id;
  });

  test('I25 创建 Preset 缺 name', async () => {
    const { status } = await apiRequest('POST', '/api/presets', adminToken, {
      content: '{}',
    });
    expect(status).toBe(400);
  });

  test('I26 更新 Preset', async () => {
    if (!presetId) test.skip();
    const { status } = await apiRequest('PUT', `/api/presets/${presetId}`, adminToken, {
      name: 'Updated Preset',
    });
    expect(status).toBe(200);
  });

  test('I27 删除 Preset', async () => {
    if (!presetId) test.skip();
    const { status } = await apiRequest('DELETE', `/api/presets/${presetId}`, adminToken);
    expect(status).toBe(200);
  });
});

// ========== 8.5 模块 API ==========

test.describe('API - 模块', () => {
  test('I28 获取模块列表', async () => {
    const { status, data } = await apiRequest('GET', '/api/modules', adminToken);
    expect(status).toBe(200);
    expect(Array.isArray(data.data)).toBe(true);
  });

  test('I29 获取模块详情', async () => {
    const { data: listData } = await apiRequest('GET', '/api/modules', adminToken);
    if (listData.data.length === 0) test.skip();
    const name = listData.data[0].name;
    const { status, data } = await apiRequest('GET', `/api/modules/${name}`, adminToken);
    expect(status).toBe(200);
  });

  test('I30 获取不存在模块', async () => {
    const { status } = await apiRequest('GET', '/api/modules/nonexistent_module_999', adminToken);
    expect(status).toBe(404);
  });

  test('I31 获取模块上下文', async () => {
    const { data: listData } = await apiRequest('GET', '/api/modules', adminToken);
    if (listData.data.length === 0) test.skip();
    const name = listData.data[0].name;
    const { status } = await apiRequest('GET', `/api/modules/${name}/context`, adminToken);
    expect([200, 404]).toContain(status);
  });

  test('I32 获取模块文档', async () => {
    const { data: listData } = await apiRequest('GET', '/api/modules', adminToken);
    if (listData.data.length === 0) test.skip();
    const name = listData.data[0].name;
    const { status } = await apiRequest('GET', `/api/modules/${name}/doc`, adminToken);
    expect([200, 404]).toContain(status);
  });
});

// ========== 8.6 上传 & 用户管理 API ==========

test.describe('API - 上传', () => {
  test('I33 上传文件', async () => {
    const formData = new FormData();
    formData.append('file', new Blob(['test content'], { type: 'text/plain' }), 'test.txt');
    const res = await fetch('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: formData,
    });
    expect(res.status).toBe(200);
  });

  test('I34 上传无文件', async () => {
    const res = await fetch('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    // Fastify 返回 406 (not multipart) 或 400
    expect([400, 406]).toContain(res.status);
  });

  test('I35 未认证上传', async () => {
    const res = await fetch('http://localhost:3000/api/upload', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });
});

test.describe('API - 用户管理', () => {
  test('I36 Admin 获取用户列表', async () => {
    const { status, data } = await apiRequest('GET', '/api/users', adminToken);
    expect(status).toBe(200);
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.length).toBeGreaterThan(0);
  });

  test('I37 非 Admin 获取用户列表', async () => {
    const { status } = await apiRequestNoAuth('GET', '/api/users');
    expect([401, 403]).toContain(status);
  });

  test('I38 Admin 修改用户角色', async () => {
    const { data: listData } = await apiRequest('GET', '/api/users', adminToken);
    const targetUser = listData.data.find((u: any) => u.username !== 'admin');
    if (!targetUser) return test.skip();
    const { status } = await apiRequest('PUT', `/api/users/${targetUser.id}`, adminToken, {
      role: targetUser.role === 'admin' ? 'user' : 'admin',
    });
    expect(status).toBe(200);
    // 改回去
    await apiRequest('PUT', `/api/users/${targetUser.id}`, adminToken, {
      role: targetUser.role,
    });
  });

  test('I39 Admin 修改用户状态', async () => {
    const { data: listData } = await apiRequest('GET', '/api/users', adminToken);
    const targetUser = listData.data.find((u: any) => u.username !== 'admin');
    if (!targetUser) return test.skip();
    const { status } = await apiRequest('PUT', `/api/users/${targetUser.id}`, adminToken, {
      isActive: targetUser.isActive ? 0 : 1,
    });
    expect(status).toBe(200);
    // 改回去
    await apiRequest('PUT', `/api/users/${targetUser.id}`, adminToken, {
      isActive: targetUser.isActive,
    });
  });

  test('I40 非 Admin 修改用户', async () => {
    const { status } = await apiRequestNoAuth('PUT', '/api/users/1', { role: 'admin' });
    expect([401, 403]).toContain(status);
  });
});
