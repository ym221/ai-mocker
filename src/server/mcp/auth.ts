import type { FastifyRequest } from 'fastify';
import { findUserByApiKey, type ApiKeyUser } from '../core/api-key.js';

/**
 * 从请求里解析出 API Key 明文。优先 `X-API-Key`，兜底 `Authorization: Bearer mf_xxx`。
 */
export function extractApiKey(request: FastifyRequest): string | null {
  const header = request.headers['x-api-key'];
  const plain = Array.isArray(header) ? header[0] : header;
  if (plain && typeof plain === 'string' && plain.trim()) return plain.trim();

  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('mf_')) return token;
  }
  return null;
}

/** 鉴权成功返回用户信息，失败返回 null（上层决定如何响应）。 */
export function authenticateMcpRequest(request: FastifyRequest): ApiKeyUser | null {
  const plain = extractApiKey(request);
  if (!plain) return null;
  return findUserByApiKey(plain);
}
