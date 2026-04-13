<script setup lang="ts">
import { computed } from 'vue';
import { User, Bot } from 'lucide-vue-next';

const props = defineProps<{
  role: 'user' | 'assistant';
  content: string;
}>();

const isUser = computed(() => props.role === 'user');
</script>

<template>
  <div class="flex gap-3 py-4" :class="isUser ? 'flex-row-reverse' : ''">
    <!-- Avatar -->
    <div
      class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
      :class="isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'"
    >
      <User v-if="isUser" class="w-4 h-4" />
      <Bot v-else class="w-4 h-4" />
    </div>

    <!-- Message content -->
    <div
      class="max-w-[80%] rounded-lg px-4 py-2 text-sm"
      :class="isUser
        ? 'bg-primary text-primary-foreground'
        : 'bg-muted text-foreground'"
    >
      <div class="whitespace-pre-wrap break-words" v-html="content || '...'" />
    </div>
  </div>
</template>
