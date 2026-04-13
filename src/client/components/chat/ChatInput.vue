<script setup lang="ts">
import { ref, watch } from 'vue';
import { Send, Square } from 'lucide-vue-next';
import { Button } from '../ui/button';

const props = defineProps<{
  loading?: boolean;
}>();

const emit = defineEmits<{
  send: [message: string];
  stop: [];
}>();

const input = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);

function adjustHeight() {
  if (textarea.value) {
    textarea.value.style.height = 'auto';
    textarea.value.style.height = Math.min(textarea.value.scrollHeight, 200) + 'px';
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

function handleSend() {
  const message = input.value.trim();
  if (!message || props.loading) return;
  emit('send', message);
  input.value = '';
  if (textarea.value) {
    textarea.value.style.height = 'auto';
  }
}
</script>

<template>
  <div class="border-t border-border p-4 bg-background">
    <div class="flex gap-2 items-end max-w-3xl mx-auto">
      <textarea
        ref="textarea"
        v-model="input"
        @input="adjustHeight"
        @keydown="handleKeydown"
        :placeholder="loading ? 'AI is generating...' : 'Send a message... (Shift+Enter for new line)'"
        :disabled="loading"
        rows="1"
        class="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 max-h-[200px]"
      />
      <Button
        v-if="loading"
        size="icon"
        variant="outline"
        @click="$emit('stop')"
        title="Stop generating"
      >
        <Square class="w-4 h-4" />
      </Button>
      <Button
        v-else
        size="icon"
        :disabled="!input.trim()"
        @click="handleSend"
        title="Send message"
      >
        <Send class="w-4 h-4" />
      </Button>
    </div>
  </div>
</template>
