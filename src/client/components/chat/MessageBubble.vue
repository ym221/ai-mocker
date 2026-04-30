<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { Loader2, AlertCircle, Boxes, ArrowRight } from 'lucide-vue-next';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useRouter } from 'vue-router';
import { useTypewriter } from '@/composables/use-typewriter';

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result?: string;
}

interface ModuleCard {
  name: string;
  displayName: string;
  description: string | null;
  basePath: string;
  status: string;
  endpointCount: number;
}

const props = defineProps<{
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  thinkingComplete?: boolean;
  toolCalls?: ToolCallInfo[];
  modules?: ModuleCard[];
  messageError?: string;
  streamDone?: boolean;
  aborted?: boolean;
  abortReason?: string;
  startedAt?: number;
  /** When 'server_restart' aborted, parent passes the original user content here so the retry button can resend it. */
  retryUserContent?: string;
}>();

const emit = defineEmits<{
  (e: 'retry', content: string): void;
}>();

const isServerRestart = computed(() => props.aborted && props.abortReason === 'server_restart');

const router = useRouter();
const isUser = computed(() => props.role === 'user');

// ===== 思考过程（仅状态徽章，不展开具体内容） =====
const hasThinking = computed(() => !!props.thinking);
const isThinking = computed(() => hasThinking.value && !props.thinkingComplete);

// ===== 生成中状态 =====
// 判定顺序：终态优先 > 存在产物（modules/error） > 否则视为进行中
//
// 历史行为只在 toolCalls.length>0 时才置位,导致用户发送后到第一次 tool_call
// 之间(常 20-30s)看不到"进行中..."徽章,徽章一出现就跳到 20s+。改为:
// 只要不是终态,就视为进行中(thinking / 等待首响应 / 工具调用都算)。
const isGenerating = computed(() => {
  if (isUser.value) return false;
  if (props.streamDone) return false;
  if (props.aborted) return false;
  if (props.messageError) return false;
  // 收到 module cards 意味着后端已进入 finalize,AI 执行完成 — 不再显示"进行中"
  if ((props.modules?.length ?? 0) > 0) return false;
  return true;
});

// 执行中的提示（统一为"进行中..."，不暴露具体操作）
const currentPhaseText = computed(() => isGenerating.value ? '进行中...' : '');

// ===== 已用时计时器（基于消息 startedAt，切页不重置） =====
const nowTs = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

watch(isGenerating, (v) => {
  if (v) {
    nowTs.value = Date.now();
    if (!tickTimer) {
      tickTimer = setInterval(() => { nowTs.value = Date.now(); }, 1000);
    }
  } else {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }
}, { immediate: true });

onBeforeUnmount(() => {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
});

const elapsedSec = computed(() => {
  if (!props.startedAt) return 0;
  const diff = Math.floor((nowTs.value - props.startedAt) / 1000);
  return diff < 0 ? 0 : diff;
});

const elapsedText = computed(() => {
  const s = elapsedSec.value;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, '0')}s`;
});

// ===== 正文渲染（AI 流式：打字机；用户/历史消息：直接展示） =====
const THINKING_TAG_RE = /<(thought|think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;
const THINKING_OPEN_RE = /<(thought|think|thinking|reasoning)>[\s\S]*$/i;

function stripThinkingTags(s: string): string {
  return s.replace(THINKING_TAG_RE, '').replace(THINKING_OPEN_RE, '').trim();
}

const cleanContent = computed(() => {
  if (isUser.value || !props.content) return props.content || '';
  return stripThinkingTags(props.content);
});

const isStreamingAssistant = computed(() => !isUser.value && !props.streamDone);

const typewriter = useTypewriter({
  source: () => cleanContent.value,
  enabled: () => isStreamingAssistant.value,
  done: () => !!props.streamDone,
});

const displayedRaw = computed(() =>
  isStreamingAssistant.value ? typewriter.displayed.value : cleanContent.value
);

const renderedContent = computed(() => {
  const src = displayedRaw.value;
  if (!src) return '';
  if (isUser.value) return src;
  const html = marked.parse(src, { breaks: true, async: false }) as string;
  return DOMPurify.sanitize(html);
});

// ===== 模块卡片跳转 =====
function openModule(m: ModuleCard) {
  if (m.status === 'creating') return;
  router.push(`/modules/${m.name}`);
}

const CARD_STATUS_TEXT: Record<string, string> = {
  active: '就绪',
  creating: '创建中...',
  editing: '编辑中',
  error: '失败',
  disabled: '已禁用',
};
const CARD_STATUS_CLASS: Record<string, string> = {
  active: 'status-active',
  creating: 'status-creating',
  editing: 'status-editing',
  error: 'status-error',
  disabled: 'status-disabled',
};
const cardStatusText = (s: string) => CARD_STATUS_TEXT[s] || s;
const cardStatusClass = (s: string) => CARD_STATUS_CLASS[s] || 'status-error';
</script>

<template>
  <!-- 用户消息：右侧气泡 -->
  <div v-if="isUser" class="flex justify-end py-3">
    <div class="max-w-[70%] rounded-2xl px-4 py-2.5 bg-primary text-primary-foreground text-sm whitespace-pre-wrap break-words">
      {{ content }}
    </div>
  </div>

  <!-- AI 消息：文章式，无头像无气泡 -->
  <div v-else class="py-4 space-y-3">
    <!-- 思考过程（仅状态徽章，不暴露内容） -->
    <div v-if="hasThinking" class="thinking-wrapper" data-testid="thinking-badge">
      <div class="thinking-trigger">
        <span v-if="isThinking" class="thinking-dot"></span>
        <svg v-else class="w-3.5 h-3.5 text-green-500 flex-shrink-0" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zm3.41 5.59L7 10l-2.41-2.41L5.3 6.88 7 8.59l3.71-3.71.7.71z" />
        </svg>
        <span class="thinking-trigger-text">{{ isThinking ? '思考中...' : '已完成思考' }}</span>
      </div>
    </div>

    <!-- 生成中状态（已用时） -->
    <div v-if="isGenerating" class="generating-banner" data-testid="generating-banner">
      <div class="generating-banner-row">
        <Loader2 class="w-4 h-4 animate-spin text-primary flex-shrink-0" />
        <span class="generating-text">{{ currentPhaseText }}</span>
        <span class="generating-elapsed" data-testid="generating-elapsed">{{ elapsedText }}</span>
      </div>
    </div>

    <!-- 正文（markdown 渲染） -->
    <div
      v-if="renderedContent"
      class="prose prose-sm max-w-none break-words text-foreground chat-content
             prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5
             prose-li:my-0.5 prose-pre:my-2
             prose-headings:my-2 prose-headings:font-semibold
             prose-code:bg-muted prose-code:px-1 prose-code:rounded
             prose-pre:bg-muted prose-pre:p-3 prose-pre:rounded-md"
      v-html="renderedContent"
    />

    <!-- 模块卡片（生成结果） -->
    <div v-if="modules && modules.length > 0" class="module-cards">
      <div
        v-for="m in modules"
        :key="m.name"
        class="module-card"
        :class="{ 'module-card-pending': m.status === 'creating' }"
        :data-testid="`bubble-module-card-${m.name}`"
        @click="openModule(m)"
      >
        <div class="module-card-icon">
          <Boxes class="w-5 h-5 text-primary" />
        </div>
        <div class="module-card-body">
          <div class="module-card-header">
            <span class="module-card-title">{{ m.displayName }}</span>
            <span
              class="module-card-status"
              :class="cardStatusClass(m.status)"
              :data-testid="`bubble-card-status-${m.name}`"
            >
              <Loader2
                v-if="m.status === 'creating' || m.status === 'editing'"
                class="w-3 h-3 animate-spin inline-block mr-0.5"
              />
              {{ cardStatusText(m.status) }}
            </span>
          </div>
          <p v-if="m.description" class="module-card-desc">{{ m.description }}</p>
          <div class="module-card-meta">
            <span>{{ m.basePath }}</span>
            <span v-if="m.endpointCount > 0">· {{ m.endpointCount }} 个接口</span>
          </div>
        </div>
        <ArrowRight v-if="m.status !== 'creating'" class="w-4 h-4 text-muted-foreground flex-shrink-0 self-center" />
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="messageError" class="error-banner">
      <AlertCircle class="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
      <div class="error-body">
        <div class="error-title">执行失败</div>
        <div class="error-msg">{{ messageError }}</div>
      </div>
    </div>

    <!-- 被中断提示 -->
    <div v-if="aborted && !messageError" class="aborted-banner" :class="{ 'aborted-banner-restart': isServerRestart }">
      <AlertCircle class="w-4 h-4 text-orange-500 flex-shrink-0" />
      <span v-if="isServerRestart">服务已重启,生成被中断</span>
      <span v-else>已停止生成</span>
      <button
        v-if="isServerRestart && retryUserContent"
        @click="emit('retry', retryUserContent)"
        class="aborted-retry-btn"
        data-testid="abort-retry-btn"
      >
        重试
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-content {
  font-size: 13px !important;
  line-height: 1.7;
}
.chat-content :deep(h1) { font-size: 1.15em; }
.chat-content :deep(h2) { font-size: 1.05em; }
.chat-content :deep(h3) { font-size: 1em; }
:deep(pre) {
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 100%;
}
:deep(table) {
  display: block;
  overflow-x: auto;
  max-width: 100%;
}
:deep(code) {
  word-break: break-word;
}

/* ===== 思考过程 ===== */
.thinking-wrapper {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.thinking-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 13px;
  color: hsl(var(--muted-foreground));
  user-select: none;
  align-self: flex-start;
}

.thinking-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: hsl(var(--primary));
  animation: dot-pulse 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}

/* ===== 生成中提示 ===== */
.generating-banner {
  display: inline-flex;
  padding: 6px 14px;
  border-radius: 14px;
  background: hsl(var(--primary) / 0.06);
  color: hsl(var(--primary));
  font-size: 13px;
}
.generating-banner-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.generating-text {
  font-weight: 500;
}
.generating-elapsed {
  font-size: 12px;
  color: hsl(var(--primary) / 0.7);
  font-variant-numeric: tabular-nums;
  margin-left: 4px;
}

/* ===== 模块卡片 ===== */
.module-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.module-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  border: 1px solid hsl(var(--border));
  border-radius: 10px;
  background: hsl(var(--card));
  cursor: pointer;
  transition: all 0.15s;
}
.module-card:hover {
  border-color: hsl(var(--primary) / 0.5);
  box-shadow: 0 2px 8px hsl(var(--primary) / 0.08);
  transform: translateY(-1px);
}

.module-card-icon {
  padding: 8px;
  background: hsl(var(--primary) / 0.1);
  border-radius: 8px;
  flex-shrink: 0;
}

.module-card-body {
  flex: 1;
  min-width: 0;
}

.module-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.module-card-title {
  font-size: 14px;
  font-weight: 600;
  color: hsl(var(--foreground));
}

.module-card-status {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  font-weight: 500;
}
.status-active {
  background: rgba(34, 197, 94, 0.12);
  color: rgb(21, 128, 61);
}
.status-error {
  background: rgba(239, 68, 68, 0.12);
  color: rgb(185, 28, 28);
}
.status-creating {
  background: rgba(59, 130, 246, 0.12);
  color: rgb(29, 78, 216);
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.status-editing {
  background: rgba(234, 179, 8, 0.14);
  color: rgb(161, 98, 7);
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.status-disabled {
  background: rgba(148, 163, 184, 0.16);
  color: rgb(71, 85, 105);
}
.module-card-pending {
  opacity: 0.8;
  cursor: wait;
}
.module-card-pending:hover {
  transform: none;
  box-shadow: none;
}

.module-card-desc {
  font-size: 12.5px;
  color: hsl(var(--muted-foreground));
  margin: 4px 0 6px 0;
  line-height: 1.5;
}

.module-card-meta {
  display: flex;
  gap: 6px;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  font-family: ui-monospace, monospace;
}

/* ===== 错误提示 ===== */
.error-banner {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid rgba(239, 68, 68, 0.2);
  background: rgba(239, 68, 68, 0.05);
  border-radius: 10px;
  color: rgb(185, 28, 28);
}
.error-body {
  flex: 1;
  min-width: 0;
}
.error-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 2px;
}
.error-msg {
  font-size: 12.5px;
  color: hsl(var(--muted-foreground));
  line-height: 1.5;
  word-break: break-word;
}

/* ===== 已停止 ===== */
.aborted-banner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 16px;
  background: rgba(249, 115, 22, 0.08);
  color: rgb(194, 65, 12);
  font-size: 12.5px;
}
.aborted-banner-restart {
  background: rgba(59, 130, 246, 0.08);
  color: rgb(29, 78, 216);
}
.aborted-banner-restart .text-orange-500 {
  color: rgb(59, 130, 246) !important;
}
.aborted-retry-btn {
  margin-left: 8px;
  padding: 2px 10px;
  border-radius: 12px;
  background: rgb(59, 130, 246);
  color: #fff;
  font-size: 12px;
  border: 0;
  cursor: pointer;
  transition: opacity 0.15s;
}
.aborted-retry-btn:hover { opacity: 0.85; }
</style>
