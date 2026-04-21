<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { toast } from '../composables/use-toast';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

const router = useRouter();
const authStore = useAuthStore();

const isLogin = ref(true);
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const loading = ref(false);

async function handleSubmit() {
  if (!username.value || !password.value) {
    toast.error('请填写所有字段');
    return;
  }

  if (!isLogin.value) {
    if (username.value.length < 3 || username.value.length > 20) {
      toast.error('用户名需 3-20 个字符');
      return;
    }
    if (password.value.length < 6) {
      toast.error('密码至少 6 个字符');
      return;
    }
    if (password.value !== confirmPassword.value) {
      toast.error('两次密码不一致');
      return;
    }
  }

  loading.value = true;
  try {
    if (isLogin.value) {
      await authStore.login(username.value, password.value);
      toast.success('登录成功');
    } else {
      await authStore.register(username.value, password.value);
      toast.success('注册成功');
    }
    router.push('/chat');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : '操作失败');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background px-4">
    <div class="w-full max-w-sm space-y-6">
      <div class="text-center">
        <h1 class="text-3xl font-bold text-foreground">AI Mock</h1>
        <p class="mt-2 text-sm text-muted-foreground">AI 驱动的 Mock API 平台</p>
      </div>

      <!-- Tab switch -->
      <div class="flex border-b border-border">
        <button
          @click="isLogin = true"
          class="flex-1 py-2 text-sm font-medium transition-colors border-b-2"
          :class="isLogin ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        >
          登录
        </button>
        <button
          @click="isLogin = false"
          class="flex-1 py-2 text-sm font-medium transition-colors border-b-2"
          :class="!isLogin ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        >
          注册
        </button>
      </div>

      <form @submit.prevent="handleSubmit" class="space-y-4">
        <div>
          <label class="text-sm font-medium text-foreground">用户名</label>
          <Input
            v-model="username"
            type="text"
            placeholder="请输入用户名"
            class="mt-1"
          />
        </div>

        <div>
          <label class="text-sm font-medium text-foreground">密码</label>
          <Input
            v-model="password"
            type="password"
            placeholder="请输入密码"
            class="mt-1"
          />
        </div>

        <div v-if="!isLogin">
          <label class="text-sm font-medium text-foreground">确认密码</label>
          <Input
            v-model="confirmPassword"
            type="password"
            placeholder="请再次输入密码"
            class="mt-1"
          />
        </div>

        <Button type="submit" class="w-full" :disabled="loading">
          {{ loading ? '处理中...' : (isLogin ? '登录' : '注册') }}
        </Button>
      </form>
    </div>
  </div>
</template>
