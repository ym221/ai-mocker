<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { computed } from 'vue';
import { MessageSquare, Boxes, Settings, Shield, LogOut } from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const navItems = computed(() => {
  const items = [
    { path: '/chat', label: '对话', icon: MessageSquare },
    { path: '/modules', label: '模块', icon: Boxes },
    { path: '/settings', label: '设置', icon: Settings },
  ];
  if (authStore.isAdmin) {
    items.push({ path: '/admin', label: '管理', icon: Shield });
  }
  return items;
});

function isActive(path: string) {
  return route.path.startsWith(path);
}

function handleLogout() {
  authStore.logout();
  router.push('/login');
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Logo -->
    <div class="h-14 flex items-center px-4 border-b border-sidebar-border">
      <span class="text-lg font-bold text-sidebar-foreground">AI Mock</span>
    </div>

    <!-- Navigation -->
    <nav class="flex-1 p-2 space-y-1">
      <RouterLink
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors"
        :class="isActive(item.path)
          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'"
      >
        <component :is="item.icon" class="w-4 h-4" />
        {{ item.label }}
      </RouterLink>
    </nav>

    <!-- User section -->
    <div class="p-3 border-t border-sidebar-border">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 min-w-0">
          <div class="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-medium">
            {{ authStore.currentUser?.username?.charAt(0).toUpperCase() }}
          </div>
          <span class="text-sm truncate text-sidebar-foreground">
            {{ authStore.currentUser?.username }}
          </span>
        </div>
        <button
          @click="handleLogout"
          class="p-1.5 rounded-md text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent"
          title="退出登录"
        >
          <LogOut class="w-4 h-4" />
        </button>
      </div>
    </div>
  </div>
</template>
