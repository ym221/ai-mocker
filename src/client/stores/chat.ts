import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useApi } from '../composables/use-api';

interface Session {
  id: string;
  title: string;
  userId: number;
  providerId: number | null;
  model: string | null;
  presetId: number | null;
  moduleName: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Message {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string | null;
  toolCalls: unknown[] | null;
  attachments: unknown[] | null;
  createdAt: string;
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<Session[]>([]);
  const activeSessionId = ref<string | null>(null);
  const loading = ref(false);

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

  async function createSession(options?: { providerId?: number; presetId?: number; moduleName?: string }) {
    const api = useApi();
    const res = await api.post<{ success: boolean; data: Session }>('/api/sessions', {
      title: '新对话',
      ...options,
    });
    sessions.value.unshift(res.data);
    activeSessionId.value = res.data.id;
    return res.data;
  }

  async function loadSession(sessionId: string) {
    const api = useApi();
    const res = await api.get<{ success: boolean; data: Session & { messages: Message[] } }>(`/api/sessions/${sessionId}`);
    return res.data;
  }

  async function deleteSession(id: string) {
    const api = useApi();
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

  return {
    sessions,
    activeSessionId,
    loading,
    fetchSessions,
    createSession,
    loadSession,
    deleteSession,
    updateSessionTitle,
  };
});
