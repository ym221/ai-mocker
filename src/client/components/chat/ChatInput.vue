<script setup lang="ts">
import { ref } from 'vue';
import { Send, Square, Paperclip, X } from 'lucide-vue-next';
import { Button } from '../ui/button';
import { toast } from '../../composables/use-toast';

const props = defineProps<{
  loading?: boolean;
}>();

const emit = defineEmits<{
  send: [message: string];
  stop: [];
}>();

const input = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const attachments = ref<{ name: string; type: string; preview?: string; content?: string }[]>([]);

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
  let message = input.value.trim();
  if (!message && attachments.value.length === 0) return;
  if (props.loading) return;

  // Prepend attachment content to message
  if (attachments.value.length > 0) {
    const attachText = attachments.value
      .filter(a => a.content)
      .map(a => `[Attached: ${a.name}]\n${a.content}`)
      .join('\n\n');
    if (attachText) {
      message = attachText + '\n\n' + message;
    }
    attachments.value = [];
  }

  emit('send', message);
  input.value = '';
  if (textarea.value) {
    textarea.value.style.height = 'auto';
  }
}

async function handleFileSelect(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files) return;

  for (const file of Array.from(files)) {
    if (file.size > 10 * 1024 * 1024) {
      toast.error(`文件 ${file.name} 超过 10MB 限制`);
      continue;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const token = localStorage.getItem('mockforge_token');
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        attachments.value.push({
          name: data.data.filename,
          type: data.data.type,
          preview: data.data.preview,
          content: data.data.content,
        });
      } else {
        toast.error(data.message || '上传失败');
      }
    } catch {
      toast.error('上传失败');
    }
  }

  // Reset file input
  if (fileInput.value) fileInput.value.value = '';
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1);
}

function handleDrop(e: DragEvent) {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (files?.length) {
    const input = fileInput.value;
    if (input) {
      const dt = new DataTransfer();
      for (const f of Array.from(files)) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    }
  }
}

function handleDragOver(e: DragEvent) {
  e.preventDefault();
}
</script>

<template>
  <div class="border-t border-border p-4 bg-background" @drop="handleDrop" @dragover="handleDragOver">
    <!-- Attachment previews -->
    <div v-if="attachments.length > 0" class="flex gap-2 mb-2 max-w-3xl mx-auto flex-wrap">
      <div
        v-for="(att, i) in attachments"
        :key="i"
        class="flex items-center gap-1.5 bg-muted rounded-md px-2 py-1 text-xs"
      >
        <img v-if="att.preview" :src="att.preview" class="w-8 h-8 rounded object-cover" />
        <span class="truncate max-w-[120px]">{{ att.name }}</span>
        <button @click="removeAttachment(i)" class="text-muted-foreground hover:text-foreground">
          <X class="w-3 h-3" />
        </button>
      </div>
    </div>

    <div class="flex gap-2 items-end max-w-3xl mx-auto">
      <!-- File upload -->
      <input
        ref="fileInput"
        type="file"
        multiple
        accept="image/*,.pdf,.docx,.doc,.txt,.md,.json,.yaml,.yml,.csv,.xlsx"
        class="hidden"
        @change="handleFileSelect"
      />
      <button
        @click="fileInput?.click()"
        class="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
        title="添加附件"
      >
        <Paperclip class="w-5 h-5" />
      </button>

      <textarea
        ref="textarea"
        v-model="input"
        @input="adjustHeight"
        @keydown="handleKeydown"
        :placeholder="loading ? 'AI 正在生成...' : '输入消息...（Shift+Enter 换行）'"
        :disabled="loading"
        rows="1"
        class="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 max-h-[200px]"
      />
      <Button
        v-if="loading"
        size="icon"
        variant="outline"
        @click="$emit('stop')"
        title="停止生成"
        data-testid="chat-stop"
      >
        <Square class="w-4 h-4" />
      </Button>
      <Button
        v-else
        size="icon"
        :disabled="!input.trim() && attachments.length === 0"
        @click="handleSend"
        title="发送消息"
      >
        <Send class="w-4 h-4" />
      </Button>
    </div>
  </div>
</template>
