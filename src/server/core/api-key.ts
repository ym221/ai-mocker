import { createHmac, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { eq } from 'drizzle-orm';
import { db, sqlite } from './database.js';
import { users } from './schema.js';

const API_KEY_PREFIX = 'mf_';
const RANDOM_BYTES_LEN = 24; // 32 chars base64url

/**
 * 确保 MCP_API_KEY_SECRET 存在；未设置则生成随机值并写入 .env（仅开发环境）。
 * 生产环境建议由运维显式设置。
 */
export function ensureApiKeySecret(): string {
  let secret = process.env.MCP_API_KEY_SECRET;
  if (secret && secret.length >= 16) return secret;

  // 开发环境兜底：生成随机值并写入 .env
  secret = randomBytes(32).toString('hex');
  process.env.MCP_API_KEY_SECRET = secret;

  const envPath = resolve('.env');
  try {
    if (existsSync(envPath)) {
      const raw = readFileSync(envPath, 'utf-8');
      if (/^MCP_API_KEY_SECRET=/m.test(raw)) {
        const next = raw.replace(/^MCP_API_KEY_SECRET=.*$/m, `MCP_API_KEY_SECRET=${secret}`);
        writeFileSync(envPath, next);
      } else {
        writeFileSync(envPath, raw + `\nMCP_API_KEY_SECRET=${secret}\n`);
      }
      console.warn('[MCP] MCP_API_KEY_SECRET was missing; generated and persisted to .env');
    } else {
      console.warn('[MCP] MCP_API_KEY_SECRET missing and .env not found; using in-memory secret (MCP keys will invalidate on restart)');
    }
  } catch (err) {
    console.warn('[MCP] failed to persist MCP_API_KEY_SECRET, using in-memory value:', err);
  }
  return secret;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成一个新的 API Key（明文 + 哈希）。明文只在此刻返回。 */
export function generateApiKey(): { plain: string; hash: string } {
  const secret = ensureApiKeySecret();
  const plain = API_KEY_PREFIX + base64url(randomBytes(RANDOM_BYTES_LEN));
  const hash = createHmac('sha256', secret).update(plain).digest('hex');
  return { plain, hash };
}

/** 计算已有明文 key 的哈希（用于查询）。 */
export function hashApiKey(plain: string): string {
  const secret = ensureApiKeySecret();
  return createHmac('sha256', secret).update(plain).digest('hex');
}

export interface ApiKeyUser {
  id: number;
  username: string;
  role: string;
  isActive: number | null;
}

/** 根据明文 key 查找启用的用户；异步更新 last_used_at。 */
export function findUserByApiKey(plain: string): ApiKeyUser | null {
  if (!plain || !plain.startsWith(API_KEY_PREFIX)) return null;
  const hash = hashApiKey(plain);
  const row = db.select({
    id: users.id,
    username: users.username,
    role: users.role,
    isActive: users.isActive,
  }).from(users).where(eq(users.apiKeyHash, hash)).get();
  if (!row) return null;
  if (row.isActive !== 1) return null;
  // 异步更新 last_used_at（非阻塞）
  try {
    sqlite.prepare("UPDATE users SET api_key_last_used_at = datetime('now') WHERE id = ?").run(row.id);
  } catch {
    // 忽略更新失败
  }
  return row;
}
