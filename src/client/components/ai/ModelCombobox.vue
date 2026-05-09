<script setup lang="ts">
import { computed, ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import type { ProviderModel } from '../../stores/provider';

const props = defineProps<{
  modelValue: string;
  /** 该 provider 当前的预置模型列表(联想下拉来源) */
  suggestions?: ProviderModel[];
  placeholder?: string;
  disabled?: boolean;
  testid?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const containerRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const open = ref(false);

onClickOutside(containerRef, () => { open.value = false; });

// 输入文本对建议做模糊过滤(子串包含,大小写不敏感)
const filtered = computed(() => {
  const list = props.suggestions ?? [];
  const q = (props.modelValue || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter(m => m.modelName.toLowerCase().includes(q));
});

const isNewModel = computed(() => {
  if (!props.modelValue || !props.modelValue.trim()) return false;
  return !(props.suggestions ?? []).some(m => m.modelName === props.modelValue);
});

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
  open.value = true;
}

function onFocus() {
  open.value = true;
}

function selectSuggestion(m: ProviderModel) {
  emit('update:modelValue', m.modelName);
  open.value = false;
  inputRef.value?.blur();
}

function statusIcon(m: ProviderModel): string {
  if (m.isVerified === 1) return '✅';
  if (m.lastVerifiedAt) return '❌';
  return '⚪';
}
</script>

<template>
  <div ref="containerRef" class="relative">
    <input
      ref="inputRef"
      :value="modelValue"
      @input="onInput"
      @focus="onFocus"
      @keydown.esc="open = false"
      :placeholder="placeholder ?? '输入或选择模型(可联想)'"
      :disabled="disabled"
      :data-testid="testid"
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
      autocomplete="off"
      spellcheck="false"
    />
    <p
      v-if="isNewModel"
      class="text-xs text-muted-foreground mt-1"
    >
      新模型 — 保存后会自动加入预置列表
    </p>

    <!-- 自定义下拉(我们控制布局,不换行) -->
    <div
      v-if="open && filtered.length > 0"
      class="absolute z-50 left-0 right-0 mt-1 max-h-60 overflow-auto rounded-md border border-border bg-popover shadow-md text-sm"
    >
      <button
        v-for="m in filtered"
        :key="m.id"
        type="button"
        class="w-full text-left px-3 py-2 hover:bg-accent flex items-center gap-2 whitespace-nowrap"
        @mousedown.prevent="selectSuggestion(m)"
        :data-testid="testid ? `${testid}-option-${m.id}` : undefined"
      >
        <span class="flex-shrink-0">{{ statusIcon(m) }}</span>
        <span class="flex-1 truncate font-mono">{{ m.modelName }}</span>
        <span v-if="m.note" class="text-xs text-muted-foreground truncate max-w-[40%]">{{ m.note }}</span>
      </button>
    </div>
  </div>
</template>
