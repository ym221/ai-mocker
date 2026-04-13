import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useApi } from '../composables/use-api';

interface Module {
  id: number;
  name: string;
  displayName: string;
  description: string | null;
  basePath: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  meta: any;
}

export const useModulesStore = defineStore('modules', () => {
  const modules = ref<Module[]>([]);
  const loading = ref(false);

  async function fetchModules() {
    const api = useApi();
    loading.value = true;
    try {
      const res = await api.get<{ success: boolean; data: Module[] }>('/api/modules');
      modules.value = res.data;
    } finally {
      loading.value = false;
    }
  }

  async function fetchModule(name: string) {
    const api = useApi();
    const res = await api.get<{ success: boolean; data: Module }>(`/api/modules/${name}`);
    return res.data;
  }

  async function fetchModuleDoc(name: string) {
    const api = useApi();
    const res = await api.get<{ success: boolean; data: string }>(`/api/modules/${name}/doc`);
    return res.data;
  }

  return { modules, loading, fetchModules, fetchModule, fetchModuleDoc };
});
