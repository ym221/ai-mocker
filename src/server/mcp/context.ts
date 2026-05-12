import { AsyncLocalStorage } from 'async_hooks';

/**
 * MCP 调用期间的用户上下文。
 * 通过 API Key 鉴权解析出 userId 后，用 mcpUserContext.run() 包住整个 handleRequest 调用，
 * 所有 MCP tool / resource handler 内部通过 getMcpUserId() 读取。
 *
 * requestOrigin:AI Agent 实际连接 MCP 的 URL origin(形如 "http://39.108.114.224:9020"),
 * 由 routes.ts 从 X-Forwarded-Proto/Host/Port + Host header 推断,用于构造 mockBaseUrl,
 * 确保 AI 拿到的 mockBaseUrl 跟它访问 MCP 的地址一致 —— 解决 Docker 端口映射下
 * 容器内 PORT (3000) ≠ 宿主机暴露端口 (9020) 导致 AI 写错业务代码的问题。
 */
export interface McpUserContext {
  userId: number;
  username: string;
  requestOrigin?: string;
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

export function getMcpRequestOrigin(): string | undefined {
  return mcpUserContext.getStore()?.requestOrigin;
}
