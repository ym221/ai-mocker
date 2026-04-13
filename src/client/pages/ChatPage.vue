<script setup lang="ts">
import { ref, onMounted, watch, computed, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useChat } from '@ai-sdk/vue';
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

// useChat from @ai-sdk/vue — manages SSE stream, messages, tools automatically
const {
  messages: chatMessages,
  input,
  isLoading,
  error: chatError,
  append,
  stop,
  setMessages,
} = useChat({
  api: '/api/chat',
  streamProtocol: 'text',
  headers: () => ({
    Authorization: `Bearer ${authStore.token}`,
  }),
  body: () => ({
    sessionId: chatStore.activeSessionId,
  }),
  onError: (err) => {
    toast.error(err.message || 'Failed to get AI response');
  },
  onFinish: () => {
    // Auto-title from first user message
    const userMsgs = chatMessages.value.filter(m => m.role === 'user');
    if (userMsgs.length === 1 && chatStore.activeSessionId) {
      const title = userMsgs[0].content.slice(0, 30) + (userMsgs[0].content.length > 30 ? '...' : '');
      chatStore.updateSessionTitle(chatStore.activeSessionId, title);
    }
  },
});

// Convert useChat messages to the format ChatPanel expects
const displayMessages = computed(() =>
  chatMessages.value.map(m => ({
    role: m.role,
    content: m.content,
  }))
);

const activeSession = computed(() =>
  chatStore.sessions.find(s => s.id === chatStore.activeSessionId)
);

async function loadMessages(sessionId: string) {
  try {
    const data = await chatStore.loadSession(sessionId);
    if (data.messages?.length) {
      setMessages(data.messages.map(m => ({
        id: String(m.id),
        role: m.role as 'user' | 'assistant',
        content: m.content || '',
      })));
    } else {
      setMessages([]);
    }
  } catch {
    setMessages([]);
  }
}

async function handleSend(message: string) {
  if (!chatStore.activeSessionId) {
    const session = await chatStore.createSession();
    router.replace(`/chat/${session.id}`);
    await nextTick();
  }

  append({ role: 'user', content: message });
}

function handleStop() {
  stop();
}

async function handleNewChat() {
  const session = await chatStore.createSession();
  setMessages([]);
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
    setMessages([]);
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
    <!-- Session sidebar -->
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
        :messages="displayMessages"
        :loading="isLoading"
        @send="handleSend"
        @stop="handleStop"
      />
    </div>
  </div>
</template>
