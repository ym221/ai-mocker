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
  isActive: number;
  createdAt: string;
  updatedAt: string;
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

  return { providers, loading, fetchProviders, createProvider, updateProvider, deleteProvider };
});
