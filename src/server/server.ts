// =============================================================================
// production Docker 下注册 tsx ESM hook,让运行时能动态 import('xxx.ts')。
// (AI 生成的 controller.ts / test.ts 是 runtime 产物,不参与 build 编译)。
//
// 仅 production 才主动注册 — dev 模式 tsx CLI / tsx watch 自己已经接管 .ts
// 解析,重复 register() 会让 ESM hook chain 出现冲突,业务 import 卡死。
//
// 检测条件:NODE_ENV=production 且当前进程入口是 .js(说明跑的是 dist 编译产物)。
// 任一不满足就跳过注册,假定运行环境已能处理 .ts。
// =============================================================================
const entry = process.argv[1] || '';
const needsTsxHook = process.env.NODE_ENV === 'production' && entry.endsWith('.js');
if (needsTsxHook) {
  const { register: registerTsxHook } = await import('tsx/esm/api');
  registerTsxHook();
  console.log('[bootstrap] tsx ESM hook registered — runtime .ts imports enabled');
} else {
  console.log('[bootstrap] skipping tsx hook (dev / tsx CLI already manages .ts)');
}

// =============================================================================
// Process-level 兜底:防止某些路径下未 catch 的异常或 promise rejection 直接退出进程,
// 导致 Docker 反复 restart + 所有 running session 被自动写 server_restart 中断。
// 关键:Node 20 默认 `--unhandled-rejections=throw`,unhandledRejection 会被升级
// 成 uncaughtException 进而 crash。这里覆盖默认行为,记录后让进程继续。
// =============================================================================
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 未捕获的同步异常 — 进程继续运行,但应排查根因:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] 未处理的 promise rejection — 进程继续运行,但应排查根因:', reason);
});

// Setup HTTP proxy for AI API calls (needed in China for Google/OpenAI)
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { existsSync } from 'fs';
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
if (proxyUrl) {
  // 防御:容器内的 localhost 代理几乎必错(127.0.0.1 是容器自己,代理软件不在容器里)。
  // 用户从本地 .env 复制 HTTPS_PROXY=http://127.0.0.1:xxx 到服务器是常见误操作。
  // 检测到这种组合时警告并忽略,避免所有 outbound 请求 ECONNREFUSED。
  const isLocalhostProxy = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/i.test(proxyUrl);
  const inContainer = existsSync('/.dockerenv') || process.env.container === 'docker';
  if (isLocalhostProxy && inContainer) {
    console.warn(`[proxy] 忽略 HTTPS_PROXY=${proxyUrl} —— 容器内 localhost 代理几乎必然不可达(127.0.0.1 在容器里指容器自己,你的 V2Ray/Clash 不在容器里)。如确需代理,改成可达的网关 IP。当前已切换为直连。`);
  } else {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`Using proxy: ${proxyUrl}`);
  }
}

import app from './app.js';
import { initDatabase, db } from './core/database.js';
import { users, providers } from './core/schema.js';
import { encrypt } from './core/encryption.js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import authRoutes from './api/auth.js';
import providerRoutes from './api/providers.js';
import presetRoutes from './api/presets.js';
import sessionRoutes from './api/sessions.js';
import moduleRoutes from './api/modules.js';
import chatRoutes from './api/chat.js';
import uploadRoutes from './api/upload.js';
import dataRoutes from './api/data.js';
import testRoutes from './api/test.js';
import userRoutes from './api/users.js';
import apiKeyRoutes from './api/api-keys.js';
import mcpRoutes from './mcp/routes.js';
import mockRouter from './core/mock-router.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function seedDatabase() {
  // Seed admin user
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  const existing = db.select().from(users).where(eq(users.username, adminUsername)).get();
  if (!existing) {
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    db.insert(users).values({
      username: adminUsername,
      passwordHash,
      displayName: 'Administrator',
      role: 'admin',
    }).run();
    console.log(`Admin user "${adminUsername}" created`);
  } else if (existing.role !== 'admin' || existing.isActive !== 1) {
    // Idempotent admin restore: 即使 admin 之前被误降级/禁用,启动时自动恢复 role=admin + isActive=1。
    // 这是系统级"自愈"——.env 配置的 admin 始终保持管理员身份,避免误操作把所有人锁在外面。
    db.update(users).set({
      role: 'admin',
      isActive: 1,
      updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    }).where(eq(users.id, existing.id)).run();
    console.log(`[seed] admin user "${adminUsername}" auto-restored to role=admin / active=1 (was role=${existing.role}, active=${existing.isActive})`);
  }

  // Seed test provider — env 兜底配置
  const existingProvider = db.select().from(providers).where(eq(providers.id, 1)).get();
  const defaultApiKey = process.env.DEFAULT_AI_API_KEY || '';
  const defaultType = process.env.DEFAULT_AI_PROVIDER || 'openai';
  const defaultBaseUrl = process.env.DEFAULT_AI_BASE_URL || null;
  const defaultModel = process.env.DEFAULT_AI_MODEL || 'gpt-4o-mini';

  if (!existingProvider) {
    db.insert(providers).values({
      name: 'Default Provider',
      type: defaultType,
      apiKeyEncrypted: defaultApiKey ? encrypt(defaultApiKey) : null,
      baseUrl: defaultBaseUrl,
      defaultModel: defaultModel,
      scope: 'public',
      ownerId: 1,
      isVerified: 0,
      isActive: 1,
    }).run();
    console.log('Default AI provider created');
  } else if (defaultApiKey && !existingProvider.apiKeyEncrypted) {
    // 兼容场景:之前启动时 env 没传(docker-compose 未注入),DB 里建了空 key 占位;
    // 现在 env 有值了,自动回填,免得用户手动删 volume。
    db.update(providers).set({
      apiKeyEncrypted: encrypt(defaultApiKey),
      type: defaultType,
      baseUrl: defaultBaseUrl,
      defaultModel: defaultModel,
    }).where(eq(providers.id, 1)).run();
    console.log('Default AI provider key backfilled from env');
  }
}

async function start() {
  try {
    // Initialize database and create system tables
    initDatabase();
    console.log('Database initialized');

    // Seed initial data
    await seedDatabase();

    // Register API routes
    await app.register(authRoutes);
    await app.register(providerRoutes);
    await app.register(presetRoutes);
    await app.register(sessionRoutes);
    await app.register(moduleRoutes);
    await app.register(chatRoutes);
    await app.register(uploadRoutes);
    await app.register(dataRoutes);
    await app.register(testRoutes);
    await app.register(userRoutes);
    await app.register(apiKeyRoutes);
    await app.register(mcpRoutes);
    await app.register(mockRouter);

    await app.listen({ port: PORT, host: HOST });
    console.log(`MockForge server running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
