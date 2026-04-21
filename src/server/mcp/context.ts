import { AsyncLocalStorage } from 'async_hooks';

/**
 * MCP 调用期间的用户上下文。
 * 通过 API Key 鉴权解析出 userId 后，用 mcpUserContext.run() 包住整个 handleRequest 调用，
 * 所有 MCP tool / resource handler 内部通过 getMcpUserId() 读取。
 */
export interface McpUserContext {
  userId: number;
  username: string;
}

export const mcpUserContext = new AsyncLocalStorage<McpUserContext>();

export function getMcpUser(): McpUserContext {
  const ctx = mcpUserContext.getStore();
  if (!ctx) {
    throw new Error('MCP user context not available. This handler must run inside mcpUserContext.run().');
  }
  return ctx;
}

export function getMcpUserId(): number {
  return getMcpUser().userId;
}
