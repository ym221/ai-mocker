/**
 * ChatRunner — 会话级后台生成执行器
 *
 * 核心职责：
 * - 启动 AI 生成（streamText），把事件批量合并后同时持久化 + emit 给订阅者
 * - 生命周期独立于 HTTP 连接：客户端断开不影响 runner 执行
 * - 支持暂停/续订：subscribe(afterSeq) 回放 DB 事件后接入实时流
 * - 空闲自动回收
 */

import { EventEmitter } from 'events';
import { streamText, stepCountIs, type CoreMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { eq, and, desc, gt } from 'drizzle-orm';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { db, sqlite } from '../core/database.js';
import { providers, presets, sessions, messages, modules, messageEvents } from '../core/schema.js';
import { decrypt } from '../core/encryption.js';
import { computeModuleHealth } from '../core/module-health.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildTools } from './tool-registry.js';
import { createCompatFetch } from './compat-fetch.js';
import { ThinkingParser } from './thinking-adapter.js';
import { buildProviderOptions, reportCacheSupport } from './prompt-cache.js';
import { decideWatchdog, buildNudgeMessage } from './watchdog.js';

const GENERATED_DIR = resolve('generated');

export type EventType =
  | 'user' | 'thinking' | 'text' | 'tool_call' | 'tool_result'
  | 'card' | 'image' | 'md' | 'error' | 'done' | 'aborted' | 'paused'
  | 'heartbeat';

export interface StreamEvent {
  seq: number;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export type RunStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';

// ==================== Registry ====================

const registry = new Map<string, ChatRunner>();
const IDLE_CLEANUP_MS = 30 * 60 * 1000;   // 活跃态清理窗口
const PAUSED_KEEP_MS = 24 * 60 * 60 * 1000; // paused runner 保留时间
const RUN_TIMEOUT_MS = Number(process.env.CHAT_RUN_TIMEOUT_MS || 10 * 60 * 1000); // 10min hard timeout (configurable)
let heartbeatMsOverride: number | null = null;
function getHeartbeatMs(): number {
  if (heartbeatMsOverride != null) return heartbeatMsOverride;
  return Number(process.env.CHAT_HEARTBEAT_MS ?? 30_000); // 0 disables heartbeat
}

// ==================== Utilities ====================

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function safeJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ==================== ChatRunner ====================

interface StartOptions {
  userId: number;
  userContent: string;
  attachments?: unknown[];
}

export class ChatRunner {
  readonly sessionId: string;
  private emitter = new EventEmitter();
  private abortController: AbortController | null = null;
  private currentMessageId: number | null = null;
  private status: RunStatus = 'idle';
  private lastSeq = 0;

  // text batching
  private textBuffer = '';
  private thinkingBuffer = '';
  private flushTimer: NodeJS.Timeout | null = null;
  private static readonly FLUSH_MS = 50;
  private static readonly FLUSH_CHARS = 200;

  private idleTimer: NodeJS.Timeout | null = null;
  private runTimeoutTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastToolCallName: string | null = null;
  private lastStageLabel: string = 'starting';
  private assistantStartedAt: number | null = null;
  private moduleIntent: { moduleName: string; operation: 'create' | 'edit' } | null = null;
  private pendingCardUserId: number | null = null;
  private pendingCardModules: Set<string> = new Set();
  private currentUserContent = '';

  private constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.emitter.setMaxListeners(50);

    // Load existing lastSeq
    const sess = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (sess) this.lastSeq = sess.lastSeq ?? 0;
  }

  // ----- Registry -----

  static get(sessionId: string): ChatRunner | null {
    return registry.get(sessionId) ?? null;
  }

  static getOrCreate(sessionId: string): ChatRunner {
    let r = registry.get(sessionId);
    if (!r) {
      r = new ChatRunner(sessionId);
      registry.set(sessionId, r);
    }
    r.bumpIdleTimer();
    return r;
  }

  getStatus(): RunStatus { return this.status; }
  getLastSeq(): number { return this.lastSeq; }
  getCurrentMessageId(): number | null { return this.currentMessageId; }

  isLive(): boolean { return this.status === 'running'; }

  // ----- Idle cleanup -----

  private bumpIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ttl = this.status === 'paused' ? PAUSED_KEEP_MS : IDLE_CLEANUP_MS;
    this.idleTimer = setTimeout(() => this.dispose(), ttl);
  }

  private dispose(): void {
    if (this.status === 'running') return; // 保护
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.emitter.removeAllListeners();
    registry.delete(this.sessionId);
  }

  // ----- Event append (DB + emit) -----

  /** Append event to DB + emit; seq auto-increment. Returns new seq (or -1 if session gone). */
  private appendEvent(type: EventType, payload: Record<string, unknown>, messageId: number | null = null): number {
    this.lastSeq += 1;
    const seq = this.lastSeq;
    const payloadStr = JSON.stringify(payload);
    const createdAt = now();

    try {
      const stmt = sqlite.prepare(
        `INSERT INTO message_events (session_id, message_id, seq, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      stmt.run(this.sessionId, messageId ?? this.currentMessageId, seq, type, payloadStr, createdAt);

      // update sessions.lastSeq
      sqlite.prepare(`UPDATE sessions SET last_seq = ? WHERE id = ?`).run(seq, this.sessionId);
    } catch (err: any) {
      // Session/message may have been deleted; stop runner and cleanup
      if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        this.status = 'done';
        if (this.abortController) this.abortController.abort();
        this.emitter.emit('close');
        registry.delete(this.sessionId);
        return -1;
      }
      throw err;
    }

    const ev: StreamEvent = { seq, type, payload, createdAt };
    this.emitter.emit('event', ev);
    return seq;
  }

  // ----- Subscription -----

  /**
   * Subscribe to events with seq > afterSeq.
   * Yields DB-replayed events first, then live events.
   * Returns when runner reaches terminal state AND queue drained.
   */
  async *subscribe(afterSeq: number): AsyncGenerator<StreamEvent> {
    // Buffer live events while replaying DB
    const liveQueue: StreamEvent[] = [];
    let resolver: ((v: StreamEvent | null) => void) | null = null;
    let closed = false;

    const listener = (ev: StreamEvent) => {
      if (resolver) { resolver(ev); resolver = null; }
      else liveQueue.push(ev);
    };
    const closeListener = () => {
      closed = true;
      if (resolver) { resolver(null); resolver = null; }
    };

    this.emitter.on('event', listener);
    this.emitter.on('close', closeListener);
    this.bumpIdleTimer();

    try {
      // Replay DB events strictly greater than afterSeq
      const past = db.select().from(messageEvents)
        .where(and(eq(messageEvents.sessionId, this.sessionId), gt(messageEvents.seq, afterSeq)))
        .orderBy(messageEvents.seq)
        .all();

      let lastReplayedSeq = afterSeq;
      for (const row of past) {
        lastReplayedSeq = row.seq;
        const payload = safeJson(row.payload) as Record<string, unknown> ?? {};
        yield { seq: row.seq, type: row.type as EventType, payload, createdAt: row.createdAt ?? undefined };
      }

      // If runner already in a terminal state AND no more events coming, end.
      if (!this.isLive() && liveQueue.length === 0) {
        // maybe the terminal event already in DB, we've yielded it.
        return;
      }

      // Live loop: drain liveQueue (filtering duplicates already replayed), then await more.
      while (true) {
        // drain buffered live first
        while (liveQueue.length > 0) {
          const ev = liveQueue.shift()!;
          if (ev.seq > lastReplayedSeq) {
            lastReplayedSeq = ev.seq;
            yield ev;
          }
        }
        if (closed) return;
        if (!this.isLive() && this.status !== 'paused') {
          // After live buffer drained and runner not live: check if terminal event was sent
          return;
        }
        const next = await new Promise<StreamEvent | null>(res => { resolver = res; });
        if (!next) return;
        if (next.seq > lastReplayedSeq) {
          lastReplayedSeq = next.seq;
          yield next;
        }
      }
    } finally {
      this.emitter.off('event', listener);
      this.emitter.off('close', closeListener);
      this.bumpIdleTimer();
    }
  }

  // ----- Text / thinking batching -----

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushTextBuffers();
    }, ChatRunner.FLUSH_MS);
  }

  private flushTextBuffers(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.thinkingBuffer) {
      this.appendEvent('thinking', { text: this.thinkingBuffer });
      this.thinkingBuffer = '';
    }
    if (this.textBuffer) {
      this.appendEvent('text', { text: this.textBuffer });
      this.textBuffer = '';
    }
  }

  private bufferText(text: string): void {
    this.textBuffer += text;
    this.lastStageLabel = 'writing';
    if (this.textBuffer.length >= ChatRunner.FLUSH_CHARS) {
      this.flushTextBuffers();
    } else {
      this.scheduleFlush();
    }
  }

  private bufferThinking(text: string): void {
    this.thinkingBuffer += text;
    this.lastStageLabel = 'thinking';
    if (this.thinkingBuffer.length >= ChatRunner.FLUSH_CHARS) {
      this.flushTextBuffers();
    } else {
      this.scheduleFlush();
    }
  }

  // ----- Control -----

  /** Pause running generation. Safe to call when idle (no-op). */
  pause(): void {
    if (this.status !== 'running') return;
    if (this.abortController) this.abortController.abort();
    // Actual status transition happens in finalize() triggered by AbortError
  }

  // ----- Finalize -----

  private armRunTimeout(): void {
    this.clearRunTimeout();
    this.runTimeoutTimer = setTimeout(() => {
      if (this.status === 'running') {
        if (this.abortController) this.abortController.abort();
        // Mark explicit timeout on finalize path — set flag so streamErr handler treats it as timeout
        this._timedOut = true;
      }
    }, RUN_TIMEOUT_MS);
  }

  private clearRunTimeout(): void {
    if (this.runTimeoutTimer) { clearTimeout(this.runTimeoutTimer); this.runTimeoutTimer = null; }
  }

  private armHeartbeat(): void {
    this.clearHeartbeat();
    const ms = getHeartbeatMs();
    if (ms <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.status !== 'running') return;
      const elapsedSec = this.assistantStartedAt
        ? Math.floor((Date.now() - this.assistantStartedAt) / 1000)
        : 0;
      this.appendEvent('heartbeat', {
        stage: this.lastStageLabel,
        elapsedSec,
        currentToolCall: this.lastToolCallName,
      });
    }, ms);
    // unref so node can exit cleanly during tests
    this.heartbeatTimer.unref?.();
  }

  /** Test hook — override the heartbeat interval for this process. */
  static setHeartbeatMsForTest(ms: number | null): void {
    heartbeatMsOverride = ms;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private _timedOut = false;

  /**
   * Decide module status from health report + terminal state.
   * Key insight: physical module health (files + table) is the source of truth.
   * Session terminal result only informs `last_run_status` and decides whether
   * to delete an abandoned create-stub.
   */
  private applyModuleFinalize(terminal: 'done' | 'paused' | 'error' | 'aborted', terminalMessage?: string): void {
    if (!this.moduleIntent) return;
    const { moduleName, operation } = this.moduleIntent;
    // Infer user_id from session (moduleIntent.applyModuleIntent already set it in DB row)
    const sess = sqlite.prepare(`SELECT user_id FROM sessions WHERE id = ?`)
      .get(this.sessionId) as { user_id: number } | undefined;
    if (!sess) return;
    const userId = sess.user_id;

    const report = computeModuleHealth(userId, moduleName);

    // Compute last_run_status / last_run_error
    let lastRunStatus: string;
    let lastRunError: string | null;
    if (terminal === 'done') { lastRunStatus = 'done'; lastRunError = null; }
    else if (terminal === 'error') { lastRunStatus = this._timedOut ? 'timeout' : 'error'; lastRunError = terminalMessage || (this._timedOut ? '生成超时' : '生成失败'); }
    else { lastRunStatus = 'interrupted'; lastRunError = null; }

    // Missing = no files at all → abandoned create-stub, remove
    if (report.health === 'missing') {
      if (operation === 'create') {
        sqlite.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ?`).run(moduleName, userId);
        return;
      }
      // Edit op pointing at now-missing module — shouldn't happen; mark error
      sqlite.prepare(
        `UPDATE modules SET status = 'error', error_message = ?, last_run_status = ?, last_run_error = ?, updated_at = ?
         WHERE name = ? AND user_id = ?`
      ).run('模块文件丢失', lastRunStatus, lastRunError, now(), moduleName, userId);
      return;
    }

    // Healthy = files + meta + table all present → module usable regardless of session outcome
    if (report.health === 'healthy') {
      sqlite.prepare(
        `UPDATE modules SET status = 'active', error_message = NULL, last_run_status = ?, last_run_error = ?, updated_at = ?
         WHERE name = ? AND user_id = ?`
      ).run(lastRunStatus, lastRunError, now(), moduleName, userId);
      return;
    }

    // Degraded = some files/table missing → error; user should retry
    const missing = report.missing.length > 0
      ? `文件不完整（缺少 ${report.missing.length} 个）`
      : (!report.hasTable ? '数据表未创建' : '配置不完整');
    const errorMessage = terminalMessage || missing;
    sqlite.prepare(
      `UPDATE modules SET status = 'error', error_message = ?, last_run_status = ?, last_run_error = ?, updated_at = ?
       WHERE name = ? AND user_id = ?`
    ).run(errorMessage, lastRunStatus, lastRunError, now(), moduleName, userId);
  }

  /** Set before finalize() to emit module cards with fresh DB status. */
  stageModuleCards(userId: number, affectedModules: Iterable<string>): void {
    this.pendingCardUserId = userId;
    this.pendingCardModules = new Set(affectedModules);
  }

  private flushPendingCards(): void {
    if (this.pendingCardUserId == null || this.pendingCardModules.size === 0) return;
    const cards = loadModuleCards(this.pendingCardUserId, Array.from(this.pendingCardModules));
    for (const c of cards) {
      this.appendEvent('card', { kind: 'module', data: c });
    }
    this.pendingCardUserId = null;
    this.pendingCardModules.clear();
  }

  private finalize(terminal: 'done' | 'paused' | 'error' | 'aborted', extra?: Record<string, unknown>): void {
    this.clearRunTimeout();
    this.clearHeartbeat();
    this.flushTextBuffers();

    // Order matters: update module state first, THEN emit cards (cards carry fresh status),
    // THEN emit terminal event (subscribers may close on terminal).
    const terminalMessage = typeof extra?.message === 'string' ? (extra.message as string) : undefined;
    this.applyModuleFinalize(terminal, terminalMessage);
    this.flushPendingCards();
    this.appendEvent(terminal, extra ?? {});

    if (this.currentMessageId != null) {
      sqlite.prepare(`UPDATE messages SET finalized_at = ?, paused = ? WHERE id = ?`)
        .run(now(), terminal === 'paused' || terminal === 'aborted' ? 1 : 0, this.currentMessageId);
    }

    this.moduleIntent = null;
    this._timedOut = false;

    const newStatus: RunStatus =
      terminal === 'done' ? 'done'
        : terminal === 'error' ? 'error'
          : 'paused'; // paused & aborted both map to paused state
    this.status = newStatus;

    sqlite.prepare(`UPDATE sessions SET run_status = ?, has_unread = 1, updated_at = ? WHERE id = ?`)
      .run(newStatus, now(), this.sessionId);

    this.abortController = null;
    this.emitter.emit('close');
    this.bumpIdleTimer();
  }

  /** Public hook invoked by set_module_intent tool. Reconciles intent with DB state. */
  applyModuleIntent(userId: number, declared: { moduleName: string; operation: 'create' | 'edit' }): { moduleName: string; operation: 'create' | 'edit'; reconciled: boolean } {
    const { moduleName } = declared;
    let operation = declared.operation;
    const existing = sqlite.prepare(`SELECT id, status FROM modules WHERE name = ? AND user_id = ?`)
      .get(moduleName, userId) as { id: number; status: string } | undefined;
    let reconciled = false;
    if (operation === 'create' && existing) { operation = 'edit'; reconciled = true; }
    if (operation === 'edit' && !existing) { operation = 'create'; reconciled = true; }
    this.moduleIntent = { moduleName, operation };

    const nowStr = now();
    if (operation === 'create' && !existing) {
      // Insert stub
      sqlite.prepare(
        `INSERT INTO modules (name, user_id, display_name, description, base_path, status, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, 'creating', ?, ?)`
      ).run(moduleName, userId, moduleName, `/mock/${moduleName}`, nowStr, nowStr);
    } else if (operation === 'edit' && existing) {
      sqlite.prepare(`UPDATE modules SET status = 'editing', error_message = NULL, updated_at = ? WHERE id = ?`)
        .run(nowStr, existing.id);
    } else if (operation === 'create' && existing) {
      // Should have been reconciled above; treat as edit
      sqlite.prepare(`UPDATE modules SET status = 'editing', error_message = NULL, updated_at = ? WHERE id = ?`)
        .run(nowStr, existing.id);
    }

    this.appendEvent('card', {
      kind: 'module_intent',
      data: { moduleName, operation, reconciled },
    });
    return { moduleName, operation, reconciled };
  }

  // ----- Start -----

  /**
   * Start a new generation turn: insert user message, build context, run AI, stream events.
   * Returns immediately with { userMessageId, assistantMessageId, startSeq }.
   * Actual generation runs in background (fire-and-forget promise).
   */
  async start(opts: StartOptions): Promise<{ userMessageId: number; assistantMessageId: number; startSeq: number }> {
    if (this.status === 'running') {
      throw new Error('Session already running');
    }

    const session = db.select().from(sessions).where(eq(sessions.id, this.sessionId)).get();
    if (!session) throw new Error('Session not found');
    if (session.userId !== opts.userId) throw new Error('Forbidden');

    const startedAtMs = Date.now();
    this.assistantStartedAt = startedAtMs;
    this.moduleIntent = null;
    this.currentUserContent = opts.userContent;

    // 1. Insert user message
    const userMsg = sqlite.prepare(
      `INSERT INTO messages (session_id, role, content, attachments, started_at, created_at)
       VALUES (?, 'user', ?, ?, ?, ?) RETURNING id`
    ).get(
      this.sessionId,
      opts.userContent,
      opts.attachments ? JSON.stringify(opts.attachments) : null,
      startedAtMs,
      now(),
    ) as { id: number };

    // 2. Insert placeholder assistant message
    const assistantMsg = sqlite.prepare(
      `INSERT INTO messages (session_id, role, content, started_at, created_at) VALUES (?, 'assistant', '', ?, ?) RETURNING id`
    ).get(this.sessionId, startedAtMs, now()) as { id: number };

    this.currentMessageId = assistantMsg.id;

    // 3. Append 'user' event (persisted into event log for re-render)
    const startSeq = this.appendEvent('user', {
      content: opts.userContent,
      attachments: opts.attachments ?? null,
      startedAt: startedAtMs,
    }, userMsg.id);

    // 4. Mark session running
    sqlite.prepare(`UPDATE sessions SET run_status = 'running', has_unread = 0, updated_at = ? WHERE id = ?`)
      .run(now(), this.sessionId);
    this.status = 'running';

    // Task 7: hard timeout to auto-finalize stuck runs
    this.armRunTimeout();
    // MCP-5: periodic heartbeat while running
    this.lastStageLabel = 'starting';
    this.lastToolCallName = null;
    this.armHeartbeat();

    // 5. Kick off AI (or fake) in background
    // Test sentinels use includes() (not startsWith) so they survive MCP-tool
    // userContent wrapping like "请根据以下 API 规范/需求...规范内容：__fake_slow__".
    const u = opts.userContent || '';
    if (process.env.FAKE_AI === '1' || u.includes('__fake__') || u.includes('__fake_slow__')) {
      void this.runFakeGeneration();
    } else {
      void this.runAIGeneration(opts.userId, session);
    }

    return {
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id,
      startSeq,
    };
  }

  /**
   * Fake generation for testing: deterministic event sequence, 100ms between chunks,
   * respects abort. Useful for e2e without real AI API.
   */
  private async runFakeGeneration(): Promise<void> {
    const abortController = new AbortController();
    this.abortController = abortController;
    const sleep = (ms: number) => new Promise<void>((res, rej) => {
      const t = setTimeout(res, ms);
      abortController.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('AbortError')); });
    });

    // __fake_slow__ variant: longer pauses so UI state (banner/timer) is observable in tests
    const isSlow = (this.currentUserContent || '').includes('__fake_slow__');
    const base = isSlow ? 1500 : 150;
    const textGap = isSlow ? 1200 : 200;
    const toolGap = isSlow ? 1500 : 100;

    const acc: string[] = [];
    try {
      // thinking
      for (const t of ['分析用户问题...', '制定响应计划...']) {
        await sleep(base);
        this.bufferThinking(t);
      }
      this.flushTextBuffers();
      // tool call appears EARLY so isGenerating becomes true quickly (enables banner)
      await sleep(toolGap);
      this.lastToolCallName = 'write_file';
      this.lastStageLabel = 'tool:write_file';
      this.appendEvent('tool_call', { callId: 'fake1', name: 'write_file', args: { path: 'test/a.ts' } });
      // text chunks stream while tool still "running"
      const chunks = ['你好！', '这是一个', '模拟的', '流式回复，', '用于测试可恢复架构。'];
      for (const c of chunks) {
        await sleep(textGap);
        this.bufferText(c);
        acc.push(c);
      }
      this.flushTextBuffers();
      await sleep(toolGap);
      this.appendEvent('tool_result', { callId: 'fake1', name: 'write_file', success: true, result: 'OK' });
      // more text
      await sleep(toolGap);
      this.bufferText(' 生成完成。');
      acc.push(' 生成完成。');
      this.flushTextBuffers();

      sqlite.prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(acc.join(''), this.currentMessageId!);
      this.finalize('done');
    } catch (err: any) {
      if (abortController.signal.aborted || err?.message === 'AbortError') {
        if (this.currentMessageId != null) {
          sqlite.prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(acc.join(''), this.currentMessageId);
        }
        if (this._timedOut) {
          this.finalize('error', { message: '生成超时，已自动中断' });
        } else {
          this.finalize('paused');
        }
      } else {
        this.finalize('error', { message: String(err?.message || err) });
      }
    }
  }

  private async runAIGeneration(userId: number, session: typeof sessions.$inferSelect): Promise<void> {
    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      // ===== Load provider =====
      const providerId = session.providerId || 1;
      const provider = db.select().from(providers).where(eq(providers.id, providerId)).get();
      if (!provider) throw new Error('AI Provider not configured.');

      let apiKey = '';
      if (provider.apiKeyEncrypted) {
        try { apiKey = decrypt(provider.apiKeyEncrypted); }
        catch { throw new Error('Failed to decrypt API key.'); }
      }
      if (!apiKey) throw new Error('AI Provider API Key is not configured.');

      const openai = createOpenAI({
        apiKey,
        baseURL: provider.baseUrl || undefined,
        compatibility: 'compatible',
        fetch: createCompatFetch(provider.baseUrl || undefined),
      });
      const model = openai.chat(session.model || provider.defaultModel);

      // ===== Preset / module context =====
      let preset = null;
      if (session.presetId) {
        preset = db.select().from(presets).where(eq(presets.id, session.presetId)).get();
      }

      const moduleList = db.select().from(modules)
        .where(eq(modules.userId, userId))
        .all()
        .map(m => ({ name: m.name, displayName: m.displayName, description: m.description }));

      let moduleContext: string | null = null;
      if (session.moduleName) {
        const ctxPath = join(GENERATED_DIR, String(userId), session.moduleName, '_context.md');
        if (existsSync(ctxPath)) {
          moduleContext = readFileSync(ctxPath, 'utf-8');
        }
      }

      const systemPrompt = buildSystemPrompt({ userId, moduleList, preset, moduleContext });

      // ===== Build history from messages (excluding current assistant placeholder) =====
      const historyMsgs = db.select().from(messages)
        .where(eq(messages.sessionId, this.sessionId))
        .orderBy(messages.createdAt, messages.id)
        .all()
        .filter(m => m.id !== this.currentMessageId);

      const coreMessages: CoreMessage[] = historyMsgs
        .filter(m => m.content || m.role === 'assistant')
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content || '',
        }));

      // ===== Detect paused predecessor for continuation semantics =====
      let extraSystemSuffix = '';
      const prevAssistants = historyMsgs.filter(m => m.role === 'assistant');
      const lastAssistant = prevAssistants[prevAssistants.length - 1];
      if (lastAssistant?.paused === 1 && lastAssistant.content) {
        extraSystemSuffix = '\n\n## 续接说明\n上一条响应被用户中断，已输出部分保留。若用户要求继续或在上一条基础上追加，请延续上一条 assistant 消息的输出，不要重复已输出的内容。';
      }

      const tools = buildTools(userId, this);
      const parser = new ThinkingParser();
      const collectedToolCalls = new Map<string, { name: string; args: unknown }>();
      const affectedModules = new Set<string>();
      const assistantAccText: string[] = [];

      // ===== Prompt-cache provider options =====
      const cacheReport = reportCacheSupport(provider.type);
      const providerOptions = buildProviderOptions(provider.type);
      // Observable: surfaced in logs so users can verify cache is wired up
      try { console.log(`[prompt-cache] session=${this.sessionId} provider=${provider.type} note="${cacheReport.note}"`); } catch { /* ignore */ }

      // ===== Stream consumer (extracted so we can re-run for watchdog nudge) =====
      const consumeOneStream = async (messagesForThisAttempt: CoreMessage[]) => {
        const result = streamText({
          model,
          system: systemPrompt + extraSystemSuffix,
          messages: messagesForThisAttempt,
          tools,
          stopWhen: stepCountIs(Number(process.env.CHAT_MAX_STEPS ?? 40)),
          abortSignal: abortController.signal,
          ...(providerOptions ? { providerOptions } : {}),
        });

        for await (const part of safeFullStream(result.fullStream)) {
          if (abortController.signal.aborted) break;

          switch (part.type) {
            case 'text-delta': {
              const chunks = parser.feed(part.text);
              for (const ch of chunks) {
                if (ch.type === 'thinking') this.bufferThinking(ch.content);
                else if (ch.type === 'text') {
                  this.bufferText(ch.content);
                  assistantAccText.push(ch.content);
                } else if (ch.type === 'thinking_complete') {
                  // no-op as a discrete event; ui infers from next event
                }
              }
              break;
            }
            case 'tool-call': {
              this.flushTextBuffers();
              const callId = part.toolCallId || `${part.toolName}-${Date.now()}`;
              const args = part.input ?? part.args;
              collectedToolCalls.set(callId, { name: part.toolName, args });
              this.lastToolCallName = part.toolName;
              this.lastStageLabel = `tool:${part.toolName}`;
              this.appendEvent('tool_call', { callId, name: part.toolName, args });

              if (args && typeof args === 'object') {
                const a = args as Record<string, unknown>;
                if (part.toolName === 'write_file' && typeof a.path === 'string') {
                  const first = a.path.split('/')[0];
                  if (first && first !== a.path) affectedModules.add(first);
                } else if (part.toolName === 'write_files' && Array.isArray(a.files)) {
                  for (const f of a.files as Array<{ path?: unknown }>) {
                    if (typeof f?.path === 'string') {
                      const first = f.path.split('/')[0];
                      if (first && first !== f.path) affectedModules.add(first);
                    }
                  }
                } else if (part.toolName === 'run_test' && typeof a.moduleName === 'string') {
                  affectedModules.add(a.moduleName);
                }
              }
              break;
            }
            case 'tool-result': {
              this.flushTextBuffers();
              const raw = part.output ?? part.result;
              const resultStr = raw == null ? '完成' : (typeof raw === 'string' ? raw : JSON.stringify(raw));
              const truncated = resultStr.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr;
              const callId = part.toolCallId || '';
              const callInfo = collectedToolCalls.get(callId);
              this.appendEvent('tool_result', {
                callId,
                name: part.toolName,
                success: true,
                result: truncated,
                args: callInfo?.args ?? null,
              });
              break;
            }
          }
        }
      };

      // ===== Watchdog: don't let "done-but-empty" leak out =====
      //
      // When the LLM declared a moduleIntent (create/update) but finished the
      // stream without calling any write_file/write_files tool, the module
      // never actually hits disk — yet the session would previously finalize
      // as `done`. That masks a real bug (the model got stuck thinking).
      //
      // Fix: re-issue the same stream with an explicit system-injected user
      // nudge asking the model to write now. Try up to CHAT_NUDGE_MAX (default
      // 2) times. If the model still produces zero writes, finalize as error
      // with an actionable message, never as `done`.
      //
      // Rationale: matches "must be smooth" — MCP auto-resume already handles
      // long runs, so the worst case is another full-duration retry rather
      // than a silent failure.
      const NUDGE_MAX = Math.max(0, Number(process.env.CHAT_NUDGE_MAX ?? 2));
      const didWrite = () => {
        for (const c of collectedToolCalls.values()) {
          if (c.name === 'write_file' || c.name === 'write_files') return true;
        }
        return false;
      };
      const currentWatchdogState = (nudgesIssued: number) => ({
        moduleIntentOp: this.moduleIntent?.operation,
        hasWriteCall: didWrite(),
        nudgesIssued,
        maxNudge: NUDGE_MAX,
      });

      try {
        await consumeOneStream(coreMessages);

        // Watchdog nudge loop. decideWatchdog() returns proceed/nudge/fail.
        let nudgesIssued = 0;
        while (true) {
          if (abortController.signal.aborted) break;
          const action = decideWatchdog(currentWatchdogState(nudgesIssued));
          if (action.kind === 'proceed' || action.kind === 'fail') break;
          // action.kind === 'nudge'
          this.appendEvent('thinking', {
            content: `[framework] watchdog nudge ${action.attempt}/${action.total} — model declared intent without writing any file; re-prompting`,
          });
          const nudgeText = buildNudgeMessage(
            this.moduleIntent!.operation as 'create' | 'update',
            this.moduleIntent!.moduleName
          );
          coreMessages.push({ role: 'user', content: nudgeText });
          nudgesIssued = action.attempt;
          await consumeOneStream(coreMessages);
        }

        // flush residue from parser (one final time after possibly-multiple streams)
        for (const ch of parser.flush()) {
          if (ch.type === 'thinking') this.bufferThinking(ch.content);
          else if (ch.type === 'text') {
            this.bufferText(ch.content);
            assistantAccText.push(ch.content);
          }
        }
        this.flushTextBuffers();

        // Stage module cards (emitted inside finalize() AFTER status transitions to 'active')
        if (this.moduleIntent) affectedModules.add(this.moduleIntent.moduleName);
        this.stageModuleCards(userId, affectedModules);

        // persist assistant content snapshot to messages.content (for history rehydration)
        const finalText = assistantAccText.join('');

        // Final decision — never silently succeed if watchdog says fail.
        const finalAction = decideWatchdog(currentWatchdogState(nudgesIssued));
        if (finalAction.kind === 'fail') {
          sqlite.prepare(`UPDATE messages SET content = ?, message_error = ? WHERE id = ?`)
            .run(finalText, finalAction.message, this.currentMessageId!);
          this.finalize('error', { message: finalAction.message });
          return;
        }

        sqlite.prepare(`UPDATE messages SET content = ? WHERE id = ?`)
          .run(finalText, this.currentMessageId!);

        this.finalize('done');
      } catch (streamErr: any) {
        this.flushTextBuffers();

        // Was it an abort (from pause)?
        if (abortController.signal.aborted || streamErr?.name === 'AbortError') {
          // preserve partial content
          const finalText = assistantAccText.join('');
          if (this.currentMessageId != null) {
            sqlite.prepare(`UPDATE messages SET content = ? WHERE id = ?`)
              .run(finalText, this.currentMessageId);
          }
          // Stage cards; finalize will emit after status transition
          if (this.moduleIntent) affectedModules.add(this.moduleIntent.moduleName);
          this.stageModuleCards(userId, affectedModules);
          // If timed out, finalize as error with timeout message
          if (this._timedOut) {
            this.finalize('error', { message: '生成超时，已自动中断' });
          } else {
            this.finalize('paused');
          }
          return;
        }

        console.error('[chat-runner stream error]', streamErr?.message || streamErr);

        let errMsg = 'AI service error';
        if (streamErr?.lastError?.responseBody) {
          try {
            const parsed = JSON.parse(streamErr.lastError.responseBody);
            errMsg = parsed.error?.message || errMsg;
          } catch {}
        } else if (streamErr?.lastError?.message) {
          errMsg = streamErr.lastError.message;
        } else if (streamErr instanceof Error) {
          errMsg = streamErr.message;
        }

        // Persist partial content
        const finalText = assistantAccText.join('');
        if (this.currentMessageId != null) {
          sqlite.prepare(`UPDATE messages SET content = ?, message_error = ? WHERE id = ?`)
            .run(finalText, errMsg, this.currentMessageId);
        }

        if (this.moduleIntent) affectedModules.add(this.moduleIntent.moduleName);
        this.stageModuleCards(userId, affectedModules);
        this.finalize('error', { message: errMsg });
      }
    } catch (err: any) {
      this.flushTextBuffers();
      const errMsg = err instanceof Error ? err.message : 'Internal error';
      if (this.currentMessageId != null) {
        sqlite.prepare(`UPDATE messages SET message_error = ? WHERE id = ?`)
          .run(errMsg, this.currentMessageId);
      }
      this.finalize('error', { message: errMsg });
    }
  }
}

// ==================== Helpers ====================

async function* safeFullStream(stream: AsyncIterable<any>): AsyncIterable<any> {
  try {
    for await (const part of stream) yield part;
  } catch (err: any) {
    const isTypeError = err?.name === 'AI_TypeValidationError'
      || err?.[Symbol.for('vercel.ai.error.AI_TypeValidationError')];
    if (!isTypeError) throw err;
  }
}

interface ModuleCard {
  name: string;
  displayName: string;
  description: string | null;
  basePath: string;
  status: string;
  endpointCount: number;
}

function loadModuleCards(userId: number, names: string[]): ModuleCard[] {
  if (names.length === 0) return [];
  const rows = db.select().from(modules).all()
    .filter(m => m.userId === userId && names.includes(m.name));
  return rows.map(m => {
    let endpointCount = 0;
    const metaPath = join(GENERATED_DIR, String(userId), m.name, '_meta.json');
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        if (Array.isArray(meta.endpoints)) endpointCount = meta.endpoints.length;
      } catch {}
    }
    return {
      name: m.name,
      displayName: m.displayName,
      description: m.description,
      basePath: m.basePath,
      status: m.status ?? 'active',
      endpointCount,
    };
  });
}

// Re-export for API layer
export { loadModuleCards };
