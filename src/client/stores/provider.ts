import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useApi } from '../composables/use-api';

interface Provider {
  id: number;
  name: string;
  type: string;
  apiKeyEncrypted: string | null;
  baseUrl: string | null;
  defaultModel: string;
  scope: string;
  ownerId: number | null;
  isVerified: number;
  lastVerifiedAt: string | null;
  lastVerifiedError: string | null;
  isActive: number;
  createdAt: string;
  updatedAt: string;
}

export interface TestProviderResult {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  hint?: string;
  latencyMs: number;
  gotText: boolean;
  gotToolCall: boolean;
}

export const useProviderStore = defineStore('provider', () => {
  const providers = ref<Provider[]>([]);
  const loading = ref(false);

  async function fetchProviders() {
    const api = useApi();
    loading.value = true;
    try {
      const res = await api.get<{ success: boolean; data: Provider[] }>('/api/providers');
      providers.value = res.data;
    } finally {
      loading.value = false;
    }
  }

  async function createProvider(data: Record<string, unknown>) {
    const api = useApi();
    await api.post('/api/providers', data);
    await fetchProviders();
  }

  async function updateProvider(id: number, data: Record<string, unknown>) {
    const api = useApi();
    await api.put(`/api/providers/${id}`, data);
    await fetchProviders();
  }

  async function deleteProvider(id: number) {
    const api = useApi();
    await api.del(`/api/providers/${id}`);
    await fetchProviders();
  }

  /** 测试草稿配置(还没保存的表单内容) */
  async function testDraft(input: {
    type: string; apiKey?: string; baseUrl?: string | null; modelName: string;
  }): Promise<TestProviderResult> {
    const api = useApi();
    const res = await api.post<{ success: boolean; data: TestProviderResult }>(
      '/api/providers/test',
      input,
    );
    return res.data;
  }

  /** 测试已保存的 provider(后端会更新 is_verified / last_verified_*) */
  async function testSaved(id: number): Promise<TestProviderResult> {
    const api = useApi();
    const res = await api.post<{ success: boolean; data: TestProviderResult }>(
      `/api/providers/${id}/test`,
      {},
    );
    await fetchProviders(); // 拉新状态
    return res.data;
  }

  return { providers, loading, fetchProviders, createProvider, updateProvider, deleteProvider, testDraft, testSaved };
});
