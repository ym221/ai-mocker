import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../core/database.js';
import { users } from '../core/schema.js';
import { signToken } from '../core/auth.js';
import { success } from '../core/response.js';

export default async function authRoutes(app: FastifyInstance) {
  // POST /api/auth/register
  app.post('/api/auth/register', async (request, reply) => {
    const { username, password } = request.body as { username: string; password: string };

    // Check if registration is allowed
    if (process.env.ALLOW_REGISTRATION !== 'true') {
      return reply.status(403).send({ success: false, message: 'Registration is disabled' });
    }

    // Validate
    if (!username || username.length < 3 || username.length > 20) {
      return reply.status(400).send({ success: false, message: 'Username must be 3-20 characters' });
    }
    if (!password || password.length < 6) {
      return reply.status(400).send({ success: false, message: 'Password must be at least 6 characters' });
    }

    // Check if user exists
    const existing = db.select().from(users).where(eq(users.username, username)).get();
    if (existing) {
      return reply.status(409).send({ success: false, message: 'Username already exists' });
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, 10);
    const user = db.insert(users).values({
      username,
      passwordHash,
      displayName: username,
      role: 'user',
    }).returning().get();

    return reply.status(201).send(success({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    }, 'Registration successful'));
  });

  // POST /api/auth/login
  app.post('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body as { username: string; password: string };

    if (!username || !password) {
      return reply.status(400).send({ success: false, message: 'Username and password required' });
    }

    const user = db.select().from(users).where(eq(users.username, username)).get();
    if (!user) {
      return reply.status(401).send({ success: false, message: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return reply.status(403).send({ success: false, message: 'Account is disabled' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ success: false, message: 'Invalid credentials' });
    }

    const token = await signToken({
      userId: user.id,
      username: user.username,
      role: user.role,
    });

    return success({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    }, 'Login successful');
  });
}
