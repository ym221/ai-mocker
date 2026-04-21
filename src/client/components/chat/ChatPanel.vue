<script setup lang="ts">
import MessageList from './MessageList.vue';
import ChatInput from './ChatInput.vue';
import type { DisplayMessage } from '../../stores/chat';

defineProps<{
  messages: DisplayMessage[];
  loading?: boolean;
}>();

defineEmits<{
  send: [message: string];
  stop: [];
}>();
</script>

<template>
  <div class="flex flex-col h-full">
    <MessageList :messages="messages" />
    <ChatInput
      :loading="loading"
      @send="$emit('send', $event)"
      @stop="$emit('stop')"
    />
  </div>
</template>
