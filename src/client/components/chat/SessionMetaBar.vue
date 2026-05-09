<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Settings2, Check, X as XIcon } from 'lucide-vue-next';
import { useChatStore, type Session } from '../../stores/chat';
import { useProviderStore, type ProviderModel } from '../../stores/provider';
import { usePresetStore } from '../../stores/preset';
import { toast } from '../../composables/use-toast';
import ModelCombobox from '../ai/ModelCombobox.vue';

const props = defineProps<{
  session: Session | null;
}>();

const chatStore = useChatStore();
const providerStore = useProviderStore();
const presetStore = usePresetStore();

const isRunning = computed(() =>
  props.session?.runStatus === 'running' || props.session?.runStatus === 'connecting',
);

// ---- 显示标签(非编辑模式) ----
const providerLabel = computed(() => {
  if (!props.session?.providerId) return '默认服务商';
  const p = providerStore.providers.find(x => x.id === props.session!.providerId);
  return p?.name ?? `服务商#${props.session.providerId}`;
});

const modelLabel = computed(() => {
  if (props.session?.model) return props.session.model;
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

// ---- Lazy-load options ----
watch(() => props.session?.id, async () => {
  if (!props.session) return;
  if (providerStore.providers.length === 0) {
    await providerStore.fetchProviders().catch(() => {});
  }
  if (presetStore.presets.length === 0) {
    await presetStore.fetchPresets().catch(() => {});
  }
}, { immediate: true });

// ---- 编辑状态 ----
const editing = ref(false);
const draft = ref<{ providerId: number | null; model: string | null; presetId: number | null }>({
  providerId: null, model: null, presetId: null,
});
const draftModels = ref<ProviderModel[]>([]);

async function loadDraftModels(providerId: number | null) {
  if (!providerId) { draftModels.value = []; return; }
  try {
    draftModels.value = await providerStore.fetchProviderModels(providerId);
  } catch { draftModels.value = []; }
}

// 切 provider 时自动跳到该 provider 的 default_model + 拉它的 model 列表
watch(() => draft.value.providerId, async (newId, oldId) => {
  if (!editing.value) return;
  if (newId === oldId) return;
  await loadDraftModels(newId);
  if (newId != null) {
    const p = providerStore.providers.find(x => x.id === newId);
    if (p?.defaultModel) draft.value.model = p.defaultModel;
  } else {
    draft.value.model = null;
  }
});

async function startEdit() {
  if (!props.session) return;
  if (isRunning.value) {
    toast.info('生成进行中,请等本轮结束后再切换');
    return;
  }
  draft.value = {
    providerId: props.session.providerId ?? null,
    model: props.session.model ?? null,
    presetId: props.session.presetId ?? null,
  };
  editing.value = true;
  if (draft.value.providerId) await loadDraftModels(draft.value.providerId);
}

async function saveEdit() {
  if (!props.session) return;
  try {
    await chatStore.updateSessionConfig(props.session.id, {
      providerId: draft.value.providerId,
      model: draft.value.model,
      presetId: draft.value.presetId,
    });
    editing.value = false;
    toast.success('已更新,下一轮起生效');
  } catch (e: any) {
    toast.error(e?.message || '更新失败');
  }
}

function cancelEdit() {
  editing.value = false;
}
</script>

<template>
  <div
    v-if="session"
    class="border-t border-border/50 bg-muted/20 text-xs text-muted-foreground"
  >
    <!-- 非编辑模式 -->
    <button
      v-if="!editing"
      type="button"
      class="w-full flex items-center gap-1.5 px-4 py-1.5 rounded hover:bg-accent/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      :disabled="isRunning"
      :title="isRunning ? '生成进行中,请等本轮结束后再切换' : '点击切换 provider / model / 预设'"
      data-testid="session-meta-bar"
      @click="startEdit"
    >
      <Settings2 class="w-3 h-3" />
      <span>{{ providerLabel }}</span>
      <span class="mx-1 opacity-50">·</span>
      <span>{{ modelLabel }}</span>
      <span class="mx-1 opacity-50">·</span>
      <span>{{ presetLabel }}</span>
    </button>

    <!-- 编辑模式 -->
    <div v-else class="px-4 py-2 space-y-2" data-testid="session-meta-edit">
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-1.5">
          <span class="text-xs">服务商</span>
          <select
            v-model="draft.providerId"
            class="rounded border border-input bg-background px-2 py-1 text-xs"
            data-testid="meta-provider-select"
          >
            <option :value="null">使用默认</option>
            <option v-for="p in providerStore.providers" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <label class="flex items-center gap-1.5 flex-1 min-w-[180px]">
          <span class="text-xs">模型</span>
          <div class="flex-1">
            <ModelCombobox
              v-model="draft.model"
              :suggestions="draftModels"
              placeholder="留空 = 用服务商默认"
              testid="meta-model-input"
            />
          </div>
        </label>
        <label class="flex items-center gap-1.5">
          <span class="text-xs">预设</span>
          <select
            v-model="draft.presetId"
            class="rounded border border-input bg-background px-2 py-1 text-xs"
            data-testid="meta-preset-select"
          >
            <option :value="null">不使用</option>
            <option v-for="p in presetStore.presets" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
      </div>
      <div class="flex items-center gap-2 justify-end">
        <button
          type="button"
          class="inline-flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent"
          @click="cancelEdit"
          data-testid="meta-cancel"
        >
          <XIcon class="w-3 h-3" /> 取消
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90"
          @click="saveEdit"
          data-testid="meta-save"
        >
          <Check class="w-3 h-3" /> 保存
        </button>
      </div>
    </div>
  </div>
</template>
