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
  return p?.name ?? `#${props.session.providerId}`;
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
  return p?.name ?? `#${props.session.presetId}`;
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

// ---- 编辑态:每个字段独立 in-place(点击单元才进入编辑,不弹整行) ----
type Field = 'provider' | 'model' | 'preset' | null;
const editingField = ref<Field>(null);
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

watch(() => draft.value.providerId, async (newId, oldId) => {
  if (editingField.value === null) return;
  if (newId === oldId) return;
  await loadDraftModels(newId);
  if (newId != null) {
    const p = providerStore.providers.find(x => x.id === newId);
    if (p?.defaultModel) draft.value.model = p.defaultModel;
  } else {
    draft.value.model = null;
  }
});

function syncDraftFromSession() {
  if (!props.session) return;
  draft.value = {
    providerId: props.session.providerId ?? null,
    model: props.session.model ?? null,
    presetId: props.session.presetId ?? null,
  };
}

async function startEdit(field: Exclude<Field, null>) {
  if (!props.session) return;
  if (isRunning.value) {
    toast.info('生成进行中,请等本轮结束后再切换');
    return;
  }
  syncDraftFromSession();
  editingField.value = field;
  if (field === 'model' && draft.value.providerId) {
    await loadDraftModels(draft.value.providerId);
  }
}

async function saveEdit() {
  if (!props.session) return;
  try {
    await chatStore.updateSessionConfig(props.session.id, {
      providerId: draft.value.providerId,
      model: draft.value.model,
      presetId: draft.value.presetId,
    });
    editingField.value = null;
    toast.success('已更新,下一轮起生效');
  } catch (e: any) {
    toast.error(e?.message || '更新失败');
  }
}

function cancelEdit() {
  editingField.value = null;
}

const isEditing = computed(() => editingField.value !== null);
</script>

<template>
  <!-- 关键:外层 min-h-9 + 内部 absolute 切换,保持高度恒定不抖动 -->
  <div
    v-if="session"
    class="relative border-t border-border/50 bg-muted/20 text-xs text-muted-foreground"
    style="min-height: 36px"
    data-testid="session-meta-bar-container"
  >
    <!-- 显示态:三个独立可点击 chip,各自进入编辑 -->
    <div
      v-show="!isEditing"
      class="flex items-center gap-1 px-4 py-1.5 h-9"
      :class="{ 'opacity-60': isRunning }"
    >
      <Settings2 class="w-3 h-3 mr-1 flex-shrink-0" />

      <!-- provider -->
      <button
        type="button"
        class="px-1.5 py-0.5 rounded hover:bg-accent transition-colors disabled:cursor-not-allowed"
        :disabled="isRunning"
        :title="isRunning ? '生成进行中' : '点击切换服务商'"
        @click="startEdit('provider')"
        data-testid="session-meta-provider"
      >{{ providerLabel }}</button>

      <span class="opacity-50">·</span>

      <!-- model -->
      <button
        type="button"
        class="px-1.5 py-0.5 rounded hover:bg-accent transition-colors disabled:cursor-not-allowed truncate max-w-[280px]"
        :disabled="isRunning"
        :title="isRunning ? '生成进行中' : '点击切换模型'"
        @click="startEdit('model')"
        data-testid="session-meta-model"
      >{{ modelLabel }}</button>

      <span class="opacity-50">·</span>

      <!-- preset -->
      <button
        type="button"
        class="px-1.5 py-0.5 rounded hover:bg-accent transition-colors disabled:cursor-not-allowed"
        :disabled="isRunning"
        :title="isRunning ? '生成进行中' : '点击切换预设'"
        @click="startEdit('preset')"
        data-testid="session-meta-preset"
      >{{ presetLabel }}</button>
    </div>

    <!-- 编辑态:同样 h-9,只显示当前编辑字段 + 取消/保存 -->
    <div
      v-show="isEditing"
      class="flex items-center gap-2 px-4 py-1 h-9"
      data-testid="session-meta-edit"
    >
      <Settings2 class="w-3 h-3 flex-shrink-0" />

      <!-- 编辑 provider -->
      <select
        v-if="editingField === 'provider'"
        v-model="draft.providerId"
        class="flex-1 max-w-[260px] rounded border border-input bg-background px-2 py-0.5 text-xs"
        data-testid="meta-provider-select"
      >
        <option :value="null">使用默认</option>
        <option v-for="p in providerStore.providers" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>

      <!-- 编辑 model -->
      <div v-else-if="editingField === 'model'" class="flex-1 max-w-[400px]">
        <ModelCombobox
          v-model="draft.model"
          :suggestions="draftModels"
          placeholder="留空 = 用服务商默认"
          testid="meta-model-input"
        />
      </div>

      <!-- 编辑 preset -->
      <select
        v-else-if="editingField === 'preset'"
        v-model="draft.presetId"
        class="flex-1 max-w-[260px] rounded border border-input bg-background px-2 py-0.5 text-xs"
        data-testid="meta-preset-select"
      >
        <option :value="null">不使用</option>
        <option v-for="p in presetStore.presets" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>

      <button
        type="button"
        class="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-accent flex-shrink-0"
        @click="cancelEdit"
        data-testid="meta-cancel"
        title="取消"
      >
        <XIcon class="w-3 h-3" /> 取消
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 flex-shrink-0"
        @click="saveEdit"
        data-testid="meta-save"
        title="保存"
      >
        <Check class="w-3 h-3" /> 保存
      </button>
    </div>
  </div>
</template>
