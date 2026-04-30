<script setup lang="ts">
import { computed } from 'vue';
import MessageList from './MessageList.vue';
import ChatInput from './ChatInput.vue';
import SessionMetaBar from './SessionMetaBar.vue';
import { useChatStore, type DisplayMessage } from '../../stores/chat';

defineProps<{
  messages: DisplayMessage[];
  loading?: boolean;
}>();

defineEmits<{
  send: [message: string];
  stop: [];
  retry: [content: string];
}>();

const chatStore = useChatStore();
const activeSession = computed(() => {
  const id = chatStore.activeSessionId;
  return id ? chatStore.sessions.find(s => s.id === id) ?? null : null;
});
</script>

<template>
  <div class="flex flex-col h-full">
    <MessageList :messages="messages" @retry="$emit('retry', $event)" />
    <SessionMetaBar :session="activeSession" />
    <ChatInput
      :loading="loading"
      @send="$emit('send', $event)"
      @stop="$emit('stop')"
    />
  </div>
</template>
