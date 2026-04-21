import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import * as schema from './schema.js';

const DB_PATH = process.env.DB_PATH || './data/mockforge.db';

// Ensure data directory exists
const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

// Create SQLite connection
const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
sqlite.pragma('journal_mode = WAL');

// Enable foreign key constraints
sqlite.pragma('foreign_keys = ON');

// Create Drizzle ORM instance
const db = drizzle(sqlite, { schema });

/** Create all system tables if they don't exist */
export function initDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      api_key_encrypted TEXT,
      base_url TEXT,
      default_model TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'private',
      owner_id INTEGER REFERENCES users(id),
      is_verified INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      content TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'private',
      owner_id INTEGER REFERENCES users(id),
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT '新对话',
      user_id INTEGER REFERENCES users(id),
      provider_id INTEGER REFERENCES providers(id),
      model TEXT,
      preset_id INTEGER REFERENCES presets(id),
      module_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT,
      thinking TEXT,
      tool_calls TEXT,
      modules TEXT,
      message_error TEXT,
      attachments TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      display_name TEXT NOT NULL,
      description TEXT,
      base_path TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(name, user_id)
    );

    CREATE TABLE IF NOT EXISTS mock_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      module_name TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER,
      duration_ms INTEGER,
      request_body TEXT,
      response_body TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS message_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS msg_events_session_seq_unique
      ON message_events (session_id, seq);
    CREATE INDEX IF NOT EXISTS msg_events_message_id_idx
      ON message_events (message_id);
  `);

  // Migrations for existing databases
  const msgCols = sqlite.prepare("PRAGMA table_info('messages')").all() as { name: string }[];
  const msgColNames = new Set(msgCols.map(c => c.name));
  if (!msgColNames.has('thinking')) sqlite.exec("ALTER TABLE messages ADD COLUMN thinking TEXT");
  if (!msgColNames.has('modules')) sqlite.exec("ALTER TABLE messages ADD COLUMN modules TEXT");
  if (!msgColNames.has('message_error')) sqlite.exec("ALTER TABLE messages ADD COLUMN message_error TEXT");
  if (!msgColNames.has('paused')) sqlite.exec("ALTER TABLE messages ADD COLUMN paused INTEGER DEFAULT 0");
  if (!msgColNames.has('finalized_at')) sqlite.exec("ALTER TABLE messages ADD COLUMN finalized_at TEXT");
  if (!msgColNames.has('started_at')) sqlite.exec("ALTER TABLE messages ADD COLUMN started_at INTEGER");

  const sessCols = sqlite.prepare("PRAGMA table_info('sessions')").all() as { name: string }[];
  const sessColNames = new Set(sessCols.map(c => c.name));
  if (!sessColNames.has('run_status')) sqlite.exec("ALTER TABLE sessions ADD COLUMN run_status TEXT DEFAULT 'idle'");
  if (!sessColNames.has('has_unread')) sqlite.exec("ALTER TABLE sessions ADD COLUMN has_unread INTEGER DEFAULT 0");
  if (!sessColNames.has('last_seq')) sqlite.exec("ALTER TABLE sessions ADD COLUMN last_seq INTEGER DEFAULT 0");

  const modCols = sqlite.prepare("PRAGMA table_info('modules')").all() as { name: string }[];
  const modColNames = new Set(modCols.map(c => c.name));
  if (!modColNames.has('error_message')) sqlite.exec("ALTER TABLE modules ADD COLUMN error_message TEXT");
  if (!modColNames.has('last_run_status')) sqlite.exec("ALTER TABLE modules ADD COLUMN last_run_status TEXT");
  if (!modColNames.has('last_run_error')) sqlite.exec("ALTER TABLE modules ADD COLUMN last_run_error TEXT");

  // MCP: users 表新增 API Key 相关字段
  const userCols = sqlite.prepare("PRAGMA table_info('users')").all() as { name: string }[];
  const userColNames = new Set(userCols.map(c => c.name));
  if (!userColNames.has('api_key_hash')) sqlite.exec("ALTER TABLE users ADD COLUMN api_key_hash TEXT");
  if (!userColNames.has('api_key_created_at')) sqlite.exec("ALTER TABLE users ADD COLUMN api_key_created_at TEXT");
  if (!userColNames.has('api_key_last_used_at')) sqlite.exec("ALTER TABLE users ADD COLUMN api_key_last_used_at TEXT");
  // Index for O(1) hash lookup
  sqlite.exec("CREATE INDEX IF NOT EXISTS users_api_key_hash_idx ON users (api_key_hash)");

  // Any session that was left running (or was never properly finalized due to a crash /
  // dev-server restart loop / force-kill) needs a terminal event appended so subscribers
  // don't silently hang on the last thinking/tool_call event.
  //
  // Coverage:
  //  - run_status='running'    → always finalize (runner is definitely dead post-restart)
  //  - run_status='idle' etc.  → finalize only if the LAST event isn't terminal
  //    (covers previously-restarted sessions whose run_status was reset to idle but whose
  //     event log was left in a non-terminal state)
  const candidates = sqlite.prepare(
    `SELECT id, last_seq, run_status FROM sessions WHERE run_status IS NOT NULL`
  ).all() as { id: string; last_seq: number | null; run_status: string }[];
  for (const s of candidates) {
    const lastEvent = sqlite.prepare(
      `SELECT type FROM message_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1`
    ).get(s.id) as { type: string } | undefined;
    if (!lastEvent) continue; // Session never produced events; leave alone
    const isTerminal = ['done', 'error', 'aborted', 'paused'].includes(lastEvent.type);
    if (isTerminal) continue;
    // Either still 'running' or non-terminal tail → append synthetic aborted event
    const nextSeq = (s.last_seq ?? 0) + 1;
    const lastAssistant = sqlite.prepare(
      `SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`
    ).get(s.id) as { id: number } | undefined;
    sqlite.prepare(
      `INSERT INTO message_events (session_id, message_id, seq, type, payload)
       VALUES (?, ?, ?, 'aborted', ?)`
    ).run(s.id, lastAssistant?.id ?? null, nextSeq, JSON.stringify({ reason: 'server_restart' }));
    if (lastAssistant) {
      sqlite.prepare(
        `UPDATE messages SET finalized_at = datetime('now') WHERE id = ? AND finalized_at IS NULL`
      ).run(lastAssistant.id);
    }
    sqlite.prepare(
      `UPDATE sessions SET last_seq = ? WHERE id = ?`
    ).run(nextSeq, s.id);
  }
  sqlite.exec("UPDATE sessions SET run_status = 'idle' WHERE run_status = 'running'");
  // Any module left 'creating'/'editing' after restart: treat as interrupted;
  // the proper status will be re-derived from health on next inspection.
  sqlite.exec(
    `UPDATE modules
       SET status = 'error',
           last_run_status = COALESCE(last_run_status, 'interrupted'),
           last_run_error = COALESCE(last_run_error, '服务重启中断')
       WHERE status IN ('creating','editing')`
  );
}

export { sqlite, db };
export default db;
