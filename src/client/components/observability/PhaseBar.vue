<script setup lang="ts">
import { computed } from 'vue';

interface PhaseSegment {
  phase: string;
  startedAtMs: number;
  durationMs: number;
  outcome: 'ok' | 'failed' | 'partial';
}

const props = defineProps<{
  phases: PhaseSegment[];
  totalMs: number | null;
}>();

const PHASE_COLORS: Record<string, string> = {
  prompt_build: '#94a3b8',  // slate
  llm_thinking: '#3b82f6',  // blue
  write_files: '#10b981',   // green
  sql_execute: '#f59e0b',   // amber
  run_test: '#a855f7',      // purple
  repair_loop: '#ef4444',   // red
  finalize: '#64748b',      // slate-dark
};

const PHASE_LABELS: Record<string, string> = {
  prompt_build: '构建提示',
  llm_thinking: 'LLM 思考',
  write_files: '写文件',
  sql_execute: '执行 SQL',
  run_test: '运行测试',
  repair_loop: '修复循环',
  finalize: '收尾',
};

function colorOf(phase: string) {
  return PHASE_COLORS[phase] ?? '#9ca3af';
}
function labelOf(phase: string) {
  return PHASE_LABELS[phase] ?? phase;
}

function formatMs(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

interface Segment {
  phase: string;
  durationMs: number;
  pct: number;
  outcome: string;
}

// Stack same-named phases together so the bar isn't confusing when LLM
// has multiple rounds (e.g. several llm_thinking segments).
//
// Denominator = sumKnown (recorded phases) so the bar shows the breakdown of
// *recorded* time and segments sum to 100%. The session's wall-clock totalMs
// is shown separately in the label below — if it differs from sumKnown we
// surface the gap as "未记录 / unrecorded" so the user can see something
// happened off-camera (e.g. tool work that wasn't instrumented).
const stacked = computed<Segment[]>(() => {
  const totals = new Map<string, { ms: number; outcome: string }>();
  for (const p of props.phases) {
    if (!Number.isFinite(p.durationMs) || p.durationMs <= 0) continue;
    const cur = totals.get(p.phase) ?? { ms: 0, outcome: 'ok' };
    cur.ms += p.durationMs;
    if (p.outcome !== 'ok') cur.outcome = p.outcome;
    totals.set(p.phase, cur);
  }
  const sumKnown = Array.from(totals.values()).reduce((a, b) => a + b.ms, 0);
  if (sumKnown <= 0) return [];

  // Order matches conceptual flow
  const ORDER = ['prompt_build', 'llm_thinking', 'write_files', 'sql_execute', 'run_test', 'repair_loop', 'finalize'];
  const segs: Segment[] = [];
  for (const k of ORDER) {
    const v = totals.get(k);
    if (v) segs.push({ phase: k, durationMs: v.ms, pct: (v.ms / sumKnown) * 100, outcome: v.outcome });
  }
  for (const [k, v] of totals.entries()) {
    if (!ORDER.includes(k)) segs.push({ phase: k, durationMs: v.ms, pct: (v.ms / sumKnown) * 100, outcome: v.outcome });
  }
  return segs;
});

const sumKnownMs = computed(() =>
  stacked.value.reduce((a, s) => a + s.durationMs, 0),
);
const unrecordedMs = computed(() => {
  if (!props.totalMs || props.totalMs <= sumKnownMs.value) return 0;
  return props.totalMs - sumKnownMs.value;
});
const totalLabel = computed(() => formatMs(props.totalMs ?? sumKnownMs.value));

function pctLabel(pct: number): string {
  if (!Number.isFinite(pct)) return '0%';
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}
// Clamp width to a small minimum so non-zero phases stay visible in the bar.
function widthStyle(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '0%';
  return `${Math.max(pct, 0.4).toFixed(2)}%`;
}
</script>

<template>
  <div class="phase-bar-root">
    <!-- Bar -->
    <div class="phase-bar" data-testid="phase-bar">
      <div
        v-for="seg in stacked"
        :key="seg.phase"
        :title="`${labelOf(seg.phase)} · ${formatMs(seg.durationMs)} (${pctLabel(seg.pct)})`"
        :style="{ width: widthStyle(seg.pct), background: colorOf(seg.phase) }"
        class="phase-seg"
        :class="{ 'phase-seg-failed': seg.outcome === 'failed' }"
        :data-phase="seg.phase"
      ></div>
    </div>

    <!-- Legend -->
    <div class="phase-legend">
      <div v-for="seg in stacked" :key="seg.phase" class="phase-legend-item">
        <span class="phase-dot" :style="{ background: colorOf(seg.phase) }"></span>
        <span class="phase-name">{{ labelOf(seg.phase) }}</span>
        <span class="phase-dur">{{ formatMs(seg.durationMs) }}</span>
        <span class="phase-pct">({{ pctLabel(seg.pct) }})</span>
      </div>
    </div>

    <!-- Total + unrecorded gap -->
    <div class="phase-total" data-testid="phase-total">
      总耗时：{{ totalLabel }}
      <span v-if="unrecordedMs > 0" class="phase-unrecorded" data-testid="phase-unrecorded">
        · 未记录 {{ formatMs(unrecordedMs) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.phase-bar-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.phase-bar {
  display: flex;
  width: 100%;
  height: 18px;
  border-radius: 6px;
  overflow: hidden;
  background: #f1f5f9;
}
.phase-seg {
  height: 100%;
  transition: opacity 0.2s;
  min-width: 2px;
}
.phase-seg:hover { opacity: 0.85; }
.phase-seg-failed {
  outline: 2px solid #ef4444;
  outline-offset: -2px;
}
.phase-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: #475569;
}
.phase-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.phase-dot {
  display: inline-block;
  width: 10px; height: 10px; border-radius: 2px;
}
.phase-name { color: #0f172a; font-weight: 500; }
.phase-dur { color: #475569; }
.phase-pct { color: #94a3b8; }
.phase-total { font-size: 13px; color: #0f172a; font-weight: 600; margin-top: 2px; }
.phase-unrecorded { font-weight: 400; color: #94a3b8; margin-left: 4px; }
</style>
