import { SignJWT, jwtVerify } from 'jose';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from './database.js';
import { users } from './schema.js';

const getSecret = () => new TextEncoder().encode(process.env.JWT_SECRET || 'dev-secret');

interface JwtPayload {
  userId: number;
  username: string;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: number;
      username: string;
      role: string;
    };
  }
}

export async function signToken(payload: JwtPayload): Promise<string> {
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(getSecret());
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  const { payload } = await jwtVerify(token, getSecret());
  return payload as unknown as JwtPayload;
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ success: false, message: 'Missing authentication token' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token);

    // Check user exists and is active
    const user = db.select().from(users).where(eq(users.id, payload.userId)).get();
    if (!user || !user.isActive) {
      return reply.status(401).send({ success: false, message: 'User is inactive or not found' });
    }

    request.user = {
      id: user.id,
      username: user.username,
      role: user.role,
    };
  } catch {
    return reply.status(401).send({ success: false, message: 'Invalid or expired token' });
  }
}
