import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useApi } from '../composables/use-api';
import { useAuthStore } from './auth';

// ==================== Types ====================

export interface Session {
  id: string;
  title: string;
  userId: number;
  providerId: number | null;
  model: string | null;
  presetId: number | null;
  moduleName: string | null;
  runStatus: string | null;
  hasUnread: number | null;
  lastSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCallInfo {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result?: string;
}

export interface ModuleCard {
  name: string;
  displayName: string;
  description: string | null;
  basePath: string;
  status: string;
  endpointCount: number;
}

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  thinkingComplete?: boolean;
  toolCalls?: ToolCallInfo[];
  modules?: ModuleCard[];           // cards
  messageError?: string;
  streamDone?: boolean;
  aborted?: boolean;
  abortReason?: string;             // 'server_restart' | undefined (user-pause)
  startedAt?: number;               // ms timestamp from server (message.started_at)
  finishedAt?: number;              // ms timestamp; set by terminal events (done/paused/aborted/error)
}

export interface StreamEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface StreamState {
  sessionId: string;
  messages: DisplayMessage[];
  lastSeq: number;
  status: 'idle' | 'running' | 'paused' | 'done' | 'error' | 'connecting';
  abortController: AbortController | null;
  /** Whether we've ever loaded this session's events */
  loaded: boolean;
  /** Assistant startedAt (ms) of current turn — applied to the next new assistant msg */
  pendingAssistantStartedAt?: number | null;
}

// ==================== Helpers ====================

function newStreamState(sessionId: string): StreamState {
  return {
    sessionId,
    messages: [],
    lastSeq: 0,
    status: 'idle',
    abortController: null,
    loaded: false,
    pendingAssistantStartedAt: null,
  };
}

function lastMsg(s: StreamState): DisplayMessage | undefined {
  return s.messages[s.messages.length - 1];
}

function ensureAssistant(s: StreamState): DisplayMessage {
  const last = lastMsg(s);
  if (last && last.role === 'assistant' && !last.streamDone) return last;
  const msg: DisplayMessage = {
    role: 'assistant',
    content: '',
    thinking: '',
    thinkingComplete: false,
    toolCalls: [],
    modules: [],
    startedAt: s.pendingAssistantStartedAt ?? undefined,
  };
  s.messages.push(msg);
  return msg;
}

function applyEvent(s: StreamState, ev: StreamEvent): void {
  if (ev.seq <= s.lastSeq) return; // dedup
  s.lastSeq = ev.seq;
  const p = ev.payload || {};

  switch (ev.type) {
    case 'user': {
      const content = String((p as any).content ?? '');
      const startedAt = typeof (p as any).startedAt === 'number' ? (p as any).startedAt : undefined;
      // Record assistant startedAt for the next assistant turn
      s.pendingAssistantStartedAt = startedAt ?? null;
      // Dedup optimistic push: scan from the tail (not just lastMsg) because
      // send() now pushes [user, empty_assistant], so the optimistic user is
      // at index -2 not -1. Match on role+content, merge startedAt if missing.
      let merged = false;
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i];
        if (m.role === 'user' && m.content === content) {
          if (startedAt && !m.startedAt) m.startedAt = startedAt;
          merged = true;
          break;
        }
        // Stop walking if we cross a finalized assistant — that's a previous turn
        if (m.role === 'assistant' && m.streamDone) break;
      }
      if (!merged) {
        s.messages.push({ role: 'user', content, streamDone: true, startedAt });
      }
      // Also propagate startedAt onto the optimistic empty assistant placeholder
      // so the timer matches the server's real start time once it arrives.
      if (startedAt) {
        const last = s.messages[s.messages.length - 1];
        if (last && last.role === 'assistant' && !last.streamDone && !last.content && !last.thinking) {
          last.startedAt = startedAt;
        }
      }
      break;
    }
    case 'thinking': {
      const msg = ensureAssistant(s);
      msg.thinking = (msg.thinking || '') + String((p as any).text ?? '');
      break;
    }
    case 'text': {
      const msg = ensureAssistant(s);
      if (msg.thinking && !msg.thinkingComplete) msg.thinkingComplete = true;
      msg.content = (msg.content || '') + String((p as any).text ?? '');
      break;
    }
    case 'tool_call': {
      const msg = ensureAssistant(s);
      if (msg.thinking && !msg.thinkingComplete) msg.thinkingComplete = true;
      msg.toolCalls = msg.toolCalls || [];
      msg.toolCalls.push({
        callId: String((p as any).callId ?? ''),
        name: String((p as any).name ?? ''),
        args: ((p as any).args as Record<string, unknown>) || {},
        status: 'running',
      });
      break;
    }
    case 'tool_result': {
      const msg = ensureAssistant(s);
      const callId = String((p as any).callId ?? '');
      const tc = msg.toolCalls?.find(c => c.callId === callId && c.status === 'running');
      if (tc) {
        tc.status = (p as any).success === false ? 'error' : 'success';
        tc.result = String((p as any).result ?? '');
      }
      break;
    }
    case 'card': {
      const msg = ensureAssistant(s);
      const kind = (p as any).kind;
      const data = (p as any).data;
      if (kind === 'module' && data) {
        // Remove any stale card for this module from ALL previous messages (cross-turn dedup)
        for (const m of s.messages) {
          if (m.modules) {
            m.modules = m.modules.filter(c => c.name !== data.name);
          }
        }
        // Add latest card to current assistant message
        msg.modules = msg.modules || [];
        msg.modules.push(data as ModuleCard);
      }
      break;
    }
    case 'error': {
      const msg = ensureAssistant(s);
      msg.messageError = String((p as any).message ?? 'Error');
      msg.streamDone = true;
      msg.thinkingComplete = true;
      const finishedAt = (p as any).finishedAt;
      if (typeof finishedAt === 'number') msg.finishedAt = finishedAt;
      s.status = 'error';
      break;
    }
    case 'done': {
      const msg = lastMsg(s);
      if (msg && msg.role === 'assistant') {
        msg.streamDone = true;
        msg.thinkingComplete = true;
        const finishedAt = (p as any).finishedAt;
        if (typeof finishedAt === 'number') msg.finishedAt = finishedAt;
      }
      s.status = 'done';
      break;
    }
    case 'paused':
    case 'aborted': {
      const msg = lastMsg(s);
      if (msg && msg.role === 'assistant') {
        msg.streamDone = true;
        msg.aborted = true;
        msg.thinkingComplete = true;
        const reason = (p as any).reason;
        if (typeof reason === 'string') msg.abortReason = reason;
        const finishedAt = (p as any).finishedAt;
        if (typeof finishedAt === 'number') msg.finishedAt = finishedAt;
      }
      s.status = 'paused';
      break;
    }
  }
}

// ==================== Store ====================

/**
 * Config the user picked BEFORE any session exists for the current view.
 * When the user enters /chat with zero sessions, the meta-bar lets them
 * pre-select provider/model/preset; this object holds those choices until
 * ChatPage.handleSend() calls createSession() and consumes them.
 */
export interface PendingSessionConfig {
  providerId: number | null;
  model: string | null;
  presetId: number | null;
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<Session[]>([]);
  const activeSessionId = ref<string | null>(null);
  const loading = ref(false);
  const streams = ref<Map<string, StreamState>>(new Map());
  const pendingSessionConfig = ref<PendingSessionConfig>({
    providerId: null, model: null, presetId: null,
  });

  function setPendingSessionConfig(patch: Partial<PendingSessionConfig>) {
    pendingSessionConfig.value = { ...pendingSessionConfig.value, ...patch };
  }

  function resetPendingSessionConfig() {
    pendingSessionConfig.value = { providerId: null, model: null, presetId: null };
  }

  function getStream(sessionId: string): StreamState {
    let s = streams.value.get(sessionId);
    if (!s) {
      s = newStreamState(sessionId);
      streams.value.set(sessionId, s);
    }
    return s;
  }

  const activeStream = computed<StreamState | null>(() => {
    if (!activeSessionId.value) return null;
    return streams.value.get(activeSessionId.value) ?? null;
  });

  async function fetchSessions() {
    const api = useApi();
    loading.value = true;
    try {
      const res = await api.get<{ success: boolean; data: Session[] }>('/api/sessions');
      sessions.value = res.data;
    } finally {
      loading.value = false;
    }
  }

  async function createSession(options?: {
    providerId?: number | null;
    presetId?: number | null;
    model?: string | null;
    moduleName?: string;
  }) {
    const api = useApi();
    // Strip nulls so backend validation doesn't treat them as explicit set-to-null
    const body: Record<string, unknown> = { title: '新对话' };
    if (options) {
      if (options.providerId != null) body.providerId = options.providerId;
      if (options.presetId != null) body.presetId = options.presetId;
      if (options.model != null) body.model = options.model;
      if (options.moduleName) body.moduleName = options.moduleName;
    }
    const res = await api.post<{ success: boolean; data: Session }>('/api/sessions', body);
    sessions.value.unshift(res.data);
    activeSessionId.value = res.data.id;
    return res.data;
  }

  async function updateSessionConfig(
    id: string,
    config: { providerId?: number | null; presetId?: number | null; model?: string | null },
  ) {
    const api = useApi();
    const body: Record<string, unknown> = {};
    // Pass through explicit nulls to clear (providerId=null → clear), but omit undefined
    if (config.providerId !== undefined) body.providerId = config.providerId;
    if (config.presetId !== undefined) body.presetId = config.presetId;
    if (config.model !== undefined) body.model = config.model;
    const res = await api.put<{ success: boolean; data: Session }>(`/api/sessions/${id}`, body);
    const idx = sessions.value.findIndex(s => s.id === id);
    if (idx >= 0) sessions.value[idx] = res.data;
    return res.data;
  }

  async function deleteSession(id: string) {
    const api = useApi();
    // cancel any stream
    disconnect(id);
    streams.value.delete(id);
    await api.del(`/api/sessions/${id}`);
    sessions.value = sessions.value.filter(s => s.id !== id);
    if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value[0]?.id || null;
    }
  }

  async function updateSessionTitle(id: string, title: string) {
    const api = useApi();
    await api.put(`/api/sessions/${id}`, { title });
    const session = sessions.value.find(s => s.id === id);
    if (session) session.title = title;
  }

  // ---- Streaming core ----

  async function readStream(
    response: Response,
    sessionId: string,
    ac: AbortController,
  ): Promise<void> {
    const s = getStream(sessionId);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (ac.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj: any;
          try { obj = JSON.parse(line); } catch { continue; }
          handleIncoming(s, obj);
        }
      }
      if (buffer.trim()) {
        try { handleIncoming(s, JSON.parse(buffer)); } catch {}
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  function handleIncoming(s: StreamState, obj: any) {
    if (obj.type === 'meta') {
      if (typeof obj.runStatus === 'string') {
        s.status = obj.runStatus as any;
        // Terminal meta → close last assistant msg if not already
        if (obj.runStatus === 'done' || obj.runStatus === 'error' || obj.runStatus === 'paused') {
          const last = s.messages[s.messages.length - 1];
          if (last && last.role === 'assistant' && !last.streamDone) {
            last.streamDone = true;
            last.thinkingComplete = true;
          }
        }
      }
      if (typeof obj.lastSeq === 'number' && obj.lastSeq > s.lastSeq) {
        // just info; don't rewind
      }
      return;
    }
    if (typeof obj.seq === 'number') {
      applyEvent(s, obj as StreamEvent);
    }
  }

  /** Connect to the event stream for a session (GET /api/chat/stream). */
  async function connect(sessionId: string): Promise<void> {
    const s = getStream(sessionId);
    if (s.abortController) return; // already connected
    const auth = useAuthStore();
    const ac = new AbortController();
    s.abortController = ac;
    s.status = 'connecting';

    try {
      const res = await fetch(
        `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}&afterSeq=${s.lastSeq}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${auth.token}` },
          signal: ac.signal,
        },
      );
      if (!res.ok) {
        s.status = 'error';
        return;
      }
      s.loaded = true;
      await readStream(res, sessionId, ac);
      // After stream end, clear hasUnread
      markRead(sessionId).catch(() => {});
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('[chat stream]', err);
        s.status = 'error';
      }
    } finally {
      if (s.abortController === ac) s.abortController = null;
      if (s.status === 'connecting') s.status = 'idle';
      // Safety net: if session is in a terminal state but last assistant msg
      // wasn't marked streamDone (e.g. missed terminal event), force-close it
      if (s.status === 'done' || s.status === 'error' || s.status === 'paused') {
        const last = s.messages[s.messages.length - 1];
        if (last && last.role === 'assistant' && !last.streamDone) {
          last.streamDone = true;
          last.thinkingComplete = true;
        }
      }
    }
  }

  function disconnect(sessionId: string): void {
    const s = streams.value.get(sessionId);
    if (!s) return;
    s.abortController?.abort();
    s.abortController = null;
  }

  /** Send a user message; server starts runner and streams events on this same response. */
  async function send(sessionId: string, content: string): Promise<void> {
    const s = getStream(sessionId);
    // disconnect existing subscription first — the POST response will supply the new stream
    disconnect(sessionId);

    // Optimistically push user msg for instant UX; server's user event will dedup + merge startedAt
    const optimisticStartedAt = Date.now();
    s.pendingAssistantStartedAt = optimisticStartedAt;
    s.messages.push({ role: 'user', content, streamDone: true, startedAt: optimisticStartedAt });
    // Also push an empty assistant placeholder so the "进行中..." banner +
    // elapsed timer render IMMEDIATELY (not after the first thinking/tool_call
    // event arrives, which can be 5-30s into the LLM stream). The first
    // streamed event will reuse this placeholder via ensureAssistant().
    s.messages.push({
      role: 'assistant',
      content: '',
      thinking: '',
      thinkingComplete: false,
      toolCalls: [],
      modules: [],
      startedAt: optimisticStartedAt,
      streamDone: false,
    });

    const auth = useAuthStore();
    const ac = new AbortController();
    s.abortController = ac;
    s.status = 'running';
    s.loaded = true;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({ sessionId, content }),
        signal: ac.signal,
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j?.message || msg; } catch {}
        s.status = 'error';
        // surface error into UI
        applyEvent(s, { seq: s.lastSeq + 1, type: 'error', payload: { message: msg } });
        throw new Error(msg);
      }
      await readStream(res, sessionId, ac);
      // auto-title
      const userMsgs = s.messages.filter(m => m.role === 'user');
      if (userMsgs.length === 1) {
        const first = userMsgs[0].content;
        const title = first.slice(0, 30) + (first.length > 30 ? '...' : '');
        updateSessionTitle(sessionId, title).catch(() => {});
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('[chat send]', err);
      }
    } finally {
      if (s.abortController === ac) s.abortController = null;
      // If stream ended without emitting a terminal event, clear loading state
      if (s.status === 'running' || s.status === 'connecting') s.status = 'done';
      // Safety net (mirrors connect()'s behavior): if session is terminal but the
      // last assistant msg wasn't marked streamDone (missed terminal event), force-close it
      if (s.status === 'done' || s.status === 'error' || s.status === 'paused') {
        const last = s.messages[s.messages.length - 1];
        if (last && last.role === 'assistant' && !last.streamDone) {
          last.streamDone = true;
          last.thinkingComplete = true;
        }
      }
    }
  }

  /** Ask server to pause and also abort local streaming fetch. */
  async function pause(sessionId: string): Promise<void> {
    const api = useApi();
    // Abort client-side fetch so UI loading state clears immediately
    const s = streams.value.get(sessionId);
    if (s?.abortController) {
      s.abortController.abort();
      s.abortController = null;
    }
    if (s) {
      s.status = 'paused';
      // Optimistic: mark last assistant message as done+aborted so UI stops showing "进行中..."
      // (After fetch abort, we won't receive the server's 'paused' event to do this naturally.)
      const last = s.messages[s.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.streamDone = true;
        last.aborted = true;
        last.thinkingComplete = true;
      }
    }
    try { await api.post('/api/chat/pause', { sessionId }); } catch {}
  }

  async function markRead(sessionId: string): Promise<void> {
    const api = useApi();
    try {
      await api.post('/api/chat/read', { sessionId });
      const sess = sessions.value.find(x => x.id === sessionId);
      if (sess) sess.hasUnread = 0;
    } catch {}
  }

  return {
    sessions,
    activeSessionId,
    loading,
    streams,
    activeStream,
    pendingSessionConfig,
    setPendingSessionConfig,
    resetPendingSessionConfig,
    getStream,
    fetchSessions,
    createSession,
    deleteSession,
    updateSessionTitle,
    connect,
    disconnect,
    send,
    pause,
    markRead,
    updateSessionConfig,
  };
});
