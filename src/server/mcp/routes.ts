import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { authenticateMcpRequest } from './auth.js';
import { mcpUserContext } from './context.js';

/**
 * Fastify 插件：把 MCP Streamable HTTP transport 挂到 /mcp。
 * 采用 stateless 模式（sessionIdGenerator: undefined），每个请求独立处理。
 */
export default async function mcpRoutes(app: FastifyInstance) {
  const handleMcp = async (request: any, reply: any) => {
    // 1) 鉴权
    const user = authenticateMcpRequest(request);
    if (!user) {
      reply
        .code(401)
        .header('content-type', 'application/json')
        .send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Invalid or missing API key (X-API-Key header)' },
          id: null,
        });
      return;
    }

    // 2) 创建 per-request transport & server (stateless)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: false,
    });
    const server = createMcpServer();

    // 关闭时清理
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      // 3) 在 userContext 内处理请求
      await mcpUserContext.run(
        { userId: user.id, username: user.username },
        async () => {
          await transport.handleRequest(request.raw, reply.raw, (request as any).body);
        }
      );
    } catch (err) {
      app.log.error({ err }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply
          .code(500)
          .header('content-type', 'application/json')
          .send({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
      }
    }
  };

  // MCP Streamable HTTP uses POST (primary) and GET (for SSE resumption)
  app.post('/mcp', {
    // 跳过 Fastify rate-limit：MCP 调用频次由 IDE 决定，不按 REST 标准限
    config: { rateLimit: false },
  }, handleMcp);

  app.get('/mcp', {
    config: { rateLimit: false },
  }, handleMcp);

  app.delete('/mcp', {
    config: { rateLimit: false },
  }, handleMcp);
}
