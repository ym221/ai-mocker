<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useModulesStore } from '../stores/modules';
import { Boxes } from 'lucide-vue-next';

const router = useRouter();
const modulesStore = useModulesStore();

onMounted(() => {
  modulesStore.fetchModules();
});
</script>

<template>
  <div class="max-w-6xl mx-auto p-6">
    <h1 class="text-2xl font-bold mb-6">Modules</h1>

    <div v-if="modulesStore.loading" class="text-center py-12 text-muted-foreground">
      Loading...
    </div>

    <div v-else-if="modulesStore.modules.length === 0" class="text-center py-12 text-muted-foreground">
      <Boxes class="w-12 h-12 mx-auto mb-4 opacity-30" />
      <h3 class="text-lg font-medium mb-2">No modules yet</h3>
      <p>Go to Chat to generate your first Mock API module</p>
    </div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div
        v-for="m in modulesStore.modules"
        :key="m.id"
        @click="router.push(`/modules/${m.name}`)"
        class="border border-border rounded-lg p-4 cursor-pointer hover:border-primary/50 hover:shadow-sm transition-all"
      >
        <div class="flex items-start justify-between mb-2">
          <h3 class="font-semibold text-foreground">{{ m.displayName }}</h3>
          <span
            class="text-xs px-2 py-0.5 rounded-full"
            :class="m.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'"
          >
            {{ m.status }}
          </span>
        </div>
        <p class="text-sm text-muted-foreground mb-3">{{ m.description || 'No description' }}</p>
        <div class="flex items-center justify-between text-xs text-muted-foreground">
          <span>{{ m.basePath }}</span>
          <span v-if="m.meta?.endpoints">{{ m.meta.endpoints.length }} endpoints</span>
        </div>
      </div>
    </div>
  </div>
</template>
