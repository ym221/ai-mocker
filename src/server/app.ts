import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { success } from './core/response.js';

const app = Fastify({
  logger: true,
});

// CORS — allow all origins for /mock/* routes, restricted for /api/*
await app.register(cors, {
  origin: true,
  credentials: true,
});

// File upload support
await app.register(multipart, {
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_SIZE) || 10 * 1024 * 1024, // 10MB
  },
});

// Rate limiting for API routes.
// Loopback is allow-listed: run_test drives the generated test suite by firing many
// /mock requests from 127.0.0.1, which would otherwise trip the limit and make the
// suite fail with flaky 429s — trapping the generation loop (it can never reach all-green).
await app.register(rateLimit, {
  max: process.env.NODE_ENV === 'production' ? 100 : 2000,
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
  keyGenerator: (request) => {
    return request.ip;
  },
});

// Static file serving for uploads
const uploadDir = resolve(process.env.UPLOAD_DIR || './uploads');
if (!existsSync(uploadDir)) {
  mkdirSync(uploadDir, { recursive: true });
}
await app.register(fastifyStatic, {
  root: uploadDir,
  prefix: '/uploads/',
  decorateReply: false,
});

// In production, serve frontend static files
if (process.env.NODE_ENV === 'production') {
  const clientDir = resolve('dist/client');
  if (existsSync(clientDir)) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: '/',
      decorateReply: false,
    });

    // SPA fallback:Vue Router history mode 下,/chat/:id /modules/:name 等前端路由
    // 在浏览器刷新时直接打到后端,fastify 找不到对应静态文件 → 404。
    // 这里把所有非后端 API 的 GET 请求都 fallback 到 index.html,让 Vue Router 接管。
    const indexHtmlPath = join(clientDir, 'index.html');
    let cachedIndexHtml: string | null = null;
    const getIndexHtml = (): string => {
      if (cachedIndexHtml === null && existsSync(indexHtmlPath)) {
        cachedIndexHtml = readFileSync(indexHtmlPath, 'utf-8');
      }
      return cachedIndexHtml || '';
    };
    app.setNotFoundHandler((request, reply) => {
      const url = request.url;
      const isApi = url.startsWith('/api/')
        || url.startsWith('/mock/')
        || url.startsWith('/mcp')
        || url.startsWith('/uploads/');
      if (request.method === 'GET' && !isApi) {
        const html = getIndexHtml();
        if (html) return reply.type('text/html').send(html);
      }
      return reply.status(404).send({ success: false, message: 'Resource not found' });
    });
  }
}

// Global error handler
app.setErrorHandler((err, request, reply) => {
  // Zod validation error
  if (err.name === 'ZodError') {
    return reply.status(400).send({
      success: false,
      message: 'Validation error',
      errors: err.message,
    });
  }

  // JWT errors
  if (err.message?.includes('jwt') || err.message?.includes('token')) {
    return reply.status(401).send({
      success: false,
      message: 'Authentication failed',
    });
  }

  // Rate limit
  if (err.statusCode === 429) {
    return reply.status(429).send({
      success: false,
      message: 'Too many requests, please slow down',
    });
  }

  // Not found
  if (err.statusCode === 404) {
    return reply.status(404).send({
      success: false,
      message: 'Resource not found',
    });
  }

  // Default error.
  // 4xx are client errors (validation / malformed body / bad content-type) — their
  // messages are safe and actionable, so surface them even in production. Only 5xx
  // (true server faults, may carry internals/stack) are masked in production.
  const statusCode = err.statusCode || 500;
  app.log.error(err);
  const message = statusCode < 500 || process.env.NODE_ENV !== 'production'
    ? err.message
    : 'Internal server error';
  return reply.status(statusCode).send({
    success: false,
    message,
  });
});

// Health check
app.get('/api/health', async () => {
  return success('ok');
});

export default app;
