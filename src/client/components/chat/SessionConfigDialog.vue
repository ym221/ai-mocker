<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useProviderStore } from '../../stores/provider';
import { usePresetStore } from '../../stores/preset';

export interface SessionConfigValue {
  providerId: number | null;
  model: string | null;
  presetId: number | null;
}

const props = defineProps<{
  /** Dialog open state (two-way) */
  open: boolean;
  /** Initial values */
  initial?: Partial<SessionConfigValue> | null;
  /** Title shown in header */
  title?: string;
  /** Description shown under title */
  description?: string;
  /** Confirm button label */
  confirmText?: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'confirm', v: SessionConfigValue): void;
}>();

const providerStore = useProviderStore();
const presetStore = usePresetStore();

const providerId = ref<number | null>(null);
const model = ref<string>('');
const presetId = ref<number | null>(null);

// `null` → use backend default; Select components can't bind to null so we map via string
const PROVIDER_DEFAULT = '__default__';
const PRESET_NONE = '__none__';

const providerSelect = computed<string>({
  get: () => providerId.value == null ? PROVIDER_DEFAULT : String(providerId.value),
  set: (v) => {
    providerId.value = v === PROVIDER_DEFAULT ? null : Number(v);
    // Auto-fill model from the chosen provider's default if model box is empty
    if (providerId.value != null && !model.value) {
      const p = providerStore.providers.find(x => x.id === providerId.value);
      if (p) model.value = p.defaultModel;
    }
  },
});

const presetSelect = computed<string>({
  get: () => presetId.value == null ? PRESET_NONE : String(presetId.value),
  set: (v) => { presetId.value = v === PRESET_NONE ? null : Number(v); },
});

const activeProviders = computed(() =>
  providerStore.providers.filter(p => p.isActive),
);
const activePresets = computed(() =>
  presetStore.presets.filter(p => p.isActive),
);

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return;
  // Lazy-load options when opening
  if (providerStore.providers.length === 0) {
    await providerStore.fetchProviders().catch(() => { /* toast handled */ });
  }
  if (presetStore.presets.length === 0) {
    await presetStore.fetchPresets().catch(() => { /* toast handled */ });
  }
  // Apply initial values
  const init = props.initial ?? {};
  providerId.value = init.providerId ?? null;
  model.value = init.model ?? '';
  presetId.value = init.presetId ?? null;
});

function close() { emit('update:open', false); }

function onConfirm() {
  emit('confirm', {
    providerId: providerId.value,
    model: model.value.trim() || null,
    presetId: presetId.value,
  });
  close();
}

function skipDefaults() {
  // Equivalent to confirming with everything cleared
  emit('confirm', { providerId: null, model: null, presetId: null });
  close();
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v) => emit('update:open', v)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader data-testid="session-config-dialog">
        <DialogTitle>{{ props.title ?? '新建对话' }}</DialogTitle>
        <DialogDescription>
          {{ props.description ?? '可选：指定本对话使用的 AI 服务商、模型和项目预设。留空则使用系统默认。' }}
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4 py-2">
        <!-- Provider -->
        <div class="space-y-1.5">
          <label class="text-sm font-medium">AI 服务商 <span class="text-muted-foreground text-xs">(可选)</span></label>
          <Select v-model="providerSelect">
            <SelectTrigger data-testid="provider-select">
              <SelectValue placeholder="使用系统默认" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="PROVIDER_DEFAULT">使用系统默认</SelectItem>
              <SelectItem
                v-for="p in activeProviders"
                :key="p.id"
                :value="String(p.id)"
              >
                {{ p.name }}<span class="text-muted-foreground"> · {{ p.type }}</span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- Model -->
        <div class="space-y-1.5">
          <label class="text-sm font-medium">模型 <span class="text-muted-foreground text-xs">(可选)</span></label>
          <Input
            v-model="model"
            placeholder="留空则使用所选服务商的默认模型"
            data-testid="model-input"
          />
        </div>

        <!-- Preset -->
        <div class="space-y-1.5">
          <label class="text-sm font-medium">项目预设 <span class="text-muted-foreground text-xs">(可选)</span></label>
          <Select v-model="presetSelect">
            <SelectTrigger data-testid="preset-select">
              <SelectValue placeholder="不使用预设" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="PRESET_NONE">不使用预设</SelectItem>
              <SelectItem
                v-for="p in activePresets"
                :key="p.id"
                :value="String(p.id)"
              >
                {{ p.name }}<span v-if="p.description" class="text-muted-foreground"> · {{ p.description }}</span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <DialogFooter class="gap-2">
        <Button variant="ghost" @click="skipDefaults" data-testid="skip-defaults-btn">
          跳过默认
        </Button>
        <Button @click="onConfirm" data-testid="confirm-session-config-btn">
          {{ props.confirmText ?? '开始对话' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
