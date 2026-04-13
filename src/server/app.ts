import Fastify from 'fastify';

const app = Fastify({
  logger: true,
});

app.get('/api/health', async () => {
  return { success: true, data: 'ok' };
});

export default app;
