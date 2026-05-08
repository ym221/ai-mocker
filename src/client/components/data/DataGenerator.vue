<script setup lang="ts">
import { ref, reactive, watch } from 'vue';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { Field } from './EditableCell.vue';
import type { FieldRule } from '@/composables/use-data-api';

const props = defineProps<{
  open: boolean;
  fields: Field[];
  defaultCount?: number;
}>();

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'generate', count: number, rules: Record<string, FieldRule>): void;
}>();

type RuleKind = 'faker' | 'sequence' | 'fixed';
interface RuleState { kind: RuleKind; prefix?: string; start?: number; fixed?: string }

const count = ref(props.defaultCount ?? 20);
const rules = reactive<Record<string, RuleState>>({});

watch(() => props.open, (v) => {
  if (v) {
    count.value = props.defaultCount ?? 20;
    for (const f of props.fields) {
      if (!rules[f.name]) rules[f.name] = { kind: 'faker' };
    }
  }
});

function buildRules(): Record<string, FieldRule> {
  const out: Record<string, FieldRule> = {};
  for (const f of props.fields) {
    const r = rules[f.name];
    if (!r || r.kind === 'faker') continue;
    if (r.kind === 'sequence') out[f.name] = { kind: 'sequence', prefix: r.prefix || '', start: Number(r.start) || 1 };
    else if (r.kind === 'fixed') out[f.name] = { kind: 'fixed', value: r.fixed ?? '' };
  }
  return out;
}

function submit() {
  const n = Math.max(1, Math.min(1000, Number(count.value) || 1));
  emit('generate', n, buildRules());
  emit('update:open', false);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>批量生成数据</DialogTitle>
      </DialogHeader>

      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <label class="text-sm w-20">生成数量</label>
          <Input v-model="count" type="number" min="1" max="1000" class="w-32" data-testid="gen-count" />
          <span class="text-xs text-muted-foreground">条（1-1000）</span>
        </div>

        <div class="border border-border rounded-md p-2 max-h-64 overflow-y-auto">
          <div class="text-xs text-muted-foreground mb-2">字段规则（可选自定义）</div>
          <div v-for="f in fields" :key="f.name" class="flex items-center gap-2 py-1">
            <span class="text-sm w-32 truncate">{{ f.displayName || f.name }}</span>
            <Select v-model="rules[f.name].kind">
              <SelectTrigger class="w-32 h-8 text-xs" :data-testid="`rule-kind-${f.name}`">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="faker">faker 默认</SelectItem>
                <SelectItem value="sequence">递增序号</SelectItem>
                <SelectItem value="fixed">固定值</SelectItem>
              </SelectContent>
            </Select>
            <template v-if="rules[f.name].kind === 'sequence'">
              <Input v-model="rules[f.name].prefix" placeholder="前缀" class="h-8 text-xs flex-1" :data-testid="`rule-prefix-${f.name}`" />
              <Input v-model="rules[f.name].start" type="number" placeholder="起始" class="h-8 text-xs w-20" :data-testid="`rule-start-${f.name}`" />
            </template>
            <template v-else-if="rules[f.name].kind === 'fixed'">
              <Input v-model="rules[f.name].fixed" placeholder="固定值" class="h-8 text-xs flex-1" :data-testid="`rule-fixed-${f.name}`" />
            </template>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">取消</Button>
        <Button @click="submit" data-testid="gen-submit">生成</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
