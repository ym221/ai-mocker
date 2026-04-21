import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
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

// Rate limiting for API routes
await app.register(rateLimit, {
  max: process.env.NODE_ENV === 'production' ? 100 : 2000,
  timeWindow: '1 minute',
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

  // Default server error
  app.log.error(err);
  return reply.status(err.statusCode || 500).send({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// Health check
app.get('/api/health', async () => {
  return success('ok');
});

export default app;
