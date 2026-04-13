<script setup lang="ts">
import { Menu } from 'lucide-vue-next';

defineEmits<{
  toggleSidebar: [];
}>();
</script>

<template>
  <header class="h-14 flex items-center justify-between px-4 border-b border-border bg-background">
    <div class="flex items-center gap-2">
      <button
        @click="$emit('toggleSidebar')"
        class="p-2 rounded-md hover:bg-accent text-foreground/70 hover:text-foreground"
      >
        <Menu class="w-5 h-5" />
      </button>
    </div>
    <div class="flex items-center gap-2">
      <!-- Provider/Model selector will be added in Step 12 -->
    </div>
  </header>
</template>
