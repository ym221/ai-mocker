import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useApi } from '../composables/use-api';

interface Preset {
  id: number;
  name: string;
  description: string | null;
  content: string;
  scope: string;
  ownerId: number | null;
  isActive: number;
  createdAt: string;
  updatedAt: string;
}

export const usePresetStore = defineStore('preset', () => {
  const presets = ref<Preset[]>([]);
  const loading = ref(false);

  async function fetchPresets() {
    const api = useApi();
    loading.value = true;
    try {
      const res = await api.get<{ success: boolean; data: Preset[] }>('/api/presets');
      presets.value = res.data;
    } finally {
      loading.value = false;
    }
  }

  async function createPreset(data: Record<string, unknown>) {
    const api = useApi();
    await api.post('/api/presets', data);
    await fetchPresets();
  }

  async function updatePreset(id: number, data: Record<string, unknown>) {
    const api = useApi();
    await api.put(`/api/presets/${id}`, data);
    await fetchPresets();
  }

  async function deletePreset(id: number) {
    const api = useApi();
    await api.del(`/api/presets/${id}`);
    await fetchPresets();
  }

  return { presets, loading, fetchPresets, createPreset, updatePreset, deletePreset };
});
