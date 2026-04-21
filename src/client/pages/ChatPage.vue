<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useChatStore } from '../stores/chat';
import ChatPanel from '../components/chat/ChatPanel.vue';
import SessionConfigDialog, { type SessionConfigValue } from '../components/chat/SessionConfigDialog.vue';
import { Button } from '../components/ui/button';
import { Plus, Trash2, MessageSquare } from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();
const chatStore = useChatStore();

const displayMessages = computed(() => chatStore.activeStream?.messages ?? []);
const isLoading = computed(() => chatStore.activeStream?.status === 'running' || chatStore.activeStream?.status === 'connecting');

// ==================== New-session dialog ====================

const LS_KEY = 'mockforge.session-config.lastUsed';

function readLastUsed(): Partial<SessionConfigValue> | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      providerId: typeof parsed.providerId === 'number' ? parsed.providerId : null,
      model: typeof parsed.model === 'string' ? parsed.model : null,
      presetId: typeof parsed.presetId === 'number' ? parsed.presetId : null,
    };
  } catch {
    return null;
  }
}

function writeLastUsed(cfg: SessionConfigValue): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* quota / privacy mode */ }
}

const configDialogOpen = ref(false);
const configDialogInitial = ref<Partial<SessionConfigValue> | null>(null);

function openNewSessionDialog() {
  configDialogInitial.value = readLastUsed();
  configDialogOpen.value = true;
}

async function handleConfigConfirm(cfg: SessionConfigValue) {
  writeLastUsed(cfg);
  const session = await chatStore.createSession({
    providerId: cfg.providerId,
    presetId: cfg.presetId,
    model: cfg.model,
  });
  await selectSession(session.id);
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
    const last = readLastUsed();
    const session = await chatStore.createSession({
      providerId: last?.providerId ?? null,
      presetId: last?.presetId ?? null,
      model: last?.model ?? null,
    });
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
        <Button size="sm" class="w-full" @click="openNewSessionDialog" data-testid="new-session-btn">
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
      />
    </div>

    <SessionConfigDialog
      v-model:open="configDialogOpen"
      :initial="configDialogInitial"
      @confirm="handleConfigConfirm"
    />
  </div>
</template>
