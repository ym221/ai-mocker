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
  apiKeyHash: text('api_key_hash'),                    // HMAC-SHA256(MCP_API_KEY_SECRET, plain)
  apiKeyCreatedAt: text('api_key_created_at'),
  apiKeyLastUsedAt: text('api_key_last_used_at'),
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
  // 测试连接结果(provider 测试功能用):成功时记 ISO 时间,失败时也记时间;失败原因写入 lastVerifiedError
  lastVerifiedAt: text('last_verified_at'),
  lastVerifiedError: text('last_verified_error'),
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
  runStatus: text('run_status').default('idle'), // idle | running | paused | done | error
  hasUnread: integer('has_unread').default(0),
  lastSeq: integer('last_seq').default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ==================== messages ====================
export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // user | assistant
  content: text('content'),
  thinking: text('thinking'),   // legacy (still read for backward compat)
  toolCalls: text('tool_calls'), // legacy
  modules: text('modules'),      // legacy
  messageError: text('message_error'), // legacy
  attachments: text('attachments'), // JSON
  paused: integer('paused').default(0),    // assistant 消息被用户中断
  finalizedAt: text('finalized_at'),
  startedAt: integer('started_at'),        // runner 开始处理的毫秒时间戳
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

// ==================== message_events (append-only event log) ====================
export const messageEvents = sqliteTable('message_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  messageId: integer('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),           // 会话内单调递增
  type: text('type').notNull(),            // thinking|text|tool_call|tool_result|card|image|md|error|done|aborted|paused|user
  payload: text('payload').notNull(),      // JSON
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (t) => [
  uniqueIndex('msg_events_session_seq_unique').on(t.sessionId, t.seq),
]);

// ==================== modules ====================
export const modules = sqliteTable('modules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  userId: integer('user_id').references(() => users.id),
  displayName: text('display_name').notNull(),
  description: text('description'),
  basePath: text('base_path').notNull(),
  status: text('status').default('active'), // creating | editing | active | error | disabled
  errorMessage: text('error_message'),
  lastRunStatus: text('last_run_status'),  // done | error | timeout | interrupted
  lastRunError: text('last_run_error'),
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
