<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Settings2 } from 'lucide-vue-next';
import SessionConfigDialog, { type SessionConfigValue } from './SessionConfigDialog.vue';
import { useChatStore, type Session } from '../../stores/chat';
import { useProviderStore } from '../../stores/provider';
import { usePresetStore } from '../../stores/preset';
import { toast } from '../../composables/use-toast';

const props = defineProps<{
  session: Session | null;
}>();

const chatStore = useChatStore();
const providerStore = useProviderStore();
const presetStore = usePresetStore();

const isRunning = computed(() =>
  props.session?.runStatus === 'running' || props.session?.runStatus === 'connecting',
);

const providerLabel = computed(() => {
  if (!props.session?.providerId) return '默认服务商';
  const p = providerStore.providers.find(x => x.id === props.session!.providerId);
  return p?.name ?? `服务商#${props.session.providerId}`;
});

const modelLabel = computed(() => {
  if (props.session?.model) return props.session.model;
  // Fall back to the provider's default if we can see it
  if (props.session?.providerId) {
    const p = providerStore.providers.find(x => x.id === props.session!.providerId);
    if (p?.defaultModel) return `${p.defaultModel} (默认)`;
  }
  return '默认模型';
});

const presetLabel = computed(() => {
  if (!props.session?.presetId) return '无预设';
  const p = presetStore.presets.find(x => x.id === props.session!.presetId);
  return p?.name ?? `预设#${props.session.presetId}`;
});

// Lazy-load dropdown options so labels are accurate
watch(() => props.session?.id, async () => {
  if (!props.session) return;
  if (providerStore.providers.length === 0) {
    await providerStore.fetchProviders().catch(() => { /* toast handled */ });
  }
  if (presetStore.presets.length === 0) {
    await presetStore.fetchPresets().catch(() => { /* toast handled */ });
  }
}, { immediate: true });

// ---- Dialog ----

const dialogOpen = ref(false);
const dialogInitial = ref<Partial<SessionConfigValue> | null>(null);

function openSwitcher() {
  if (!props.session) return;
  if (isRunning.value) {
    toast.info('生成进行中,请等本轮结束后再切换');
    return;
  }
  dialogInitial.value = {
    providerId: props.session.providerId,
    model: props.session.model,
    presetId: props.session.presetId,
  };
  dialogOpen.value = true;
}

async function onConfirm(cfg: SessionConfigValue) {
  if (!props.session) return;
  try {
    await chatStore.updateSessionConfig(props.session.id, {
      providerId: cfg.providerId,
      model: cfg.model,
      presetId: cfg.presetId,
    });
    toast.success('会话配置已更新,下一轮起生效');
  } catch {
    toast.error('更新失败,请重试');
  }
}
</script>

<template>
  <div
    v-if="session"
    class="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground border-t border-border/50 bg-muted/20"
  >
    <button
      type="button"
      class="inline-flex items-center gap-1.5 px-2 py-1 rounded hover:bg-accent/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      :disabled="isRunning"
      :title="isRunning ? '生成进行中,请等本轮结束后再切换' : '点击切换 provider / model / 预设'"
      data-testid="session-meta-bar"
      @click="openSwitcher"
    >
      <Settings2 class="w-3 h-3" />
      <span>
        <span>{{ providerLabel }}</span>
        <span class="mx-1 opacity-50">·</span>
        <span>{{ modelLabel }}</span>
        <span class="mx-1 opacity-50">·</span>
        <span>{{ presetLabel }}</span>
      </span>
    </button>

    <SessionConfigDialog
      v-model:open="dialogOpen"
      :initial="dialogInitial"
      title="切换会话配置"
      description="仅对下一轮生成生效,不影响当前正在进行的会话。"
      confirm-text="保存"
      @confirm="onConfirm"
    />
  </div>
</template>
