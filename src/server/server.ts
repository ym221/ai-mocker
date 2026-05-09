// Setup HTTP proxy for AI API calls (needed in China for Google/OpenAI)
import { ProxyAgent, setGlobalDispatcher } from 'undici';
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`Using proxy: ${proxyUrl}`);
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
