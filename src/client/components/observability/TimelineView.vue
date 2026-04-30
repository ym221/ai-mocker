<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useApi } from '../../composables/use-api';
import PhaseBar from './PhaseBar.vue';
import { Button } from '../ui/button';
import { RefreshCw, AlertTriangle, Wrench, Cpu, Zap } from 'lucide-vue-next';

const props = defineProps<{
  moduleName: string;
  active: boolean; // only fetch when tab is active
}>();

const api = useApi();
const loading = ref(false);
const error = ref<string | null>(null);
const data = ref<any>(null);

async function load() {
  if (!props.moduleName) return;
  loading.value = true;
  error.value = null;
  try {
    const resp = await api.get<{ success: boolean; data: any }>(`/api/modules/${encodeURIComponent(props.moduleName)}/timeline`);
    // Server wraps payload in { success, data, message }
    data.value = (resp as any)?.data ?? resp;
  } catch (err: any) {
    error.value = err?.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.moduleName, props.active] as [string, boolean],
  ([_name, active]) => { if (active) load(); },
  { immediate: true },
);

function formatMs(ms?: number | null) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

const CAUSE_LABELS: Record<string, string> = {
  sql_exec_failed: 'SQL 执行失败',
  run_test_failed: '测试失败',
  write_failed: '文件写入失败',
  spec_invalid: '规范校验失败',
  meta_parse_error: '_meta.json 解析失败',
};

const repairsByCause = computed(() => {
  const repairs = data.value?.repairs ?? [];
  const map = new Map<string, number>();
  for (const r of repairs) map.set(r.cause, (map.get(r.cause) ?? 0) + 1);
  return Array.from(map.entries()).map(([cause, count]) => ({ cause, count }));
});

const expandedRepairIdx = ref<number | null>(null);
function toggleRepair(i: number) {
  expandedRepairIdx.value = expandedRepairIdx.value === i ? null : i;
}
</script>

<template>
  <div class="timeline-root">
    <div class="timeline-header">
      <div class="text-sm text-muted-foreground">
        会话执行日志（仅记录,不影响生成性能）
      </div>
      <Button size="sm" variant="outline" @click="load" :disabled="loading" data-testid="timeline-refresh">
        <RefreshCw class="w-3.5 h-3.5 mr-1.5" :class="{ 'animate-spin': loading }" />
        刷新
      </Button>
    </div>

    <div v-if="loading" class="text-center py-8 text-muted-foreground" data-testid="timeline-loading">加载中...</div>
    <div v-else-if="error" class="py-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3" data-testid="timeline-error">
      {{ error }}
    </div>
    <div v-else-if="!data || !data.available" class="py-8 text-center text-muted-foreground" data-testid="timeline-empty">
      <div>无执行日志</div>
      <div class="text-xs mt-1">本模块尚未通过 AI 生成,或会话早于本能力上线</div>
    </div>
    <template v-else>
      <!-- Top: Summary cards -->
      <div class="grid grid-cols-4 gap-3 mb-4" data-testid="timeline-summary">
        <div class="card-stat">
          <div class="card-stat-label">总耗时</div>
          <div class="card-stat-val">{{ formatMs(data.totalMs) }}</div>
        </div>
        <div class="card-stat">
          <div class="card-stat-label">LLM 轮次</div>
          <div class="card-stat-val">{{ data.llmRounds?.length ?? 0 }}</div>
        </div>
        <div class="card-stat">
          <div class="card-stat-label">工具调用</div>
          <div class="card-stat-val">{{ data.totals?.toolCallCount ?? 0 }}</div>
        </div>
        <div class="card-stat" :class="{ 'card-stat-warn': (data.totals?.repairCount ?? 0) > 0 }">
          <div class="card-stat-label">修复次数</div>
          <div class="card-stat-val">{{ data.totals?.repairCount ?? 0 }}</div>
        </div>
      </div>

      <!-- Phase bar -->
      <div class="section">
        <div class="section-title"><Zap class="w-3.5 h-3.5" /> 阶段占比</div>
        <PhaseBar :phases="data.phases || []" :total-ms="data.totalMs" />
      </div>

      <!-- Tools -->
      <div class="section" v-if="(data.tools?.length ?? 0) > 0">
        <div class="section-title"><Cpu class="w-3.5 h-3.5" /> 工具调用统计</div>
        <table class="table-tools">
          <thead><tr><th>工具</th><th>次数</th><th>累计</th><th>平均</th><th>失败</th></tr></thead>
          <tbody>
            <tr v-for="t in data.tools" :key="t.toolName" data-testid="tool-row">
              <td class="mono">{{ t.toolName }}</td>
              <td>{{ t.count }}</td>
              <td>{{ formatMs(t.totalMs) }}</td>
              <td>{{ formatMs(t.avgMs) }}</td>
              <td :class="{ 'text-red-600 font-semibold': t.errorCount > 0 }">{{ t.errorCount }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- LLM rounds -->
      <div class="section" v-if="(data.llmRounds?.length ?? 0) > 0">
        <div class="section-title"><Cpu class="w-3.5 h-3.5" /> LLM 轮次</div>
        <table class="table-tools">
          <thead><tr><th>轮次</th><th>耗时</th><th>首 token 延迟</th><th>模型</th></tr></thead>
          <tbody>
            <tr v-for="r in data.llmRounds" :key="r.round">
              <td>#{{ r.round }}</td>
              <td>{{ formatMs(r.totalMs) }}</td>
              <td>{{ r.ttftMs == null ? '—' : formatMs(r.ttftMs) }}</td>
              <td class="mono text-xs">{{ r.model || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Repairs -->
      <div class="section" v-if="(data.repairs?.length ?? 0) > 0" data-testid="timeline-repairs">
        <div class="section-title"><Wrench class="w-3.5 h-3.5 text-red-600" /> 修复事件 ({{ data.repairs.length }})</div>
        <div class="repair-summary">
          <span v-for="r in repairsByCause" :key="r.cause" class="repair-chip">
            {{ CAUSE_LABELS[r.cause] || r.cause }} × {{ r.count }}
          </span>
        </div>
        <div class="repair-list">
          <div v-for="(rep, i) in data.repairs" :key="i" class="repair-item" @click="toggleRepair(i)">
            <div class="flex items-start gap-2">
              <AlertTriangle class="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
              <div class="flex-1 min-w-0">
                <div class="text-sm">
                  <span class="font-semibold">第 {{ rep.attempt }} 次</span>
                  <span class="ml-2">{{ CAUSE_LABELS[rep.cause] || rep.cause }}</span>
                </div>
                <div v-if="rep.targetFiles?.length" class="text-xs text-muted-foreground">
                  目标: {{ rep.targetFiles.join(', ') }}
                </div>
                <pre v-if="expandedRepairIdx === i" class="repair-snippet">{{ rep.errorSnippet }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Raw events (collapsible) -->
      <details class="section">
        <summary class="cursor-pointer text-sm font-medium">原始事件 ({{ data.totals?.eventCount ?? 0 }})</summary>
        <pre class="raw-events">{{ JSON.stringify(data.rawEvents?.slice(0, 50) ?? [], null, 2) }}</pre>
        <div v-if="(data.rawEvents?.length ?? 0) > 50" class="text-xs text-muted-foreground">仅展示前 50 条</div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.timeline-root {
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.section {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 14px;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 10px;
}
.card-stat {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
}
.card-stat-warn { border-color: #fecaca; background: #fef2f2; }
.card-stat-label { font-size: 11px; color: #64748b; }
.card-stat-val { font-size: 18px; font-weight: 600; color: #0f172a; margin-top: 2px; }
.table-tools { width: 100%; font-size: 13px; border-collapse: collapse; }
.table-tools th, .table-tools td { text-align: left; padding: 6px 8px; }
.table-tools th { color: #64748b; font-weight: 500; border-bottom: 1px solid #e2e8f0; }
.table-tools tbody tr { border-bottom: 1px solid #f1f5f9; }
.table-tools tbody tr:hover { background: #f8fafc; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.repair-summary { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.repair-chip {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
}
.repair-list { display: flex; flex-direction: column; gap: 6px; }
.repair-item {
  border: 1px solid #fee2e2;
  background: #fef2f2;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
}
.repair-snippet {
  margin-top: 6px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #fff;
  border: 1px solid #fecaca;
  border-radius: 4px;
  padding: 6px 8px;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: #7f1d1d;
}
.raw-events {
  margin-top: 8px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  padding: 8px 10px;
  max-height: 320px;
  overflow: auto;
  white-space: pre;
  color: #334155;
}
</style>
