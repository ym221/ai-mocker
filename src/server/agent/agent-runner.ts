import { streamText, stepCountIs, type CoreMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { db } from '../core/database.js';
import { providers, presets, sessions, messages, modules } from '../core/schema.js';
import { decrypt } from '../core/encryption.js';
import { eq, and } from 'drizzle-orm';
import { buildSystemPrompt } from './system-prompt.js';
import { buildTools } from './tool-registry.js';
import { createCompatFetch } from './compat-fetch.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const GENERATED_DIR = resolve('generated');

interface RunAgentOptions {
  sessionId: string;
  userId: number;
  userMessages: CoreMessage[];
  abortSignal?: AbortSignal;
}

export interface AgentResult {
  fullStream: AsyncIterable<any>;
  providerType: string;
  modelName: string;
}

export async function runAgent({ sessionId, userId, userMessages, abortSignal }: RunAgentOptions): Promise<AgentResult> {
  // Load session config
  const session = db.select().from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .get();
  if (!session) throw new Error('Session not found');

  // Load provider
  const providerId = session.providerId || 1;
  const provider = db.select().from(providers).where(eq(providers.id, providerId)).get();
  if (!provider) throw new Error('AI Provider not configured. Please go to Settings to add a provider.');

  // Decrypt API key
  let apiKey = '';
  if (provider.apiKeyEncrypted) {
    try {
      apiKey = decrypt(provider.apiKeyEncrypted);
    } catch {
      throw new Error('Failed to decrypt API key. Please reconfigure the provider.');
    }
  }

  if (!apiKey) {
    throw new Error('AI Provider API Key is not configured. Please go to Settings → AI Providers to add your API key.');
  }

  // Create AI model with compat fetch to fix non-standard SSE formats
  const openai = createOpenAI({
    apiKey,
    baseURL: provider.baseUrl || undefined,
    compatibility: 'compatible',
    fetch: createCompatFetch(provider.baseUrl || undefined),
  });
  const model = openai.chat(session.model || provider.defaultModel);

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

  // Persist user messages immediately
  for (const msg of userMessages) {
    if (msg.role === 'user') {
      db.insert(messages).values({
        sessionId,
        role: 'user',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      }).run();
    }
  }

  // Build tools with userId injection
  const tools = buildTools(userId);
  const modelName = session.model || provider.defaultModel;

  // Run agent with streaming
  const result = streamText({
    model,
    system: systemPrompt,
    messages: allMessages,
    tools,
    stopWhen: stepCountIs(20),
    abortSignal,
    onFinish: async ({ response }) => {
      // Persist assistant messages (after stream completes)
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

  return {
    fullStream: result.fullStream,
    providerType: provider.type,
    modelName,
  };
}
