<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { toast } from '../../composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { ColumnSettings, FilterBar, type ColumnConfig, type FilterCondition, type FilterField, DENSITY_ROW_HEIGHT } from '../data-table';
import { useTablePreferences } from '@/composables/use-table-preferences';
import { useDataApi, type DataRow, type FieldRule } from '@/composables/use-data-api';
import { Plus, Sparkles, Trash2, ChevronUp, ChevronDown, RotateCw, Inbox } from 'lucide-vue-next';
import type { Field } from './EditableCell.vue';
import EditableCell from './EditableCell.vue';
import DataGenerator from './DataGenerator.vue';

const props = defineProps<{
  moduleName: string;
  fields: Field[];
}>();

const api = useDataApi(props.moduleName);
const { confirm } = useConfirm();

function defaultColumns(): ColumnConfig[] {
  const cols: ColumnConfig[] = [
    { id: '__select__', label: '选择', visible: true, pinned: 'left', fixed: true },
    { id: 'id', label: 'ID', visible: true, pinned: 'left', fixed: true },
  ];
  for (const f of props.fields) {
    cols.push({ id: f.name, label: f.displayName || f.name, visible: true, pinned: false });
  }
  cols.push({ id: 'created_at', label: '创建时间', visible: true, pinned: false });
  cols.push({ id: '__actions__', label: '操作', visible: true, pinned: 'right', fixed: true });
  return cols;
}

const prefs = useTablePreferences(
  `datatable:${props.moduleName}`,
  defaultColumns,
  'normal',
);
const { columns, density, presets, activePreset } = prefs;

const rows = ref<DataRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const filterConds = ref<FilterCondition[]>([]);
const sortBy = ref<string | null>(null);
const sortDir = ref<'ASC' | 'DESC'>('ASC');
const selected = ref<Set<number>>(new Set());
const newRow = ref<Record<string, unknown> | null>(null);
const genOpen = ref(false);

const filterFields = computed<FilterField[]>(() => props.fields.map(f => ({
  name: f.name,
  label: f.displayName || f.name,
  type: f.type,
  enumValues: f.enumValues,
})));

const rowHeight = computed(() => DENSITY_ROW_HEIGHT[density.value]);

const fieldByName = computed<Record<string, Field>>(() => {
  const map: Record<string, Field> = {};
  for (const f of props.fields) map[f.name] = f;
  return map;
});

const widthByType: Record<string, number> = {
  string: 180, text: 220, integer: 100, int: 100, number: 100, decimal: 120, float: 120,
  boolean: 80, enum: 120, date: 160, datetime: 180,
};

function colWidth(c: ColumnConfig): number {
  if (c.id === '__select__') return 44;
  if (c.id === 'id') return 80;
  if (c.id === '__actions__') return 72;
  if (c.id === 'created_at') return 160;
  const f = fieldByName.value[c.id];
  return f ? (widthByType[f.type] ?? 160) : 160;
}

const visibleCols = computed(() => columns.value.filter(c => c.visible));

// total width (for horizontal scroll container) — used for pinned computed
const totalWidth = computed(() => visibleCols.value.reduce((a, c) => a + colWidth(c), 0));

function leftOffset(col: ColumnConfig): number {
  let offset = 0;
  for (const c of visibleCols.value) {
    if (c.id === col.id) return offset;
    if (c.pinned === 'left') offset += colWidth(c);
  }
  return 0;
}
function rightOffset(col: ColumnConfig): number {
  let offset = 0;
  const rights = visibleCols.value.filter(c => c.pinned === 'right');
  for (let i = rights.length - 1; i >= 0; i--) {
    if (rights[i].id === col.id) return offset;
    offset += colWidth(rights[i]);
  }
  return 0;
}

function buildFilterPayload(): Record<string, { op: string; value?: string; min?: string; max?: string }> {
  const out: Record<string, { op: string; value?: string; min?: string; max?: string }> = {};
  for (const c of filterConds.value) {
    if (!c.field) continue;
    const hasValue = c.value !== undefined && c.value !== '';
    const hasRange = c.op === 'between' && ((c.min !== undefined && c.min !== '') || (c.max !== undefined && c.max !== ''));
    if (!hasValue && !hasRange) continue;
    out[c.field] = { op: c.op, value: c.value, min: c.min, max: c.max };
  }
  return out;
}

async function refresh() {
  loading.value = true;
  try {
    const filter = buildFilterPayload();
    const orderBy = sortBy.value ? `${sortBy.value}+${sortDir.value}` : undefined;
    const res = await api.list({ page: page.value, pageSize: pageSize.value, orderBy, filter });
    rows.value = res.data.list;
    total.value = res.data.total;
  } catch (err) {
    console.error(err);
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

watch([page, pageSize, sortBy, sortDir], refresh);
watch(filterConds, () => { page.value = 1; refresh(); }, { deep: true });

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

function toggleSort(colId: string) {
  const f = fieldByName.value[colId];
  if (colId !== 'id' && colId !== 'created_at' && !f) return;
  if (sortBy.value !== colId) { sortBy.value = colId; sortDir.value = 'ASC'; }
  else if (sortDir.value === 'ASC') sortDir.value = 'DESC';
  else { sortBy.value = null; }
}

function toggleRowSelect(id: number) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  selected.value = next;
}
function allSelected() {
  return rows.value.length > 0 && rows.value.every(r => selected.value.has(r.id));
}
function someSelected() {
  return rows.value.some(r => selected.value.has(r.id)) && !allSelected();
}
function toggleSelectAll() {
  const all = allSelected();
  const next = new Set(selected.value);
  for (const r of rows.value) {
    if (all) next.delete(r.id);
    else next.add(r.id);
  }
  selected.value = next;
}

async function saveCell(row: DataRow, colId: string, value: unknown) {
  try {
    await api.update(row.id, { [colId]: value });
    (row as Record<string, unknown>)[colId] = value;
    toast.success('已保存');
  } catch (err) {
    toast.error('保存失败');
    await refresh();
  }
}

function startNewRow() {
  if (newRow.value) return;
  const r: Record<string, unknown> = {};
  for (const f of props.fields) {
    r[f.name] = f.defaultValue ?? (f.type === 'boolean' ? 0 : '');
  }
  newRow.value = r;
}

async function saveNewRow() {
  if (!newRow.value) return;
  // required check
  for (const f of props.fields) {
    if (f.required && (newRow.value[f.name] === '' || newRow.value[f.name] === null || newRow.value[f.name] === undefined)) {
      toast.error(`${f.displayName || f.name} 必填`);
      return;
    }
  }
  try {
    await api.create(newRow.value);
    newRow.value = null;
    toast.success('新增成功');
    await refresh();
  } catch {
    toast.error('新增失败');
  }
}

function cancelNewRow() { newRow.value = null; }

async function deleteRow(id: number) {
  const ok = await confirm({ title: '确认删除这一行？', variant: 'destructive', confirmText: '删除' });
  if (!ok) return;
  try {
    await api.remove(id);
    toast.success('已删除');
    const next = new Set(selected.value); next.delete(id); selected.value = next;
    await refresh();
  } catch {
    toast.error('删除失败');
  }
}

async function batchDelete() {
  const ids = Array.from(selected.value);
  if (ids.length === 0) return;
  const ok = await confirm({ title: `确认删除选中的 ${ids.length} 条数据？`, variant: 'destructive', confirmText: '删除' });
  if (!ok) return;
  try {
    await api.batchDelete(ids);
    toast.success(`已删除 ${ids.length} 条`);
    selected.value = new Set();
    await refresh();
  } catch {
    toast.error('批量删除失败');
  }
}

async function clearAll() {
  const ok = await confirm({ title: '确认清空全部数据？', description: '此操作不可撤销', variant: 'destructive', confirmText: '清空' });
  if (!ok) return;
  try {
    await api.clear();
    toast.success('已清空');
    selected.value = new Set();
    page.value = 1;
    await refresh();
  } catch {
    toast.error('清空失败');
  }
}

async function doGenerate(count: number, rules: Record<string, FieldRule>) {
  try {
    const res = await api.bulkGenerate(count, rules);
    toast.success(`已生成 ${res.data.generated} 条`);
    await refresh();
  } catch {
    toast.error('生成失败');
  }
}

function cellDisplay(row: DataRow, colId: string): unknown {
  return (row as Record<string, unknown>)[colId];
}

function isReadonly(colId: string): boolean {
  return colId === 'id' || colId === 'created_at' || colId === 'updatedAt';
}

function onNewRowFieldChange(colId: string, v: unknown) {
  if (newRow.value) newRow.value[colId] = v;
}

function onPageSizeChange(v: unknown) {
  pageSize.value = Number(v);
  page.value = 1;
}
</script>

<template>
  <div class="data-table-wrapper" data-testid="data-table">
    <!-- Toolbar -->
    <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
      <div class="flex items-center gap-2 flex-wrap">
        <FilterBar v-model="filterConds" :fields="filterFields" />
        <span class="h-6 w-px bg-border mx-1" />
        <Button size="sm" @click="startNewRow" data-testid="btn-new-row">
          <Plus class="w-4 h-4 mr-1" /> 新增
        </Button>
        <Button size="sm" variant="outline" @click="genOpen = true" data-testid="btn-generate">
          <Sparkles class="w-4 h-4 mr-1" /> 批量生成
        </Button>
        <Button size="sm" variant="outline" @click="clearAll" data-testid="btn-clear">
          <Trash2 class="w-4 h-4 mr-1" /> 清空
        </Button>
        <Button size="sm" variant="ghost" @click="refresh" data-testid="btn-refresh">
          <RotateCw class="w-4 h-4" />
        </Button>
      </div>
      <div class="flex items-center gap-2">
        <ColumnSettings
          :columns="columns"
          :density="density"
          :presets="presets"
          :active-preset="activePreset"
          @update:columns="columns = $event"
          @update:density="density = $event"
          @update:active-preset="(name) => name && prefs.loadPreset(name)"
          @save-preset="prefs.savePreset"
          @delete-preset="prefs.deletePreset"
          @reset="prefs.reset"
        />
      </div>
    </div>

    <!-- Table -->
    <div class="table-scroll relative border border-border rounded-md overflow-x-auto bg-white" data-testid="table-scroll">
      <table class="data-table border-collapse" :style="{ width: Math.max(totalWidth, 600) + 'px' }">
        <thead>
          <tr>
            <th
              v-for="col in visibleCols"
              :key="col.id"
              :style="{
                width: colWidth(col) + 'px',
                minWidth: colWidth(col) + 'px',
                maxWidth: colWidth(col) + 'px',
                position: col.pinned ? 'sticky' : undefined,
                left: col.pinned === 'left' ? leftOffset(col) + 'px' : undefined,
                right: col.pinned === 'right' ? rightOffset(col) + 'px' : undefined,
                zIndex: col.pinned ? 3 : 1,
              }"
              :class="['data-th', col.pinned === 'left' && 'pinned-left', col.pinned === 'right' && 'pinned-right']"
              :data-testid="`th-${col.id}`"
            >
              <div
                class="flex items-center h-full w-full"
                :class="(col.id === '__select__' || col.id === '__actions__') ? 'justify-center' : 'gap-1 px-3'"
              >
                <template v-if="col.id === '__select__'">
                  <Checkbox
                    :model-value="allSelected() ? true : someSelected() ? 'indeterminate' : false"
                    @update:model-value="toggleSelectAll"
                    data-testid="select-all"
                  />
                </template>
                <template v-else-if="col.id === '__actions__'">
                  <span class="text-xs text-muted-foreground">操作</span>
                </template>
                <template v-else>
                  <span class="truncate text-sm font-medium">{{ col.label }}</span>
                  <span v-if="fieldByName[col.id]?.required" class="text-destructive">*</span>
                  <button
                    type="button"
                    class="ml-auto p-1 -m-1 rounded hover:bg-muted/60"
                    @click="toggleSort(col.id)"
                    :data-testid="`sort-${col.id}`"
                  >
                    <ChevronUp v-if="sortBy === col.id && sortDir === 'ASC'" class="w-3.5 h-3.5" />
                    <ChevronDown v-else-if="sortBy === col.id && sortDir === 'DESC'" class="w-3.5 h-3.5" />
                    <ChevronUp v-else class="w-3.5 h-3.5 opacity-25" />
                  </button>
                </template>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <!-- New row editor -->
          <tr v-if="newRow" data-testid="new-row">
            <td
              v-for="col in visibleCols"
              :key="col.id"
              :style="{
                width: colWidth(col) + 'px',
                minWidth: colWidth(col) + 'px',
                maxWidth: colWidth(col) + 'px',
                position: col.pinned ? 'sticky' : undefined,
                left: col.pinned === 'left' ? leftOffset(col) + 'px' : undefined,
                right: col.pinned === 'right' ? rightOffset(col) + 'px' : undefined,
                height: rowHeight + 'px',
              }"
              :class="['data-td', col.pinned === 'left' && 'pinned-left', col.pinned === 'right' && 'pinned-right']"
            >
              <template v-if="col.id === '__select__' || col.id === 'id' || col.id === 'created_at'"></template>
              <template v-else-if="col.id === '__actions__'">
                <div class="flex items-center justify-center gap-1 h-full">
                  <button type="button" class="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground" @click="saveNewRow" data-testid="new-save">保存</button>
                  <button type="button" class="text-xs px-2 py-0.5 rounded hover:bg-muted" @click="cancelNewRow" data-testid="new-cancel">取消</button>
                </div>
              </template>
              <EditableCell
                v-else-if="fieldByName[col.id]"
                :value="newRow[col.id]"
                :field="fieldByName[col.id]"
                :row-height="rowHeight"
                :width="colWidth(col)"
                @save="(v) => onNewRowFieldChange(col.id, v)"
              />
            </td>
          </tr>

          <!-- Loading skeleton -->
          <tr v-if="loading && rows.length === 0">
            <td :colspan="visibleCols.length" class="text-center py-8 text-muted-foreground text-sm">加载中...</td>
          </tr>

          <!-- Empty state -->
          <tr v-else-if="!loading && rows.length === 0">
            <td :colspan="visibleCols.length" class="text-center py-12">
              <Inbox class="w-10 h-10 mx-auto text-muted-foreground/40 mb-2" />
              <div class="text-sm text-muted-foreground mb-3">暂无数据</div>
              <Button size="sm" variant="outline" @click="doGenerate(20, {})">批量生成 20 条</Button>
            </td>
          </tr>

          <!-- Data rows -->
          <tr
            v-for="row in rows"
            :key="row.id"
            :class="['data-row', selected.has(row.id) && 'selected']"
            :data-testid="`row-${row.id}`"
          >
            <td
              v-for="col in visibleCols"
              :key="col.id"
              :style="{
                width: colWidth(col) + 'px',
                minWidth: colWidth(col) + 'px',
                maxWidth: colWidth(col) + 'px',
                position: col.pinned ? 'sticky' : undefined,
                left: col.pinned === 'left' ? leftOffset(col) + 'px' : undefined,
                right: col.pinned === 'right' ? rightOffset(col) + 'px' : undefined,
                height: rowHeight + 'px',
              }"
              :class="['data-td', col.pinned === 'left' && 'pinned-left', col.pinned === 'right' && 'pinned-right']"
              :data-testid="`cell-${row.id}-${col.id}`"
            >
              <template v-if="col.id === '__select__'">
                <div class="flex items-center justify-center h-full">
                  <Checkbox :model-value="selected.has(row.id)" @update:model-value="toggleRowSelect(row.id)" :data-testid="`select-${row.id}`" />
                </div>
              </template>
              <template v-else-if="col.id === '__actions__'">
                <div class="flex items-center justify-center h-full">
                  <button type="button" class="p-1 rounded hover:bg-muted text-destructive" @click="deleteRow(row.id)" :data-testid="`row-del-${row.id}`" title="删除">
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </template>
              <template v-else-if="col.id === 'id'">
                <div class="px-2 text-xs text-muted-foreground h-full flex items-center">{{ row.id }}</div>
              </template>
              <template v-else-if="col.id === 'created_at'">
                <div class="px-2 text-xs text-muted-foreground h-full flex items-center truncate">{{ cellDisplay(row, 'created_at') }}</div>
              </template>
              <EditableCell
                v-else-if="fieldByName[col.id]"
                :value="cellDisplay(row, col.id)"
                :field="fieldByName[col.id]"
                :row-height="rowHeight"
                :readonly="isReadonly(col.id)"
                @save="(v) => saveCell(row, col.id, v)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Footer toolbar -->
    <div class="flex items-center justify-between mt-3 flex-wrap gap-2">
      <div class="text-sm text-muted-foreground">
        共 <span data-testid="total-count">{{ total }}</span> 条
        <span v-if="selected.size > 0" class="ml-2">
          已选 {{ selected.size }}
          <Button size="sm" variant="destructive" class="ml-2 h-7 text-xs" @click="batchDelete" data-testid="btn-batch-delete">
            <Trash2 class="w-3 h-3 mr-1" /> 批量删除({{ selected.size }})
          </Button>
        </span>
      </div>
      <div class="flex items-center gap-2">
        <Select :model-value="String(pageSize)" @update:model-value="onPageSizeChange">
          <SelectTrigger class="h-8 w-20 text-xs" data-testid="page-size">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10">10</SelectItem>
            <SelectItem value="20">20</SelectItem>
            <SelectItem value="50">50</SelectItem>
            <SelectItem value="100">100</SelectItem>
          </SelectContent>
        </Select>
        <div class="flex items-center gap-1 text-xs">
          <Button size="sm" variant="outline" class="h-7" :disabled="page <= 1" @click="page--" data-testid="page-prev">上一页</Button>
          <span class="px-2" data-testid="page-info">{{ page }} / {{ totalPages }}</span>
          <Button size="sm" variant="outline" class="h-7" :disabled="page >= totalPages" @click="page++" data-testid="page-next">下一页</Button>
        </div>
      </div>
    </div>

    <DataGenerator
      v-model:open="genOpen"
      :fields="fields"
      @generate="doGenerate"
    />
  </div>
</template>

<style scoped>
.data-table {
  table-layout: fixed;
  font-size: 0.875rem;
}
.data-th {
  background: #f1f5f9;
  border-bottom: 1px solid #e2e8f0;
  text-align: left;
  vertical-align: middle;
  padding: 0;
  height: 44px;
}
.data-td {
  border-bottom: 1px solid #e2e8f0;
  padding: 0;
  box-sizing: border-box;
  overflow: hidden;
  background: #ffffff;
  background-clip: padding-box;
}
.data-row:hover .data-td {
  background: #f8fafc;
}
.data-row.selected .data-td {
  background: #eff6ff;
}
/* Pinned columns must be fully opaque to avoid scrolling content showing through */
.pinned-left {
  background: #ffffff !important;
  background-clip: padding-box;
  box-shadow: 1px 0 0 #e2e8f0, 3px 0 6px -3px rgba(0,0,0,.08);
  z-index: 4 !important;
}
.pinned-right {
  background: #ffffff !important;
  background-clip: padding-box;
  box-shadow: -1px 0 0 #e2e8f0, -3px 0 6px -3px rgba(0,0,0,.08);
  z-index: 4 !important;
}
.data-th.pinned-left,
.data-th.pinned-right {
  background: #f1f5f9 !important;
  z-index: 6 !important;
}
.data-row:hover .pinned-left,
.data-row:hover .pinned-right {
  background: #f8fafc !important;
}
.data-row.selected .pinned-left,
.data-row.selected .pinned-right {
  background: #eff6ff !important;
}
</style>
