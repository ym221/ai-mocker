<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useModulesStore } from '../stores/modules';
import { toast } from 'vue-sonner';
import { Button } from '../components/ui/button';
import { Play, Database, BookOpen } from 'lucide-vue-next';

const route = useRoute();
const modulesStore = useModulesStore();

const moduleName = computed(() => route.params.name as string);
const moduleData = ref<any>(null);
const activeTab = ref('endpoints');
const testResult = ref<{ url: string; method: string; status: number; body: any } | null>(null);
const docContent = ref('');

async function loadModule() {
  try {
    moduleData.value = await modulesStore.fetchModule(moduleName.value);
  } catch {
    toast.error('Failed to load module');
  }
}

async function quickTest(method: string, path: string) {
  const url = moduleData.value?.basePath + path;
  try {
    const res = await fetch(url);
    const body = await res.json();
    testResult.value = { url, method, status: res.status, body };
  } catch (err) {
    toast.error('Request failed');
  }
}

async function loadDoc() {
  try {
    docContent.value = await modulesStore.fetchModuleDoc(moduleName.value);
  } catch {
    docContent.value = 'Documentation not available';
  }
}

onMounted(() => {
  loadModule();
});
</script>

<template>
  <div class="max-w-6xl mx-auto p-6">
    <div v-if="!moduleData" class="text-center py-12 text-muted-foreground">Loading...</div>

    <template v-else>
      <!-- Header -->
      <div class="mb-6">
        <h1 class="text-2xl font-bold">{{ moduleData.displayName }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ moduleData.description }} | {{ moduleData.basePath }}</p>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-border mb-6">
        <button
          v-for="tab in [
            { id: 'endpoints', label: 'Endpoints', icon: Play },
            { id: 'data', label: 'Data', icon: Database },
            { id: 'doc', label: 'Documentation', icon: BookOpen },
          ]"
          :key="tab.id"
          @click="activeTab = tab.id; if (tab.id === 'doc') loadDoc()"
          class="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors"
          :class="activeTab === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        >
          <component :is="tab.icon" class="w-4 h-4" />
          {{ tab.label }}
        </button>
      </div>

      <!-- Endpoints Tab -->
      <div v-if="activeTab === 'endpoints'">
        <div class="space-y-3">
          <div
            v-for="ep in moduleData.meta?.endpoints || []"
            :key="ep.method + ep.path"
            class="border border-border rounded-lg p-4 flex items-center justify-between"
          >
            <div class="flex items-center gap-3">
              <span
                class="text-xs font-mono font-bold px-2 py-0.5 rounded"
                :class="{
                  'bg-green-100 text-green-700': ep.method === 'GET',
                  'bg-blue-100 text-blue-700': ep.method === 'POST',
                  'bg-yellow-100 text-yellow-700': ep.method === 'PUT',
                  'bg-red-100 text-red-700': ep.method === 'DELETE',
                }"
              >
                {{ ep.method }}
              </span>
              <span class="font-mono text-sm">{{ moduleData.basePath }}{{ ep.path }}</span>
              <span class="text-sm text-muted-foreground">{{ ep.name }}</span>
            </div>
            <Button
              v-if="ep.method === 'GET'"
              size="sm"
              variant="outline"
              @click="quickTest(ep.method, ep.path === '/:id' ? '/1' : ep.path)"
            >
              <Play class="w-3 h-3 mr-1" /> Test
            </Button>
          </div>
        </div>

        <!-- Test result -->
        <div v-if="testResult" class="mt-6 border border-border rounded-lg p-4">
          <div class="flex items-center gap-2 mb-2 text-sm">
            <span class="font-mono">{{ testResult.method }} {{ testResult.url }}</span>
            <span
              class="px-2 py-0.5 rounded text-xs font-bold"
              :class="testResult.status < 400 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'"
            >
              {{ testResult.status }}
            </span>
          </div>
          <pre class="bg-muted p-3 rounded text-xs overflow-auto max-h-[300px]">{{ JSON.stringify(testResult.body, null, 2) }}</pre>
        </div>
      </div>

      <!-- Data Tab -->
      <div v-if="activeTab === 'data'" class="text-center py-12 text-muted-foreground">
        <Database class="w-12 h-12 mx-auto mb-4 opacity-30" />
        <p>Data management table will be enhanced in later steps</p>
      </div>

      <!-- Documentation Tab -->
      <div v-if="activeTab === 'doc'">
        <div v-if="docContent" class="prose max-w-none">
          <pre class="bg-muted p-4 rounded-lg text-sm whitespace-pre-wrap">{{ docContent }}</pre>
        </div>
        <div v-else class="text-center py-12 text-muted-foreground">
          No documentation available
        </div>
      </div>
    </template>
  </div>
</template>
