<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useChatStore } from '../stores/chat';
import { useProviderStore } from '../stores/provider';
import ChatPanel from '../components/chat/ChatPanel.vue';
import { Button } from '../components/ui/button';
import { Plus, Trash2, MessageSquare } from 'lucide-vue-next';
import { toast } from '../composables/use-toast';

const route = useRoute();
const router = useRouter();
const chatStore = useChatStore();
const providerStore = useProviderStore();

const displayMessages = computed(() => chatStore.activeStream?.messages ?? []);
const isLoading = computed(() => {
  const s = chatStore.activeStream;
  if (!s) return false;
  // 流活跃中
  if (s.status === 'running' || s.status === 'connecting') return true;
  // 兜底:client SSE 断了(代理 idle 超时 / 网络抖动)→ store finally 把 status 改 'done',
  // 但后端 chat-runner 仍在跑,最后一条 assistant msg 还没拿到 streamDone。
  // 这种情况 ChatInput 仍应显示"暂停"而不是"发送",防止用户在后端还在跑时插入新消息。
  const last = s.messages[s.messages.length - 1];
  if (last?.role === 'assistant' && !last.streamDone && !last.aborted && !last.messageError) {
    return true;
  }
  return false;
});

// ==================== New-session(直接创建,不弹 dialog) ====================
// 后端 resolveProviderId 会自动用用户的 default_provider_id;model 自动用该 provider 的 default_model;
// preset 默认不选。用户想换 provider/model 在对话内 SessionMetaBar 切换。
//
// 若 SessionMetaBar 在无 session 状态下被用户改过 provider/model/preset,
// 这些选择会落在 chatStore.pendingSessionConfig 中;createSession 时一并带上。

function consumePendingConfig() {
  const p = chatStore.pendingSessionConfig;
  const opts: { providerId?: number | null; model?: string | null; presetId?: number | null } = {};
  if (p.providerId != null) opts.providerId = p.providerId;
  if (p.model != null) opts.model = p.model;
  if (p.presetId != null) opts.presetId = p.presetId;
  return opts;
}

async function newSession() {
  try {
    const session = await chatStore.createSession(consumePendingConfig());
    chatStore.resetPendingSessionConfig();
    await selectSession(session.id);
  } catch (e: any) {
    toast.error(e?.message || '创建会话失败');
  }
}

// ==================== Session nav ====================

async function selectSession(sessionId: string) {
  chatStore.activeSessionId = sessionId;
  await router.push(`/chat/${sessionId}`);
  const s = chatStore.getStream(sessionId);
  if (!s.loaded && !s.abortController) {
    chatStore.connect(sessionId);
  } else if (!s.abortController) {
    chatStore.connect(sessionId);
  }
  const sess = chatStore.sessions.find(x => x.id === sessionId);
  if (sess?.hasUnread) chatStore.markRead(sessionId);
}

async function handleSend(message: string) {
  let sid = chatStore.activeSessionId;
  if (!sid) {
    // 后端 resolveProviderId 自动用默认 provider + 默认 model;
    // pending overrides 由 SessionMetaBar 写入,这里消费一次
    const session = await chatStore.createSession(consumePendingConfig());
    chatStore.resetPendingSessionConfig();
    sid = session.id;
    await selectSession(sid);
  }
  await chatStore.send(sid!, message);
}

function handleStop() {
  if (chatStore.activeSessionId) chatStore.pause(chatStore.activeSessionId);
}

async function handleDeleteSession(id: string) {
  try {
    await chatStore.deleteSession(id);
  } catch {
    return;
  }
  if (chatStore.sessions.length > 0) {
    await selectSession(chatStore.sessions[0].id);
  } else {
    await router.push('/chat');
  }
}

// ========== Init ==========

onMounted(async () => {
  // Load user-default provider preference up front so the SessionMetaBar can
  // show a sensible "默认服务商 (默认)" label even before the user clicks anything.
  if (providerStore.userPreferences.defaultProviderId == null) {
    await providerStore.fetchUserPreferences().catch(() => {});
  }
  await chatStore.fetchSessions();
  const sessionId = route.params.sessionId as string;
  if (sessionId) {
    await selectSession(sessionId);
  } else if (chatStore.sessions.length > 0) {
    const first = chatStore.sessions[0].id;
    router.replace(`/chat/${first}`);
    await selectSession(first);
  }

  pollTimer = setInterval(async () => {
    try { await chatStore.fetchSessions(); } catch {}
  }, 5000);
});

let pollTimer: ReturnType<typeof setInterval> | null = null;

onBeforeUnmount(() => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});

watch(() => route.params.sessionId, async (newId) => {
  if (newId && newId !== chatStore.activeSessionId) {
    await selectSession(newId as string);
  }
});
</script>

<template>
  <div class="flex h-full">
    <!-- Session sidebar -->
    <div class="w-56 border-r border-border bg-muted/30 hidden md:flex flex-col">
      <div class="p-3">
        <Button size="sm" class="w-full" @click="newSession" data-testid="new-session-btn">
          <Plus class="w-4 h-4 mr-1" /> 新建对话
        </Button>
      </div>
      <div class="flex-1 overflow-y-auto px-2 space-y-0.5">
        <div
          v-for="s in chatStore.sessions"
          :key="s.id"
          @click="selectSession(s.id)"
          class="group flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer transition-colors"
          :class="s.id === chatStore.activeSessionId
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'"
        >
          <MessageSquare class="w-3.5 h-3.5 flex-shrink-0" />
          <span class="flex-1 truncate">{{ s.title }}</span>
          <!-- unread dot -->
          <span
            v-if="s.hasUnread && s.id !== chatStore.activeSessionId"
            class="w-2 h-2 rounded-full bg-red-500 flex-shrink-0"
            title="有未读回复"
          ></span>
          <button
            @click.stop="handleDeleteSession(s.id)"
            class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 text-destructive"
          >
            <Trash2 class="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>

    <!-- Chat panel -->
    <div class="flex-1">
      <ChatPanel
        :messages="displayMessages"
        :loading="isLoading"
        @send="handleSend"
        @stop="handleStop"
        @retry="handleSend"
      />
    </div>

  </div>
</template>
