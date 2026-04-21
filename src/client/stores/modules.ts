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
  errorMessage?: string | null;
  lastRunStatus?: string | null;
  lastRunError?: string | null;
  health?: 'healthy' | 'degraded' | 'missing';
  createdAt: string;
  updatedAt: string;
  meta: any;
}

export const useModulesStore = defineStore('modules', () => {
  const modules = ref<Module[]>([]);
  const loading = ref(false);

  /** In-place merge: preserve object identity so polling doesn't remount DOM nodes. */
  function mergeModules(incoming: Module[]) {
    const existingByName = new Map(modules.value.map(m => [m.name, m]));
    const next: Module[] = [];
    for (const fresh of incoming) {
      const existing = existingByName.get(fresh.name);
      if (existing) {
        Object.assign(existing, fresh);
        next.push(existing);
      } else {
        next.push(fresh);
      }
    }
    // Only mutate the array if order/membership actually changed — keeps Vue diff cheap
    const prevKey = modules.value.map(m => m.name).join('|');
    const nextKey = next.map(m => m.name).join('|');
    if (prevKey !== nextKey) {
      modules.value.splice(0, modules.value.length, ...next);
    }
  }

  async function fetchModules() {
    const api = useApi();
    loading.value = true;
    try {
      const res = await api.get<{ success: boolean; data: Module[] }>('/api/modules');
      if (modules.value.length === 0) {
        modules.value = res.data;
      } else {
        mergeModules(res.data);
      }
    } finally {
      loading.value = false;
    }
  }

  /** Silent refetch for polling — doesn't toggle loading state or rebuild array. */
  async function refetchModules() {
    const api = useApi();
    try {
      const res = await api.get<{ success: boolean; data: Module[] }>('/api/modules');
      mergeModules(res.data);
    } catch { /* silent */ }
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

  async function deleteModule(name: string) {
    const api = useApi();
    await api.del(`/api/modules/${name}`);
    modules.value = modules.value.filter(m => m.name !== name);
  }

  return { modules, loading, fetchModules, refetchModules, fetchModule, fetchModuleDoc, deleteModule };
});
