<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
import { toast } from 'vue-sonner';
import ChatPanel from '../components/chat/ChatPanel.vue';
import { Button } from '../components/ui/button';
import { Plus, Trash2, MessageSquare } from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();
const chatStore = useChatStore();
const authStore = useAuthStore();

const messages = ref<{ role: string; content: string }[]>([]);
const isLoading = ref(false);
const abortController = ref<AbortController | null>(null);

const activeSession = computed(() =>
  chatStore.sessions.find(s => s.id === chatStore.activeSessionId)
);

async function loadMessages(sessionId: string) {
  try {
    const data = await chatStore.loadSession(sessionId);
    messages.value = (data.messages || []).map(m => ({
      role: m.role,
      content: m.content || '',
    }));
  } catch {
    messages.value = [];
  }
}

async function handleSend(message: string) {
  if (!chatStore.activeSessionId) {
    const session = await chatStore.createSession();
    router.replace(`/chat/${session.id}`);
  }

  // Add user message to UI immediately
  messages.value.push({ role: 'user', content: message });

  // Auto-title from first message
  if (messages.value.filter(m => m.role === 'user').length === 1) {
    const title = message.slice(0, 30) + (message.length > 30 ? '...' : '');
    chatStore.updateSessionTitle(chatStore.activeSessionId!, title);
  }

  isLoading.value = true;
  abortController.value = new AbortController();

  // Add empty assistant message placeholder
  messages.value.push({ role: 'assistant', content: '' });
  const assistantIndex = messages.value.length - 1;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authStore.token}`,
      },
      body: JSON.stringify({
        sessionId: chatStore.activeSessionId,
        messages: [{ role: 'user', content: message }],
      }),
      signal: abortController.value.signal,
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.message || 'Chat request failed');
    }

    // Stream response
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        messages.value[assistantIndex].content += chunk;
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      messages.value[assistantIndex].content += '\n\n[Generation stopped]';
    } else {
      toast.error((err as Error).message || 'Failed to get AI response');
      messages.value[assistantIndex].content = 'Error: ' + (err as Error).message;
    }
  } finally {
    isLoading.value = false;
    abortController.value = null;
  }
}

function handleStop() {
  abortController.value?.abort();
}

async function handleNewChat() {
  const session = await chatStore.createSession();
  messages.value = [];
  router.push(`/chat/${session.id}`);
}

async function handleSelectSession(sessionId: string) {
  chatStore.activeSessionId = sessionId;
  router.push(`/chat/${sessionId}`);
  await loadMessages(sessionId);
}

async function handleDeleteSession(id: string) {
  await chatStore.deleteSession(id);
  if (chatStore.sessions.length > 0) {
    await handleSelectSession(chatStore.sessions[0].id);
  } else {
    messages.value = [];
    router.push('/chat');
  }
}

// Init
onMounted(async () => {
  await chatStore.fetchSessions();

  const sessionId = route.params.sessionId as string;
  if (sessionId) {
    chatStore.activeSessionId = sessionId;
    await loadMessages(sessionId);
  } else if (chatStore.sessions.length > 0) {
    chatStore.activeSessionId = chatStore.sessions[0].id;
    await loadMessages(chatStore.sessions[0].id);
    router.replace(`/chat/${chatStore.sessions[0].id}`);
  }
});

watch(() => route.params.sessionId, async (newId) => {
  if (newId && newId !== chatStore.activeSessionId) {
    chatStore.activeSessionId = newId as string;
    await loadMessages(newId as string);
  }
});
</script>

<template>
  <div class="flex h-full">
    <!-- Session sidebar (inside chat) -->
    <div class="w-56 border-r border-border bg-muted/30 hidden md:flex flex-col">
      <div class="p-3">
        <Button size="sm" class="w-full" @click="handleNewChat">
          <Plus class="w-4 h-4 mr-1" /> New Chat
        </Button>
      </div>
      <div class="flex-1 overflow-y-auto px-2 space-y-0.5">
        <div
          v-for="s in chatStore.sessions"
          :key="s.id"
          @click="handleSelectSession(s.id)"
          class="group flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer transition-colors"
          :class="s.id === chatStore.activeSessionId
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'"
        >
          <MessageSquare class="w-3.5 h-3.5 flex-shrink-0" />
          <span class="flex-1 truncate">{{ s.title }}</span>
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
        :messages="messages"
        :loading="isLoading"
        @send="handleSend"
        @stop="handleStop"
      />
    </div>
  </div>
</template>
