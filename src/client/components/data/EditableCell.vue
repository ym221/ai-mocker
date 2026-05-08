<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export interface Field {
  name: string;
  type: string;
  displayName?: string;
  enumValues?: string[];
  required?: boolean;
  defaultValue?: unknown;
}

const props = defineProps<{
  value: unknown;
  field: Field;
  readonly?: boolean;
  width?: number;
  rowHeight?: number;
  editSignal?: number;
}>();

const emit = defineEmits<{
  (e: 'save', value: unknown): void;
  (e: 'cancel'): void;
  (e: 'tab'): void;
  (e: 'enter'): void;
}>();

const editing = ref(false);
const draft = ref<unknown>(props.value);
const flashGreen = ref(false);
const errorMsg = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const fieldType = computed(() => props.field.type);

const displayValue = computed(() => {
  const v = props.value;
  if (v === null || v === undefined || v === '') return '';
  if (fieldType.value === 'boolean') return v === 1 || v === true ? 'true' : 'false';
  return String(v);
});

const draftStr = computed({
  get: () => (draft.value === null || draft.value === undefined) ? '' : String(draft.value),
  set: (v: string) => { draft.value = v; },
});

const truncatedRef = ref<HTMLElement | null>(null);
const isTruncated = ref(false);

function checkTruncation() {
  if (!truncatedRef.value) return;
  isTruncated.value = truncatedRef.value.scrollWidth > truncatedRef.value.clientWidth + 1;
}

watch(() => props.value, () => {
  draft.value = props.value;
  flash();
  nextTick(checkTruncation);
});

watch(() => props.editSignal, (v, old) => {
  if (v && v !== old) startEdit();
});

onMounted(() => nextTick(checkTruncation));

function flash() {
  flashGreen.value = true;
  setTimeout(() => { flashGreen.value = false; }, 400);
}

async function startEdit() {
  if (props.readonly) return;
  draft.value = props.value ?? (fieldType.value === 'boolean' ? false : '');
  errorMsg.value = '';
  editing.value = true;
  await nextTick();
  // Focus + select
  const el = inputRef.value || textareaRef.value;
  if (el && typeof el.focus === 'function') {
    el.focus();
    if (typeof (el as HTMLInputElement).select === 'function') {
      try { (el as HTMLInputElement).select(); } catch { /* ignore */ }
    }
  }
}

function validate(v: unknown): string {
  if (props.field.required && (v === '' || v === null || v === undefined)) return '必填';
  const t = fieldType.value;
  if ((t === 'number' || t === 'decimal' || t === 'integer' || t === 'int' || t === 'float') && v !== '' && v !== null) {
    if (isNaN(Number(v))) return '必须是数字';
  }
  return '';
}

function normalizeForSave(v: unknown): unknown {
  const t = fieldType.value;
  if (t === 'integer' || t === 'int') return v === '' ? null : parseInt(String(v), 10);
  if (t === 'decimal' || t === 'float' || t === 'number') return v === '' ? null : Number(v);
  if (t === 'boolean') return v ? 1 : 0;
  return v;
}

function commitSave() {
  const err = validate(draft.value);
  if (err) {
    errorMsg.value = err;
    return;
  }
  const normalized = normalizeForSave(draft.value);
  const curr = fieldType.value === 'boolean'
    ? (props.value === 1 || props.value === true ? 1 : 0)
    : props.value;
  editing.value = false;
  if (normalized === curr || String(normalized ?? '') === String(curr ?? '')) return;
  emit('save', normalized);
}

function cancel() {
  editing.value = false;
  errorMsg.value = '';
  draft.value = props.value;
  emit('cancel');
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  else if (e.key === 'Enter' && fieldType.value !== 'text') {
    e.preventDefault();
    commitSave();
    emit('enter');
  } else if (e.key === 'Tab') {
    commitSave();
    emit('tab');
  }
}

function onBooleanChange(v: boolean) {
  draft.value = v;
  emit('save', v ? 1 : 0);
  editing.value = false;
}

function onSelectChange(v: string) {
  draft.value = v;
  editing.value = false;
  if (v !== props.value) emit('save', v);
}

const inputType = computed(() => {
  switch (fieldType.value) {
    case 'number':
    case 'decimal':
    case 'float':
    case 'integer':
    case 'int':
      return 'number';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime-local';
    default:
      return 'text';
  }
});

const isBoolean = computed(() => fieldType.value === 'boolean');
const isEnum = computed(() => fieldType.value === 'enum');
const isLongText = computed(() => fieldType.value === 'text');

function selectModelHandler(v: unknown) { onSelectChange(String(v ?? '')); }

const enumDraft = computed(() => draftStr.value);
</script>

<template>
  <!-- Readonly presentation -->
  <div
    v-if="readonly"
    class="editable-cell readonly"
    :style="{ height: (rowHeight ?? 36) + 'px' }"
    data-testid="cell-readonly"
  >
    <span ref="truncatedRef" class="cell-text" :title="isTruncated ? displayValue : undefined">{{ displayValue }}</span>
  </div>

  <!-- Boolean — always-on Switch -->
  <div
    v-else-if="isBoolean"
    class="editable-cell"
    :style="{ height: (rowHeight ?? 36) + 'px' }"
    data-testid="cell-boolean"
  >
    <Switch :model-value="value === 1 || value === true" @update:model-value="onBooleanChange" />
    <span v-if="flashGreen" class="flash-overlay" />
  </div>

  <!-- Long text — popover -->
  <Popover v-else-if="isLongText" v-model:open="editing">
    <PopoverTrigger as-child>
      <div
        class="editable-cell hoverable"
        :style="{ height: (rowHeight ?? 36) + 'px' }"
        @click="startEdit"
        data-testid="cell-text"
      >
        <span ref="truncatedRef" class="cell-text" :title="isTruncated ? displayValue : undefined">{{ displayValue }}</span>
        <span v-if="flashGreen" class="flash-overlay" />
      </div>
    </PopoverTrigger>
    <PopoverContent class="w-80 p-2">
      <textarea
        ref="textareaRef"
        v-model="draftStr"
        rows="5"
        class="w-full border border-input rounded-md p-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        @keydown="onKey"
      />
      <div class="flex justify-end gap-1 mt-2">
        <button type="button" class="text-xs px-2 py-1 rounded hover:bg-muted" @click="cancel">取消</button>
        <button type="button" class="text-xs px-2 py-1 rounded bg-primary text-primary-foreground" @click="commitSave">保存</button>
      </div>
      <div v-if="errorMsg" class="text-xs text-destructive mt-1">{{ errorMsg }}</div>
    </PopoverContent>
  </Popover>

  <!-- Enum -->
  <div
    v-else-if="isEnum"
    class="editable-cell"
    :style="{ height: (rowHeight ?? 36) + 'px' }"
    data-testid="cell-enum"
  >
    <Select
      v-if="editing"
      :model-value="enumDraft"
      :default-open="true"
      @update:model-value="selectModelHandler"
    >
      <SelectTrigger class="h-full w-full border-0 bg-white focus:ring-2 focus:ring-primary">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="opt in field.enumValues || []" :key="opt" :value="opt">{{ opt }}</SelectItem>
      </SelectContent>
    </Select>
    <div v-else class="hoverable w-full h-full flex items-center px-1" @click="startEdit">
      <span ref="truncatedRef" class="cell-text" :title="isTruncated ? displayValue : undefined">{{ displayValue }}</span>
    </div>
    <span v-if="flashGreen" class="flash-overlay" />
    <div v-if="errorMsg" class="error-tip">{{ errorMsg }}</div>
  </div>

  <!-- Default: Input -->
  <div
    v-else
    class="editable-cell"
    :class="{ 'has-error': errorMsg }"
    :style="{ height: (rowHeight ?? 36) + 'px' }"
    data-testid="cell-default"
  >
    <input
      v-if="editing"
      ref="inputRef"
      v-model="draftStr"
      :type="inputType"
      class="cell-edit-input"
      data-testid="cell-input"
      @keydown="onKey"
      @blur="commitSave"
    >
    <div v-else class="hoverable w-full h-full flex items-center px-1" @click="startEdit">
      <span ref="truncatedRef" class="cell-text" :title="isTruncated ? displayValue : undefined">{{ displayValue }}</span>
    </div>
    <span v-if="flashGreen" class="flash-overlay" />
    <div v-if="errorMsg" class="error-tip">{{ errorMsg }}</div>
  </div>
</template>

<style scoped>
.editable-cell {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  overflow: hidden;
}
.editable-cell.readonly {
  background: hsl(var(--muted) / 0.3);
  cursor: default;
  padding: 0 0.5rem;
}
.editable-cell .hoverable {
  cursor: text;
}
.editable-cell .hoverable:hover {
  background: hsl(var(--muted) / 0.3);
}
.cell-text {
  display: inline-block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
}
.cell-edit-input {
  height: 100%;
  width: 100%;
  border: 0;
  background: white;
  padding: 0 0.25rem;
  font-size: 0.875rem;
  outline: 2px solid hsl(var(--primary));
  outline-offset: -2px;
  box-sizing: border-box;
}
.flash-overlay {
  position: absolute;
  inset: 0;
  background: rgb(134 239 172 / 0.35);
  animation: flash 0.4s ease-out;
  pointer-events: none;
}
@keyframes flash {
  from { opacity: 1; }
  to { opacity: 0; }
}
.has-error {
  box-shadow: inset 0 0 0 2px hsl(var(--destructive));
}
.error-tip {
  position: absolute;
  bottom: -16px;
  left: 4px;
  font-size: 10px;
  color: hsl(var(--destructive));
  background: white;
  padding: 0 2px;
  z-index: 10;
}
</style>
