/**
 * Headless session helper — 供 MCP 写工具桥接 ChatRunner 用。
 *
 * 设计：
 * - MCP 工具调用时新建一条 session 行（共享 sessions 表，Web UI 天然可见）
 * - 选一个可用 provider（user-owned 或 public，active 的第一个）
 * - 启动 ChatRunner.start()，通过 subscribe() 同步等 done/error/paused
 * - 期间通过 onProgress 回调把 StreamEvent 阶段摘要推给调用方
 * - 不原样转发 text/thinking 内容，保持"不泄漏文件名/表名"约束
 */

import { randomUUID } from 'crypto';
import { and, eq, desc, or } from 'drizzle-orm';
import { db } from '../../core/database.js';
import { sessions, providers, presets } from '../../core/schema.js';
import { ChatRunner, type StreamEvent } from '../../agent/chat-runner.js';

export interface HeadlessProgress {
  seq: number;
  stage: 'thinking' | 'writing' | 'tool' | 'module_update' | 'text';
  detail?: Record<string, unknown>;
}

export interface HeadlessResult {
  sessionId: string;
  status: 'done' | 'error' | 'paused' | 'aborted';
  events: StreamEvent[];
  errorMessage?: string;
}

export interface HeadlessOptions {
  userId: number;
  userContent: string;
  title: string;
  moduleName?: string;
  /** Override the provider used for this run. Must belong to the user or be public. */
  providerId?: number;
  /** Override the model used for this run (else falls back to provider.defaultModel). */
  model?: string;
  /** Override the preset by id. Must belong to the user or be public. */
  presetId?: number;
  /** Override the preset by name (user-owned lookup). Ignored if presetId is set. */
  presetName?: string;
  onProgress?: (progress: HeadlessProgress) => void | Promise<void>;
  signal?: AbortSignal;
}

function pickProviderForUser(userId: number): { id: number; defaultModel: string } | null {
  // 显式指定（测试 / 用户偏好）
  const envPreferred = Number(process.env.MCP_DEFAULT_PROVIDER_ID || '0');
  if (envPreferred > 0) {
    const p = db.select().from(providers)
      .where(and(eq(providers.id, envPreferred), eq(providers.isActive, 1)))
      .get();
    if (p) return { id: p.id, defaultModel: p.defaultModel };
  }

  // 先找 public active（通常是免费/平台默认的 seed provider）
  const pub = db.select().from(providers)
    .where(and(eq(providers.scope, 'public'), eq(providers.isActive, 1)))
    .orderBy(providers.id)  // 最早的 public = seed
    .get();
  if (pub) return { id: pub.id, defaultModel: pub.defaultModel };

  // 兜底：user-owned private active provider
  const owned = db.select().from(providers)
    .where(and(eq(providers.ownerId, userId), eq(providers.isActive, 1)))
    .orderBy(desc(providers.id))
    .get();
  if (owned) return { id: owned.id, defaultModel: owned.defaultModel };

  return null;
}

/** StreamEvent → progress 摘要（不泄漏具体内容）。 */
function toProgress(ev: StreamEvent): HeadlessProgress | null {
  switch (ev.type) {
    case 'thinking': {
      const delta = (ev.payload as any)?.delta ?? '';
      return { seq: ev.seq, stage: 'thinking', detail: { chars: String(delta).length } };
    }
    case 'text': {
      const delta = (ev.payload as any)?.delta ?? '';
      return { seq: ev.seq, stage: 'writing', detail: { chars: String(delta).length } };
    }
    case 'tool_call': {
      return { seq: ev.seq, stage: 'tool', detail: { tool: (ev.payload as any)?.name } };
    }
    case 'card': {
      const p = ev.payload as any;
      return {
        seq: ev.seq,
        stage: 'module_update',
        detail: { moduleName: p?.moduleName, status: p?.status },
      };
    }
    default:
      return null;
  }
}

/** Resolve provider override: must be user-owned or public; returns null if not found / not allowed. */
function resolveProviderOverride(userId: number, providerId: number): { id: number; defaultModel: string } | null {
  const p = db.select().from(providers)
    .where(and(
      eq(providers.id, providerId),
      eq(providers.isActive, 1),
      or(eq(providers.scope, 'public'), eq(providers.ownerId, userId)),
    ))
    .get();
  return p ? { id: p.id, defaultModel: p.defaultModel } : null;
}

/** Resolve preset by id (scope-aware) or by name (user-owned). Returns id or null. */
function resolvePreset(userId: number, presetId?: number, presetName?: string): number | null {
  if (presetId) {
    const p = db.select().from(presets)
      .where(and(
        eq(presets.id, presetId),
        eq(presets.isActive, 1),
        or(eq(presets.scope, 'public'), eq(presets.ownerId, userId)),
      ))
      .get();
    return p ? p.id : null;
  }
  if (presetName) {
    const p = db.select().from(presets)
      .where(and(
        eq(presets.name, presetName),
        eq(presets.isActive, 1),
        or(eq(presets.scope, 'public'), eq(presets.ownerId, userId)),
      ))
      .get();
    return p ? p.id : null;
  }
  return null;
}

/**
 * Run a fresh ChatRunner session end-to-end, returning once it reaches a
 * terminal state (done/error/paused/aborted).
 */
export async function runHeadlessSession(opts: HeadlessOptions): Promise<HeadlessResult> {
  // Provider: explicit override > auto-pick
  let provider: { id: number; defaultModel: string } | null = null;
  if (opts.providerId) {
    provider = resolveProviderOverride(opts.userId, opts.providerId);
    if (!provider) {
      throw new Error(`Provider id=${opts.providerId} not found, inactive, or not owned by this user.`);
    }
  } else {
    provider = pickProviderForUser(opts.userId);
    if (!provider) {
      throw new Error(
        'No active AI provider configured for this user. Please add one in Settings → Providers.',
      );
    }
  }

  // Preset override
  const resolvedPresetId = resolvePreset(opts.userId, opts.presetId, opts.presetName);
  if (opts.presetId && resolvedPresetId == null) {
    throw new Error(`Preset id=${opts.presetId} not found, inactive, or not owned by this user.`);
  }
  if (opts.presetName && resolvedPresetId == null) {
    throw new Error(`Preset name="${opts.presetName}" not found, inactive, or not owned by this user.`);
  }

  // Model override: opts.model > provider.defaultModel
  const model = opts.model || provider.defaultModel;

  // 1. Create sessions row
  const sessionId = randomUUID();
  db.insert(sessions).values({
    id: sessionId,
    title: opts.title,
    userId: opts.userId,
    providerId: provider.id,
    model,
    presetId: resolvedPresetId,
    moduleName: opts.moduleName ?? null,
  }).run();

  const runner = ChatRunner.getOrCreate(sessionId);

  // 2. Handle abort
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try { runner.pause(); } catch { /* ignore */ }
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  // 3. Start generation
  try {
    await runner.start({ userId: opts.userId, userContent: opts.userContent });
  } catch (err) {
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    const msg = err instanceof Error ? err.message : String(err);
    return { sessionId, status: 'error', events: [], errorMessage: msg };
  }

  // 4. Subscribe from seq 0 and collect events until terminal
  const events: StreamEvent[] = [];
  let status: HeadlessResult['status'] = 'error';
  let errorMessage: string | undefined;

  try {
    for await (const ev of runner.subscribe(0)) {
      events.push(ev);

      if (opts.onProgress) {
        const prog = toProgress(ev);
        if (prog) {
          try { await opts.onProgress(prog); } catch { /* don't let progress failures break gen */ }
        }
      }

      if (ev.type === 'done') { status = 'done'; break; }
      if (ev.type === 'aborted') { status = 'aborted'; break; }
      if (ev.type === 'paused') { status = 'paused'; break; }
      if (ev.type === 'error') {
        status = 'error';
        errorMessage = (ev.payload as any)?.message || 'Unknown runner error';
        break;
      }
    }
  } finally {
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }

  if (aborted && status === 'error') status = 'aborted';

  return { sessionId, status, events, errorMessage };
}
