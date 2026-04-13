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

  // Seed test provider
  const existingProvider = db.select().from(providers).where(eq(providers.id, 1)).get();
  if (!existingProvider) {
    const defaultApiKey = process.env.DEFAULT_AI_API_KEY || '';
    db.insert(providers).values({
      name: 'Default Provider',
      type: process.env.DEFAULT_AI_PROVIDER || 'openai',
      apiKeyEncrypted: defaultApiKey ? encrypt(defaultApiKey) : null,
      baseUrl: process.env.DEFAULT_AI_BASE_URL || null,
      defaultModel: process.env.DEFAULT_AI_MODEL || 'gpt-4o-mini',
      scope: 'public',
      ownerId: 1,
      isVerified: 0,
      isActive: 1,
    }).run();
    console.log('Default AI provider created');
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
    await app.register(mockRouter);

    await app.listen({ port: PORT, host: HOST });
    console.log(`MockForge server running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
