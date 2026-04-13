import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ==================== users ====================
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  role: text('role').notNull().default('user'), // admin | user
  isActive: integer('is_active').default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ==================== providers ====================
export const providers = sqliteTable('providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(), // anthropic | openai | google | openai-compatible | custom
  apiKeyEncrypted: text('api_key_encrypted'),
  baseUrl: text('base_url'),
  defaultModel: text('default_model').notNull(),
  scope: text('scope').notNull().default('private'), // public | private
  ownerId: integer('owner_id').references(() => users.id),
  isVerified: integer('is_verified').default(0),
  isActive: integer('is_active').default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ==================== presets ====================
export const presets = sqliteTable('presets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  content: text('content').notNull(), // JSON config
  scope: text('scope').notNull().default('private'), // public | private
  ownerId: integer('owner_id').references(() => users.id),
  isActive: integer('is_active').default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ==================== sessions ====================
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), // UUID
  title: text('title').default('新对话'),
  userId: integer('user_id').references(() => users.id),
  providerId: integer('provider_id').references(() => providers.id),
  model: text('model'),
  presetId: integer('preset_id').references(() => presets.id),
  moduleName: text('module_name'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ==================== messages ====================
export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // user | assistant
  content: text('content'),
  toolCalls: text('tool_calls'), // JSON
  attachments: text('attachments'), // JSON
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

// ==================== modules ====================
export const modules = sqliteTable('modules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  userId: integer('user_id').references(() => users.id),
  displayName: text('display_name').notNull(),
  description: text('description'),
  basePath: text('base_path').notNull(),
  status: text('status').default('active'), // active | error | disabled
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('modules_name_user_id_unique').on(table.name, table.userId),
]);

// ==================== mock_requests ====================
export const mockRequests = sqliteTable('mock_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').references(() => users.id),
  moduleName: text('module_name').notNull(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  statusCode: integer('status_code'),
  durationMs: integer('duration_ms'),
  requestBody: text('request_body'),
  responseBody: text('response_body'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});
