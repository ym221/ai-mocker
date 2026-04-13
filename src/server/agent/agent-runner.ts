import { streamText, type CoreMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { db } from '../core/database.js';
import { providers, presets, sessions, messages, modules } from '../core/schema.js';
import { decrypt } from '../core/encryption.js';
import { eq, and } from 'drizzle-orm';
import { buildSystemPrompt } from './system-prompt.js';
import { buildTools } from './tool-registry.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const GENERATED_DIR = resolve('generated');

interface RunAgentOptions {
  sessionId: string;
  userId: number;
  userMessages: CoreMessage[];
}

export async function runAgent({ sessionId, userId, userMessages }: RunAgentOptions) {
  // Load session config
  const session = db.select().from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .get();
  if (!session) throw new Error('Session not found');

  // Load provider
  const providerId = session.providerId || 1; // default to first provider
  const provider = db.select().from(providers).where(eq(providers.id, providerId)).get();
  if (!provider) throw new Error('AI Provider not configured');

  // Decrypt API key
  let apiKey = '';
  if (provider.apiKeyEncrypted) {
    try {
      apiKey = decrypt(provider.apiKeyEncrypted);
    } catch {
      throw new Error('Failed to decrypt API key. Please reconfigure the provider.');
    }
  }

  // Create AI model
  const openai = createOpenAI({
    apiKey,
    baseURL: provider.baseUrl || undefined,
  });
  const model = openai(session.model || provider.defaultModel);

  // Load preset
  let preset = null;
  if (session.presetId) {
    preset = db.select().from(presets).where(eq(presets.id, session.presetId)).get();
  }

  // Load module list
  const moduleList = db.select().from(modules)
    .where(eq(modules.userId, userId))
    .all()
    .map(m => ({ name: m.name, displayName: m.displayName, description: m.description }));

  // Load module context if a module is selected
  let moduleContext: string | null = null;
  if (session.moduleName) {
    const contextPath = join(GENERATED_DIR, String(userId), session.moduleName, '_context.md');
    if (existsSync(contextPath)) {
      moduleContext = readFileSync(contextPath, 'utf-8');
    }
  }

  // Build system prompt
  const systemPrompt = buildSystemPrompt({ userId, moduleList, preset, moduleContext });

  // Load history messages from DB
  const historyMsgs = db.select().from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(messages.createdAt)
    .all();

  const allMessages: CoreMessage[] = [
    ...historyMsgs.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content || '',
    })),
    ...userMessages,
  ];

  // Build tools with userId injection
  const tools = buildTools(userId);

  // Run agent with streaming
  const result = streamText({
    model,
    system: systemPrompt,
    messages: allMessages,
    tools,
    maxSteps: 10,
    onFinish: async ({ response }) => {
      // Persist user message
      for (const msg of userMessages) {
        if (msg.role === 'user') {
          db.insert(messages).values({
            sessionId,
            role: 'user',
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          }).run();
        }
      }

      // Persist assistant messages
      for (const msg of response.messages) {
        if (msg.role === 'assistant') {
          const content = Array.isArray(msg.content)
            ? msg.content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')
            : typeof msg.content === 'string' ? msg.content : '';

          const toolCalls = Array.isArray(msg.content)
            ? msg.content.filter(p => p.type === 'tool-call')
            : null;

          db.insert(messages).values({
            sessionId,
            role: 'assistant',
            content: content || null,
            toolCalls: toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
          }).run();
        }
      }

      // Update session timestamp
      db.update(sessions)
        .set({ updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) })
        .where(eq(sessions.id, sessionId))
        .run();
    },
  });

  return result;
}
