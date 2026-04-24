/**
 * Headless session helper — 供 MCP 写工具桥接 ChatRunner 用。
 *
 * 设计 (Step-MCP-5 后):
 * - 拆分为 startHeadlessSession() + attachAndWait(sessionId, waitMaxSec) 两相。
 * - startHeadlessSession 只负责 provider/preset 解析 + 建 sessions 行 + runner.start();
 *   返回 sessionId 后就可独立活着,即使调用方断了也不影响。
 * - attachAndWait(sessionId, waitMaxSec) 订阅 runner 事件,最多等 waitMaxSec 秒。
 *   超时返 { status: 'still-running', stage, elapsedSec, lastEventSeq },runner 继续跑。
 * - runHeadlessSession() 保留为 legacy 门面 = start + attach(无限等),行为兼容 MCP-2/3/4。
 * - 不原样转发 text/thinking 内容,保持"不泄漏文件名/表名"约束。
 */

import { randomUUID } from 'crypto';
import { and, eq, desc, or } from 'drizzle-orm';
import { db, sqlite } from '../../core/database.js';
import { sessions, providers, presets, messages, messageEvents } from '../../core/schema.js';
import { ChatRunner, type StreamEvent } from '../../agent/chat-runner.js';

export interface HeadlessProgress {
  seq: number;
  stage: 'thinking' | 'writing' | 'tool' | 'module_update' | 'text' | 'heartbeat';
  detail?: Record<string, unknown>;
}

export type HeadlessStatus = 'done' | 'error' | 'paused' | 'aborted' | 'still-running';

export interface HeadlessResult {
  sessionId: string;
  status: HeadlessStatus;
  events: StreamEvent[];
  errorMessage?: string;
  /** Set when status==='still-running' (waitMaxSec timed out). */
  stage?: string;
  /** Set when status==='still-running'. Seconds since runner started. */
  elapsedSec?: number;
  /** Set when status==='still-running'. The highest seq we observed. */
  lastEventSeq?: number;
  /** True if this result came from attaching to an already-running session. */
  attached?: boolean;
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

export interface AttachOptions {
  fromSeq?: number;
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
      const delta = (ev.payload as any)?.delta ?? (ev.payload as any)?.text ?? '';
      return { seq: ev.seq, stage: 'thinking', detail: { chars: String(delta).length } };
    }
    case 'text': {
      const delta = (ev.payload as any)?.delta ?? (ev.payload as any)?.text ?? '';
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
        detail: { moduleName: p?.data?.moduleName ?? p?.moduleName, status: p?.data?.status ?? p?.status },
      };
    }
    case 'heartbeat': {
      const p = ev.payload as any;
      return {
        seq: ev.seq,
        stage: 'heartbeat',
        detail: { stage: p?.stage, elapsedSec: p?.elapsedSec, currentToolCall: p?.currentToolCall ?? null },
      };
    }
    default:
      return null;
  }
}

/** Map the latest StreamEvent to a short human-readable stage label. */
function stageLabelForEvent(ev: StreamEvent | undefined): string {
  if (!ev) return 'starting';
  switch (ev.type) {
    case 'thinking': return 'thinking';
    case 'text': return 'writing';
    case 'tool_call': {
      const name = (ev.payload as any)?.name || 'tool';
      return `tool:${name}`;
    }
    case 'tool_result': {
      const name = (ev.payload as any)?.name || 'tool';
      return `tool_result:${name}`;
    }
    case 'card': {
      const p = ev.payload as any;
      const mn = p?.data?.moduleName ?? p?.moduleName;
      return mn ? `module_update:${mn}` : 'module_update';
    }
    case 'user': return 'starting';
    case 'done': return 'done';
    case 'error': return 'error';
    case 'paused': return 'paused';
    case 'aborted': return 'aborted';
    default: return ev.type;
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
 * Start a new headless session: resolve provider/preset, insert sessions row,
 * kick off ChatRunner.start(). Returns immediately after the runner has been
 * told to start — does NOT wait for events.
 */
export async function startHeadlessSession(opts: HeadlessOptions): Promise<{ sessionId: string; runner: ChatRunner }> {
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

  // 2. Start generation (fire-and-forget — runner.start kicks off background work and returns)
  await runner.start({ userId: opts.userId, userContent: opts.userContent });

  return { sessionId, runner };
}

/** Look up starting wall-clock (ms) for the given session's assistant turn. */
function lookupSessionStartedAt(sessionId: string): number | null {
  const row = sqlite.prepare(
    `SELECT started_at FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`,
  ).get(sessionId) as { started_at: number | null } | undefined;
  return row?.started_at ?? null;
}

/**
 * Attach to an existing session: subscribe from fromSeq (default 0), collect events
 * until the runner hits a terminal state or waitMaxSec elapses. When the waitMaxSec
 * timer fires first, returns { status:'still-running', stage, elapsedSec, lastEventSeq }
 * — the underlying runner keeps going in the background.
 *
 * A live ChatRunner is required for "still-running" returns to be meaningful;
 * if the runner has already reached terminal, we drain DB events and return the
 * terminal status directly.
 */
export async function attachAndWait(
  sessionId: string,
  waitMaxSec: number | undefined,
  attachOpts: AttachOptions = {},
): Promise<HeadlessResult> {
  const runner = ChatRunner.getOrCreate(sessionId);
  const fromSeq = attachOpts.fromSeq ?? 0;

  const events: StreamEvent[] = [];
  let status: HeadlessStatus = 'still-running';
  let errorMessage: string | undefined;
  let lastEvent: StreamEvent | undefined;

  // Abort wiring
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try { runner.pause(); } catch { /* ignore */ }
  };
  if (attachOpts.signal) {
    if (attachOpts.signal.aborted) onAbort();
    else attachOpts.signal.addEventListener('abort', onAbort, { once: true });
  }

  // waitMaxSec timer
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = waitMaxSec && waitMaxSec > 0
    ? new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => { timedOut = true; resolve('timeout'); }, waitMaxSec * 1000);
      })
    : null;

  const subscription = (async () => {
    for await (const ev of runner.subscribe(fromSeq)) {
      events.push(ev);
      lastEvent = ev;

      if (attachOpts.onProgress) {
        const prog = toProgress(ev);
        if (prog) {
          try { await attachOpts.onProgress(prog); } catch { /* don't let progress failures break gen */ }
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

      // waitMaxSec check — short-circuit so we don't block on subscribe's await
      if (timedOut) break;
    }
    return 'subscribed' as const;
  })();

  try {
    if (timeoutPromise) {
      const winner = await Promise.race([subscription, timeoutPromise]);
      if (winner === 'timeout') {
        // Mark still-running. Subscription continues in background; we don't await it here.
        status = 'still-running';
      }
    } else {
      await subscription;
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (attachOpts.signal) attachOpts.signal.removeEventListener('abort', onAbort);
  }

  if (aborted && status === 'still-running') status = 'aborted';
  if (aborted && status === 'error' && !errorMessage) status = 'aborted';

  const result: HeadlessResult = { sessionId, status, events, errorMessage };
  if (status === 'still-running') {
    result.stage = stageLabelForEvent(lastEvent);
    result.lastEventSeq = lastEvent?.seq ?? runner.getLastSeq();
    const startedAt = lookupSessionStartedAt(sessionId);
    if (startedAt) result.elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
  }
  return result;
}

/** Alias — reattach to an in-flight session (same semantics as attachAndWait). */
export const attachToExisting = attachAndWait;

/**
 * Run a fresh ChatRunner session end-to-end. Legacy door preserved for
 * callers that just want "start + wait until terminal" with no timeout
 * (MCP-2/3/4 behavior). New MCP-5 write tools should prefer start +
 * attachAndWait directly.
 */
export async function runHeadlessSession(opts: HeadlessOptions): Promise<HeadlessResult> {
  let started: { sessionId: string; runner: ChatRunner };
  try {
    started = await startHeadlessSession(opts);
  } catch (err) {
    // Provider / preset resolution or runner.start() failed before we got a sessionId.
    const msg = err instanceof Error ? err.message : String(err);
    // Re-throw — this mirrors pre-MCP-5 behavior where provider-missing bubbles up.
    throw new Error(msg);
  }

  return attachAndWait(started.sessionId, undefined, {
    onProgress: opts.onProgress,
    signal: opts.signal,
  });
}

// ==================== Snapshot helper (for get_session_status tool) ====================

export interface SessionSnapshot {
  sessionId: string;
  status: 'running' | 'done' | 'error' | 'paused' | 'aborted';
  moduleName: string | null;
  title: string;
  stage: string;
  elapsedSec: number | null;
  lastEventSeq: number;
  recentEvents: StreamEvent[];
  errorMessage: string | null;
  startedAt: number | null;
  finalizedAt: string | null;
}

/**
 * Build a lightweight snapshot of a session — intended for the get_session_status MCP tool.
 * Reads from DB + runner registry; does NOT block or subscribe.
 */
export function getSessionSnapshot(sessionId: string, recentLimit = 10): SessionSnapshot | null {
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) return null;

  const msgRow = sqlite.prepare(
    `SELECT started_at, finalized_at, message_error FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`,
  ).get(sessionId) as { started_at: number | null; finalized_at: string | null; message_error: string | null } | undefined;

  const startedAt = msgRow?.started_at ?? null;
  const finalizedAt = msgRow?.finalized_at ?? null;

  // Most recent events (descending, then reverse)
  const recentRows = db.select().from(messageEvents)
    .where(eq(messageEvents.sessionId, sessionId))
    .orderBy(desc(messageEvents.seq))
    .limit(recentLimit)
    .all();
  const recentEvents: StreamEvent[] = recentRows
    .map((r) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(r.payload) as Record<string, unknown>; } catch { payload = {}; }
      return { seq: r.seq, type: r.type as StreamEvent['type'], payload, createdAt: r.createdAt ?? undefined };
    })
    .reverse();

  const latest = recentEvents[recentEvents.length - 1];

  // Status reconciliation: runner.isLive() source of truth when in registry.
  const runner = ChatRunner.get(sessionId);
  let status: SessionSnapshot['status'];
  if (runner && runner.isLive()) {
    status = 'running';
  } else {
    // Map DB run_status → snapshot status
    const db_s = row.runStatus || 'idle';
    if (db_s === 'running') status = 'running';
    else if (db_s === 'done') status = 'done';
    else if (db_s === 'error') status = 'error';
    else if (db_s === 'paused') {
      // If the terminal event in message_events is 'aborted', prefer that; else 'paused'.
      status = latest?.type === 'aborted' ? 'aborted' : 'paused';
    } else {
      status = 'done'; // idle post-run treated as done-ish (best-effort)
    }
  }

  const errorEvent = recentEvents.find((e) => e.type === 'error');
  const errorMessage = errorEvent
    ? ((errorEvent.payload as any)?.message ?? null)
    : (msgRow?.message_error ?? null);

  return {
    sessionId,
    status,
    moduleName: row.moduleName ?? null,
    title: row.title ?? '',
    stage: runner && runner.isLive() ? stageLabelForEvent(latest) : (status === 'done' ? 'done' : stageLabelForEvent(latest)),
    elapsedSec: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null,
    lastEventSeq: row.lastSeq ?? (latest?.seq ?? 0),
    recentEvents,
    errorMessage,
    startedAt,
    finalizedAt,
  };
}
