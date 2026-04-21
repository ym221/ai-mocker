<script setup lang="ts">
import { computed, ref } from 'vue';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Filter, X, Plus } from 'lucide-vue-next';

export interface FilterField {
  name: string;
  label: string;
  type: string;
  enumValues?: string[];
}

export type FilterOp =
  | 'contains' | 'startsWith' | 'endsWith' | 'eq' | 'neq'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in';

export interface FilterCondition {
  field: string;
  op: FilterOp;
  value?: string;
  min?: string;
  max?: string;
}

const props = defineProps<{
  fields: FilterField[];
  modelValue: FilterCondition[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: FilterCondition[]): void;
}>();

const conditions = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const addOpen = ref(false);
const newField = ref<string>('');

function fieldByName(name: string): FilterField | undefined {
  return props.fields.find(f => f.name === name);
}

function opsForField(f: FilterField | undefined): { value: FilterOp; label: string }[] {
  if (!f) return [{ value: 'contains', label: '包含' }];
  switch (f.type) {
    case 'string':
    case 'text':
      return [
        { value: 'contains', label: '包含' },
        { value: 'startsWith', label: '开头是' },
        { value: 'endsWith', label: '结尾是' },
        { value: 'eq', label: '等于' },
      ];
    case 'integer': case 'int': case 'number': case 'decimal': case 'float':
      return [
        { value: 'eq', label: '=' },
        { value: 'neq', label: '≠' },
        { value: 'gt', label: '>' },
        { value: 'gte', label: '≥' },
        { value: 'lt', label: '<' },
        { value: 'lte', label: '≤' },
        { value: 'between', label: '介于' },
      ];
    case 'enum':
      return [
        { value: 'eq', label: '等于' },
        { value: 'neq', label: '不等于' },
        { value: 'in', label: '属于' },
      ];
    case 'boolean':
      return [{ value: 'eq', label: '等于' }];
    case 'date': case 'datetime':
      return [
        { value: 'eq', label: '=' },
        { value: 'gt', label: '晚于' },
        { value: 'lt', label: '早于' },
        { value: 'between', label: '介于' },
      ];
    default:
      return [{ value: 'contains', label: '包含' }];
  }
}

function defaultOp(f: FilterField | undefined): FilterOp {
  return opsForField(f)[0].value;
}

function valueInputType(f: FilterField | undefined): string {
  if (!f) return 'text';
  switch (f.type) {
    case 'integer': case 'int': case 'number': case 'decimal': case 'float': return 'number';
    case 'date': return 'date';
    case 'datetime': return 'datetime-local';
    default: return 'text';
  }
}

function addCondition() {
  if (!newField.value) return;
  const f = fieldByName(newField.value);
  conditions.value = [...conditions.value, { field: newField.value, op: defaultOp(f), value: '' }];
  newField.value = '';
  addOpen.value = false;
}

function removeAt(i: number) {
  const next = [...conditions.value];
  next.splice(i, 1);
  conditions.value = next;
}

function updateAt(i: number, patch: Partial<FilterCondition>) {
  const next = [...conditions.value];
  next[i] = { ...next[i], ...patch };
  conditions.value = next;
}

function clearAll() {
  conditions.value = [];
}

function changeField(i: number, fieldName: string) {
  const f = fieldByName(fieldName);
  updateAt(i, { field: fieldName, op: defaultOp(f), value: '', min: '', max: '' });
}

function changeOp(i: number, op: FilterOp) {
  const cur = conditions.value[i];
  const patch: Partial<FilterCondition> = { op };
  if (op !== 'between') { patch.min = ''; patch.max = ''; }
  if (op === 'between') { patch.value = ''; }
  updateAt(i, patch);
}
</script>

<template>
  <div class="filter-bar flex flex-wrap items-center gap-1.5" data-testid="filter-bar">
    <Popover v-model:open="addOpen">
      <PopoverTrigger as-child>
        <Button size="sm" variant="outline" data-testid="filter-add-trigger">
          <Filter class="w-3.5 h-3.5 mr-1" />
          <span class="text-xs">添加筛选</span>
          <Plus class="w-3 h-3 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent class="w-56 p-2" align="start">
        <div data-testid="filter-add-panel" class="space-y-1">
          <div class="text-xs text-muted-foreground px-1">选择字段</div>
          <button
            v-for="f in fields"
            :key="f.name"
            type="button"
            class="w-full text-left px-2 py-1 text-sm rounded hover:bg-muted"
            :data-testid="`filter-field-${f.name}`"
            @click="newField = f.name; addCondition()"
          >
            {{ f.label }}
            <span class="text-xs text-muted-foreground ml-1">{{ f.type }}</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>

    <div
      v-for="(c, i) in conditions"
      :key="i"
      class="filter-chip inline-flex items-center gap-1 border border-border rounded-md px-1.5 py-0.5 text-xs bg-muted/30"
      :data-testid="`filter-chip-${i}`"
    >
      <!-- field -->
      <Select :model-value="c.field" @update:model-value="(v) => changeField(i, String(v))">
        <SelectTrigger class="h-6 border-0 bg-transparent shadow-none px-1 text-xs gap-1" :data-testid="`filter-chip-field-${i}`">
          <SelectValue>{{ fieldByName(c.field)?.label || c.field }}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="f in fields" :key="f.name" :value="f.name">{{ f.label }}</SelectItem>
        </SelectContent>
      </Select>

      <!-- op -->
      <Select :model-value="c.op" @update:model-value="(v) => changeOp(i, v as FilterOp)">
        <SelectTrigger class="h-6 border-0 bg-transparent shadow-none px-1 text-xs gap-1" :data-testid="`filter-chip-op-${i}`">
          <SelectValue>{{ opsForField(fieldByName(c.field)).find(o => o.value === c.op)?.label || c.op }}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="op in opsForField(fieldByName(c.field))" :key="op.value" :value="op.value">{{ op.label }}</SelectItem>
        </SelectContent>
      </Select>

      <!-- value -->
      <template v-if="c.op === 'between'">
        <Input
          :model-value="c.min || ''"
          :type="valueInputType(fieldByName(c.field))"
          class="h-6 w-20 text-xs px-1"
          placeholder="最小"
          :data-testid="`filter-chip-min-${i}`"
          @update:model-value="(v) => updateAt(i, { min: String(v) })"
        />
        <span class="text-muted-foreground">~</span>
        <Input
          :model-value="c.max || ''"
          :type="valueInputType(fieldByName(c.field))"
          class="h-6 w-20 text-xs px-1"
          placeholder="最大"
          :data-testid="`filter-chip-max-${i}`"
          @update:model-value="(v) => updateAt(i, { max: String(v) })"
        />
      </template>
      <template v-else-if="fieldByName(c.field)?.type === 'enum'">
        <Select :model-value="c.value || ''" @update:model-value="(v) => updateAt(i, { value: String(v) })">
          <SelectTrigger class="h-6 w-24 text-xs px-1" :data-testid="`filter-chip-enum-${i}`">
            <SelectValue placeholder="选择值" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="opt in fieldByName(c.field)?.enumValues || []" :key="opt" :value="opt">{{ opt }}</SelectItem>
          </SelectContent>
        </Select>
      </template>
      <template v-else-if="fieldByName(c.field)?.type === 'boolean'">
        <Select :model-value="c.value || ''" @update:model-value="(v) => updateAt(i, { value: String(v) })">
          <SelectTrigger class="h-6 w-20 text-xs px-1" :data-testid="`filter-chip-bool-${i}`">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">是</SelectItem>
            <SelectItem value="0">否</SelectItem>
          </SelectContent>
        </Select>
      </template>
      <template v-else>
        <Input
          :model-value="c.value || ''"
          :type="valueInputType(fieldByName(c.field))"
          class="h-6 w-28 text-xs px-1"
          placeholder="值"
          :data-testid="`filter-chip-value-${i}`"
          @update:model-value="(v) => updateAt(i, { value: String(v) })"
        />
      </template>

      <button
        type="button"
        class="ml-0.5 p-0.5 rounded hover:bg-muted text-muted-foreground"
        :data-testid="`filter-chip-remove-${i}`"
        @click="removeAt(i)"
        title="移除筛选"
      >
        <X class="w-3 h-3" />
      </button>
    </div>

    <Button
      v-if="conditions.length > 0"
      size="sm"
      variant="ghost"
      class="h-7 text-xs"
      data-testid="filter-clear-all"
      @click="clearAll"
    >
      全部清除
    </Button>
  </div>
</template>
