<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import MessageBubble from './MessageBubble.vue';
import type { DisplayMessage } from '../../stores/chat';

const props = defineProps<{
  messages: DisplayMessage[];
}>();

const emit = defineEmits<{
  (e: 'retry', content: string): void;
}>();

/** Look up the user message that preceded the given assistant index. */
function userContentBefore(idx: number): string | undefined {
  for (let i = idx - 1; i >= 0; i--) {
    if (props.messages[i].role === 'user') return props.messages[i].content;
  }
  return undefined;
}

const listRef = ref<HTMLDivElement | null>(null);
const autoScroll = ref(true);

function scrollToBottom() {
  if (listRef.value && autoScroll.value) {
    nextTick(() => {
      listRef.value!.scrollTop = listRef.value!.scrollHeight;
    });
  }
}

function handleScroll() {
  if (!listRef.value) return;
  const { scrollTop, scrollHeight, clientHeight } = listRef.value;
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 100;
}

watch(() => props.messages.length, scrollToBottom);
watch(() => props.messages[props.messages.length - 1]?.content, scrollToBottom);
watch(() => props.messages[props.messages.length - 1]?.thinking, scrollToBottom);
watch(() => props.messages[props.messages.length - 1]?.toolCalls?.length, scrollToBottom);
</script>

<template>
  <div
    ref="listRef"
    @scroll="handleScroll"
    class="flex-1 overflow-y-auto px-4"
  >
    <div class="max-w-3xl mx-auto">
      <div v-if="messages.length === 0" class="flex items-center justify-center h-full min-h-[400px]">
        <div class="text-center text-muted-foreground">
          <h2 class="text-2xl font-bold mb-2">AI Mock</h2>
          <p>描述你想生成的 Mock API 模块</p>
        </div>
      </div>

      <MessageBubble
        v-for="(msg, index) in messages"
        :key="index"
        :role="msg.role === 'user' ? 'user' : 'assistant'"
        :content="msg.content"
        :thinking="msg.thinking"
        :thinking-complete="msg.thinkingComplete"
        :tool-calls="msg.toolCalls"
        :modules="msg.modules"
        :message-error="msg.messageError"
        :stream-done="msg.streamDone"
        :aborted="msg.aborted"
        :abort-reason="msg.abortReason"
        :retry-user-content="userContentBefore(index)"
        :started-at="msg.startedAt"
        :finished-at="msg.finishedAt"
        @retry="emit('retry', $event)"
      />
    </div>
  </div>
</template>
