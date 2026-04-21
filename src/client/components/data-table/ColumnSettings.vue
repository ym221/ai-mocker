<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Sortable from 'sortablejs';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Settings2, GripVertical, Pin, PinOff, Search, RotateCcw, Save, X } from 'lucide-vue-next';
import type { ColumnConfig, ColumnPin, TableDensity } from './types';

const props = withDefaults(defineProps<{
  columns: ColumnConfig[];
  density?: TableDensity;
  showDensity?: boolean;
  showReset?: boolean;
  showPresets?: boolean;
  presets?: Record<string, { columns: ColumnConfig[]; density: TableDensity }>;
  activePreset?: string;
}>(), {
  showDensity: true,
  showReset: true,
  showPresets: true,
  density: 'normal',
});

const emit = defineEmits<{
  (e: 'update:columns', cols: ColumnConfig[]): void;
  (e: 'update:density', d: TableDensity): void;
  (e: 'update:activePreset', name: string | undefined): void;
  (e: 'reset'): void;
  (e: 'savePreset', name: string): void;
  (e: 'deletePreset', name: string): void;
}>();

const open = ref(false);
const search = ref('');

const filtered = computed(() => {
  const s = search.value.trim().toLowerCase();
  if (!s) return props.columns;
  return props.columns.filter(c => c.label.toLowerCase().includes(s) || c.id.toLowerCase().includes(s));
});

const leftCols = computed(() => filtered.value.filter(c => c.pinned === 'left'));
const centerCols = computed(() => filtered.value.filter(c => c.pinned === false));
const rightCols = computed(() => filtered.value.filter(c => c.pinned === 'right'));

const visibleCount = computed(() => props.columns.filter(c => c.visible).length);

function emitCols(next: ColumnConfig[]) {
  emit('update:columns', next);
}

function toggleVisible(id: string) {
  const next = props.columns.map(c => c.id === id ? { ...c, visible: !c.visible } : c);
  emitCols(next);
}

function setPin(id: string, pin: ColumnPin) {
  const next = props.columns.map(c => c.id === id ? { ...c, pinned: pin } : c);
  // reorder: left-pinned first (keep their order), then unpinned, then right
  const keepOrder = (ids: string[]) => ids.map(i => next.find(c => c.id === i)!);
  const leftIds = next.filter(c => c.pinned === 'left').map(c => c.id);
  const centerIds = next.filter(c => c.pinned === false).map(c => c.id);
  const rightIds = next.filter(c => c.pinned === 'right').map(c => c.id);
  emitCols([...keepOrder(leftIds), ...keepOrder(centerIds), ...keepOrder(rightIds)]);
}

function selectAll() {
  emitCols(props.columns.map(c => ({ ...c, visible: true })));
}
function selectNone() {
  emitCols(props.columns.map(c => c.fixed ? c : { ...c, visible: false }));
}

const presetNameInput = ref('');
const showSaveInput = ref(false);

function savePreset() {
  const name = presetNameInput.value.trim();
  if (!name) return;
  emit('savePreset', name);
  presetNameInput.value = '';
  showSaveInput.value = false;
}

function pickPreset(name: string) {
  emit('update:activePreset', name);
}

function deletePreset(name: string) {
  emit('deletePreset', name);
}

// --- Sortable setup ---
const leftEl = ref<HTMLElement>();
const centerEl = ref<HTMLElement>();
const rightEl = ref<HTMLElement>();
let sortables: Sortable[] = [];

function setupSortable() {
  destroySortable();
  const common: Sortable.Options = {
    group: 'column-settings',
    handle: '.col-drag-handle',
    animation: 150,
    ghostClass: 'col-ghost',
    chosenClass: 'col-chosen',
    dragClass: 'col-drag',
    filter: '.col-fixed',
    preventOnFilter: false,
    onEnd: (evt) => {
      const fromZone = (evt.from.dataset.zone || 'center') as 'left' | 'center' | 'right';
      const toZone = (evt.to.dataset.zone || 'center') as 'left' | 'center' | 'right';
      const oldIndex = evt.oldIndex ?? 0;
      const newIndex = evt.newIndex ?? 0;
      const id = evt.item.dataset.colId;
      if (!id) return;
      moveColumn(id, fromZone, toZone, oldIndex, newIndex);
      // Let Vue re-render; Sortable already moved the DOM node, so we need to undo that to keep Vue in sync
      // The array change will cause re-render with correct order.
      nextTick(setupSortable);
    },
  };
  if (leftEl.value) sortables.push(new Sortable(leftEl.value, common));
  if (centerEl.value) sortables.push(new Sortable(centerEl.value, common));
  if (rightEl.value) sortables.push(new Sortable(rightEl.value, common));
}

function destroySortable() {
  sortables.forEach(s => s.destroy());
  sortables = [];
}

function moveColumn(id: string, fromZone: 'left'|'center'|'right', toZone: 'left'|'center'|'right', oldIndex: number, newIndex: number) {
  // Work on full columns list (no filter) because the visible list in UI is unfiltered when search is empty.
  // When search is active, we don't allow reorder (handles are hidden).
  const all = [...props.columns];
  const moving = all.find(c => c.id === id);
  if (!moving || moving.fixed) return;

  // Remove from old position
  const idx = all.indexOf(moving);
  all.splice(idx, 1);

  // Update pin
  const newPin: ColumnPin = toZone === 'left' ? 'left' : toZone === 'right' ? 'right' : false;
  moving.pinned = newPin;

  // Compute insertion index in the full list: find the newIndex-th item in toZone within the remaining list
  const zoneItems = all.filter(c => (toZone === 'left' ? c.pinned === 'left' : toZone === 'right' ? c.pinned === 'right' : c.pinned === false));
  const targetInZone = zoneItems[newIndex] ?? zoneItems[zoneItems.length - 1];
  let insertAt: number;
  if (!targetInZone) {
    // empty zone — find position based on zone order: left < center < right
    if (toZone === 'left') insertAt = 0;
    else if (toZone === 'right') insertAt = all.length;
    else {
      const leftEnd = all.findIndex(c => c.pinned !== 'left');
      insertAt = leftEnd === -1 ? all.length : leftEnd;
    }
  } else {
    insertAt = all.indexOf(targetInZone);
    if (oldIndex < newIndex && fromZone === toZone) insertAt++;
  }
  all.splice(insertAt, 0, moving);

  emitCols(all);
}

watch(open, async (v) => {
  if (v) {
    await nextTick();
    setupSortable();
  } else {
    destroySortable();
  }
});

onBeforeUnmount(destroySortable);

const densityOpts: { value: TableDensity; label: string }[] = [
  { value: 'compact', label: '紧凑' },
  { value: 'normal', label: '标准' },
  { value: 'comfortable', label: '宽松' },
];

function setDensity(d: TableDensity) {
  emit('update:density', d);
}

function reset() {
  emit('reset');
  search.value = '';
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="outline" size="sm" data-testid="column-settings-trigger">
        <Settings2 class="w-4 h-4 mr-1" />
        列设置
        <span class="ml-1 text-xs text-muted-foreground">({{ visibleCount }}/{{ columns.length }})</span>
      </Button>
    </PopoverTrigger>

    <PopoverContent class="w-96 p-0" align="end">
     <div data-testid="column-settings-panel" class="max-h-[75vh] overflow-y-auto">
      <div class="p-3 border-b border-border space-y-2">
        <div class="relative">
          <Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input v-model="search" placeholder="搜索列名..." class="pl-7 h-8 text-sm" data-testid="column-search" />
        </div>
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" class="h-7 text-xs" @click="selectAll" data-testid="column-select-all">全选</Button>
          <Button variant="ghost" size="sm" class="h-7 text-xs" @click="selectNone" data-testid="column-select-none">全不选</Button>
          <Button v-if="showReset" variant="ghost" size="sm" class="h-7 text-xs" @click="reset" data-testid="column-reset">
            <RotateCcw class="w-3 h-3 mr-1" />
            重置默认
          </Button>
        </div>
      </div>

      <div v-if="showDensity" class="p-3 border-b border-border">
        <div class="text-xs text-muted-foreground mb-1.5">密度</div>
        <div class="flex gap-1">
          <button
            v-for="opt in densityOpts"
            :key="opt.value"
            type="button"
            class="flex-1 h-7 text-xs rounded-md border transition-colors"
            :class="density === opt.value ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'"
            :data-testid="`density-${opt.value}`"
            @click="setDensity(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div class="p-3 space-y-3 text-sm">
        <!-- Left pinned -->
        <div>
          <div class="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Pin class="w-3 h-3" /> 左固定
          </div>
          <div ref="leftEl" data-zone="left" data-testid="zone-left" class="space-y-1 min-h-[8px] rounded border border-dashed border-border/50 p-1">
            <div
              v-for="col in leftCols"
              :key="col.id"
              :data-col-id="col.id"
              :data-testid="`col-item-${col.id}`"
              :class="[
                'flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50',
                col.fixed && 'col-fixed opacity-70',
              ]"
            >
              <GripVertical v-if="!col.fixed && !search" class="col-drag-handle w-3.5 h-3.5 text-muted-foreground cursor-grab" />
              <span v-else class="w-3.5 h-3.5 inline-block" />
              <Checkbox :model-value="col.visible" :disabled="col.fixed" @update:model-value="toggleVisible(col.id)" :data-testid="`col-vis-${col.id}`" />
              <span class="flex-1 truncate">{{ col.label }}</span>
              <button type="button" class="p-1 rounded hover:bg-accent" title="取消固定" @click="setPin(col.id, false)" :data-testid="`pin-none-${col.id}`" :disabled="col.fixed">
                <PinOff class="w-3.5 h-3.5" />
              </button>
              <button type="button" class="p-1 rounded hover:bg-accent" title="右固定" @click="setPin(col.id, 'right')" :data-testid="`pin-right-${col.id}`" :disabled="col.fixed">
                <Pin class="w-3.5 h-3.5 rotate-90" />
              </button>
            </div>
            <div v-if="leftCols.length === 0" class="text-xs text-muted-foreground/60 text-center py-1">拖到此处左固定</div>
          </div>
        </div>

        <!-- Center -->
        <div>
          <div class="text-xs text-muted-foreground mb-1">可滚动列</div>
          <div ref="centerEl" data-zone="center" data-testid="zone-center" class="space-y-1 min-h-[8px]">
            <div
              v-for="col in centerCols"
              :key="col.id"
              :data-col-id="col.id"
              :data-testid="`col-item-${col.id}`"
              :class="[
                'flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50',
                col.fixed && 'col-fixed opacity-70',
              ]"
            >
              <GripVertical v-if="!col.fixed && !search" class="col-drag-handle w-3.5 h-3.5 text-muted-foreground cursor-grab" />
              <span v-else class="w-3.5 h-3.5 inline-block" />
              <Checkbox :model-value="col.visible" :disabled="col.fixed" @update:model-value="toggleVisible(col.id)" :data-testid="`col-vis-${col.id}`" />
              <span class="flex-1 truncate">{{ col.label }}</span>
              <button type="button" class="p-1 rounded hover:bg-accent" title="左固定" @click="setPin(col.id, 'left')" :data-testid="`pin-left-${col.id}`" :disabled="col.fixed">
                <Pin class="w-3.5 h-3.5 -rotate-90" />
              </button>
              <button type="button" class="p-1 rounded hover:bg-accent" title="右固定" @click="setPin(col.id, 'right')" :data-testid="`pin-right-${col.id}`" :disabled="col.fixed">
                <Pin class="w-3.5 h-3.5 rotate-90" />
              </button>
            </div>
          </div>
        </div>

        <!-- Right pinned -->
        <div>
          <div class="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Pin class="w-3 h-3 rotate-180" /> 右固定
          </div>
          <div ref="rightEl" data-zone="right" data-testid="zone-right" class="space-y-1 min-h-[8px] rounded border border-dashed border-border/50 p-1">
            <div
              v-for="col in rightCols"
              :key="col.id"
              :data-col-id="col.id"
              :data-testid="`col-item-${col.id}`"
              :class="[
                'flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50',
                col.fixed && 'col-fixed opacity-70',
              ]"
            >
              <GripVertical v-if="!col.fixed && !search" class="col-drag-handle w-3.5 h-3.5 text-muted-foreground cursor-grab" />
              <span v-else class="w-3.5 h-3.5 inline-block" />
              <Checkbox :model-value="col.visible" :disabled="col.fixed" @update:model-value="toggleVisible(col.id)" :data-testid="`col-vis-${col.id}`" />
              <span class="flex-1 truncate">{{ col.label }}</span>
              <button type="button" class="p-1 rounded hover:bg-accent" title="左固定" @click="setPin(col.id, 'left')" :data-testid="`pin-left-${col.id}`" :disabled="col.fixed">
                <Pin class="w-3.5 h-3.5 -rotate-90" />
              </button>
              <button type="button" class="p-1 rounded hover:bg-accent" title="取消固定" @click="setPin(col.id, false)" :data-testid="`pin-none-${col.id}`" :disabled="col.fixed">
                <PinOff class="w-3.5 h-3.5" />
              </button>
            </div>
            <div v-if="rightCols.length === 0" class="text-xs text-muted-foreground/60 text-center py-1">拖到此处右固定</div>
          </div>
        </div>
      </div>

      <div v-if="showPresets" class="p-3 border-t border-border space-y-2">
        <div class="text-xs text-muted-foreground">预设视图</div>
        <div class="flex flex-wrap gap-1" data-testid="preset-list">
          <button
            v-for="(_, name) in presets"
            :key="name"
            type="button"
            class="group inline-flex items-center gap-1 px-2 h-7 text-xs rounded-md border transition-colors"
            :class="activePreset === name ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'"
            :data-testid="`preset-${name}`"
            @click="pickPreset(String(name))"
          >
            {{ name }}
            <X class="w-3 h-3 opacity-50 group-hover:opacity-100" @click.stop="deletePreset(String(name))" />
          </button>
          <span v-if="!presets || Object.keys(presets).length === 0" class="text-xs text-muted-foreground/60">暂无</span>
        </div>
        <div v-if="showSaveInput" class="flex gap-1">
          <Input v-model="presetNameInput" placeholder="预设名称" class="h-7 text-xs" @keyup.enter="savePreset" data-testid="preset-name-input" />
          <Button size="sm" class="h-7 text-xs" @click="savePreset" data-testid="preset-save-confirm">保存</Button>
          <Button variant="ghost" size="sm" class="h-7 text-xs" @click="showSaveInput = false">取消</Button>
        </div>
        <Button v-else variant="outline" size="sm" class="h-7 text-xs w-full" @click="showSaveInput = true" data-testid="preset-save-open">
          <Save class="w-3 h-3 mr-1" />
          另存为预设
        </Button>
      </div>
     </div>
    </PopoverContent>
  </Popover>
</template>

<style>
.col-ghost { opacity: 0.4; background: hsl(var(--muted)); }
.col-chosen { background: hsl(var(--accent)); }
.col-drag { cursor: grabbing; }
</style>
