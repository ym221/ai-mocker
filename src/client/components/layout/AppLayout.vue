<script setup lang="ts">
import AppSidebar from './AppSidebar.vue';
import AppHeader from './AppHeader.vue';
import { ref } from 'vue';

const sidebarOpen = ref(true);

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value;
}
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-background">
    <!-- Sidebar -->
    <aside
      v-show="sidebarOpen"
      class="w-48 flex-shrink-0 border-r border-border bg-sidebar hidden lg:flex flex-col"
    >
      <AppSidebar />
    </aside>

    <!-- Mobile sidebar overlay -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 bg-black/50 z-40 lg:hidden"
      @click="sidebarOpen = false"
    />
    <aside
      v-if="sidebarOpen"
      class="fixed inset-y-0 left-0 w-48 z-50 bg-sidebar border-r border-border lg:hidden flex flex-col"
    >
      <AppSidebar />
    </aside>

    <!-- Main content -->
    <div class="flex-1 flex flex-col overflow-hidden">
      <AppHeader @toggle-sidebar="toggleSidebar" />
      <main class="flex-1 overflow-auto" style="scrollbar-gutter: stable;">
        <RouterView />
      </main>
    </div>
  </div>
</template>
