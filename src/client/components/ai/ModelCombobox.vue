<script setup lang="ts">
import { computed } from 'vue';
import type { ProviderModel } from '../../stores/provider';

const props = defineProps<{
  modelValue: string;
  /** 该 provider 当前的预置模型列表(联想下拉来源) */
  suggestions?: ProviderModel[];
  placeholder?: string;
  disabled?: boolean;
  /** test-id 前缀,便于 e2e 测试定位 */
  testid?: string;
}>();

defineEmits<{
  'update:modelValue': [value: string];
}>();

// datalist id 唯一(同页面多个 combobox 不冲突)
const listId = computed(() => `model-suggestions-${Math.random().toString(36).slice(2, 10)}`);

// 显示在下拉项右侧的辅助文字:验证状态 + 备注(浏览器原生 datalist 用 label 字段展示)
function suggestionLabel(m: ProviderModel): string {
  const parts: string[] = [];
  if (m.isVerified === 1) parts.push('✅');
  else if (m.lastVerifiedAt) parts.push('⚠️ 上次失败');
  else parts.push('未验证');
  if (m.note) parts.push(m.note);
  return parts.join(' · ');
}
</script>

<template>
  <div class="space-y-1">
    <input
      :value="modelValue"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      :placeholder="placeholder ?? '输入或选择模型(可联想)'"
      :list="listId"
      :disabled="disabled"
      :data-testid="testid"
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
      autocomplete="off"
      spellcheck="false"
    />
    <datalist :id="listId">
      <option
        v-for="m in suggestions ?? []"
        :key="m.id"
        :value="m.modelName"
        :label="suggestionLabel(m)"
      />
    </datalist>
    <!-- 用户能看到当前输入是否在已知列表 + 提示自由输入也支持 -->
    <p
      v-if="modelValue && suggestions && !suggestions.some(m => m.modelName === modelValue)"
      class="text-xs text-muted-foreground"
    >
      新模型 — 保存后会自动加入预置列表
    </p>
  </div>
</template>
