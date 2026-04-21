<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useModulesStore } from '../stores/modules';
import { Boxes, Trash2, Loader2, AlertCircle } from 'lucide-vue-next';
import { toast } from '../composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';
import { usePageHeader } from '@/composables/use-page-header';

usePageHeader({
  title: '模块',
  description: '管理 AI 生成的 Mock API 模块',
});

const router = useRouter();
const modulesStore = useModulesStore();
const { confirm } = useConfirm();

let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  modulesStore.fetchModules();
  // Poll only while a module is in a transient state; silent refetch avoids DOM churn
  pollTimer = setInterval(() => {
    const hasTransient = modulesStore.modules.some(m => m.status === 'creating' || m.status === 'editing');
    if (hasTransient) modulesStore.refetchModules();
  }, 2000);
});

onBeforeUnmount(() => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});

const statusLabel = (s: string) => ({
  creating: '创建中...',
  editing: '编辑中',
  active: '就绪',
  error: '失败',
  disabled: '已禁用',
} as Record<string, string>)[s] || s;

function openModule(m: any, ev: MouseEvent) {
  if (m.status === 'creating') {
    ev.preventDefault();
    toast.info(`"${m.displayName}" 仍在生成中，请稍候`);
    return;
  }
  router.push(`/modules/${m.name}`);
}

async function handleDelete(name: string, displayName: string, ev: MouseEvent) {
  ev.stopPropagation();
  const ok = await confirm({
    title: `确定删除模块 "${displayName}" 吗？`,
    description: '这将删除：\n- 生成的所有文件\n- 数据库表及所有数据\n- 模块记录\n\n此操作不可撤销。',
    confirmText: '删除',
    variant: 'destructive',
  });
  if (!ok) return;
  try {
    await modulesStore.deleteModule(name);
    toast.success(`模块 "${displayName}" 已删除`);
  } catch (err) {
    toast.error((err as Error).message || '删除失败');
  }
}
</script>

<template>
  <div class="max-w-6xl mx-auto p-6 modules-container">

    <div v-if="modulesStore.loading && modulesStore.modules.length === 0" class="text-center py-12 text-muted-foreground">
      加载中...
    </div>

    <div v-else-if="modulesStore.modules.length === 0" class="text-center py-12 text-muted-foreground">
      <Boxes class="w-12 h-12 mx-auto mb-4 opacity-30" />
      <h3 class="text-lg font-medium mb-2">暂无模块</h3>
      <p>前往对话页生成你的第一个 Mock API 模块</p>
    </div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 modules-grid">
      <div
        v-for="m in modulesStore.modules"
        :key="m.name"
        @click="(ev) => openModule(m, ev)"
        class="group border border-border rounded-lg p-4 transition-all relative"
        :class="m.status === 'creating'
          ? 'opacity-70 cursor-wait pointer-events-none-hover'
          : 'cursor-pointer hover:border-primary/50 hover:shadow-sm'"
        :data-testid="`module-card-${m.name}`"
      >
        <button
          v-if="m.status !== 'creating'"
          @click="(ev) => handleDelete(m.name, m.displayName, ev)"
          class="absolute top-3 right-3 p-1.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-destructive transition-all"
          title="删除模块"
        >
          <Trash2 class="w-4 h-4" />
        </button>
        <div class="flex items-start justify-between mb-2 pr-8">
          <h3 class="font-semibold text-foreground">{{ m.displayName }}</h3>
          <span
            class="text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1"
            :class="{
              'bg-green-100 text-green-700': m.status === 'active',
              'bg-blue-100 text-blue-700': m.status === 'creating',
              'bg-yellow-100 text-yellow-700': m.status === 'editing',
              'bg-red-100 text-red-700': m.status === 'error',
              'bg-gray-100 text-gray-700': m.status === 'disabled',
            }"
            :data-testid="`status-${m.name}`"
          >
            <Loader2 v-if="m.status === 'creating' || m.status === 'editing'" class="w-3 h-3 animate-spin" />
            <AlertCircle v-else-if="m.status === 'error'" class="w-3 h-3" />
            {{ statusLabel(m.status) }}
          </span>
        </div>
        <p class="text-sm text-muted-foreground mb-3 line-clamp-2">{{ m.description || '暂无描述' }}</p>
        <div class="flex items-center justify-between text-xs text-muted-foreground">
          <span>{{ m.basePath }}</span>
          <span v-if="m.meta?.endpoints">{{ m.meta.endpoints.length }} 个接口</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modules-container {
  min-height: 400px;
  contain: layout;
}
.modules-grid {
  /* Reserve stable row height to avoid polling-induced collapse/expand flicker */
  grid-auto-rows: minmax(110px, auto);
}
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
