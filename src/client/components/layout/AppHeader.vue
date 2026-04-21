<script setup lang="ts">
import { Menu, ChevronLeft } from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import { usePageHeaderState } from '@/composables/use-page-header';

defineEmits<{
  toggleSidebar: [];
}>();

const router = useRouter();
const pageHeader = usePageHeaderState();

function goBack() {
  if (pageHeader.back) router.push(pageHeader.back);
  else router.back();
}
</script>

<template>
  <header class="h-14 flex items-center px-4 border-b border-border bg-background gap-3" data-testid="app-header">
    <button
      @click="$emit('toggleSidebar')"
      class="p-2 rounded-md hover:bg-accent text-foreground/70 hover:text-foreground shrink-0"
      data-testid="sidebar-toggle"
    >
      <Menu class="w-5 h-5" />
    </button>

    <button
      v-if="pageHeader.back"
      @click="goBack"
      class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent shrink-0"
      data-testid="page-header-back"
    >
      <ChevronLeft class="w-4 h-4" />
      返回
    </button>

    <div v-if="pageHeader.title" class="flex items-baseline gap-2 min-w-0 flex-1" data-testid="page-header">
      <h1 class="text-base font-semibold truncate" data-testid="page-header-title">{{ pageHeader.title }}</h1>
      <span v-if="pageHeader.description" class="text-xs text-muted-foreground truncate" data-testid="page-header-desc">
        {{ pageHeader.description }}
      </span>
      <span v-if="pageHeader.meta" class="text-xs text-muted-foreground/80 font-mono truncate" data-testid="page-header-meta">
        {{ pageHeader.meta }}
      </span>
    </div>
    <div v-else class="flex-1" />

    <div class="flex items-center gap-2 shrink-0" data-testid="page-header-actions">
      <component v-if="pageHeader.actionsComponent" :is="pageHeader.actionsComponent" />
    </div>
  </header>
</template>
