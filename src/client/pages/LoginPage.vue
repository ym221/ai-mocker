<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { toast } from 'vue-sonner';
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
    toast.error('Please fill in all fields');
    return;
  }

  if (!isLogin.value) {
    if (username.value.length < 3 || username.value.length > 20) {
      toast.error('Username must be 3-20 characters');
      return;
    }
    if (password.value.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    if (password.value !== confirmPassword.value) {
      toast.error('Passwords do not match');
      return;
    }
  }

  loading.value = true;
  try {
    if (isLogin.value) {
      await authStore.login(username.value, password.value);
      toast.success('Login successful');
    } else {
      await authStore.register(username.value, password.value);
      toast.success('Registration successful');
    }
    router.push('/chat');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Operation failed');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background px-4">
    <div class="w-full max-w-sm space-y-6">
      <div class="text-center">
        <h1 class="text-3xl font-bold text-foreground">MockForge</h1>
        <p class="mt-2 text-sm text-muted-foreground">AI-driven Mock API Platform</p>
      </div>

      <!-- Tab switch -->
      <div class="flex border-b border-border">
        <button
          @click="isLogin = true"
          class="flex-1 py-2 text-sm font-medium transition-colors border-b-2"
          :class="isLogin ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        >
          Login
        </button>
        <button
          @click="isLogin = false"
          class="flex-1 py-2 text-sm font-medium transition-colors border-b-2"
          :class="!isLogin ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        >
          Register
        </button>
      </div>

      <form @submit.prevent="handleSubmit" class="space-y-4">
        <div>
          <label class="text-sm font-medium text-foreground">Username</label>
          <Input
            v-model="username"
            type="text"
            placeholder="Enter username"
            class="mt-1"
          />
        </div>

        <div>
          <label class="text-sm font-medium text-foreground">Password</label>
          <Input
            v-model="password"
            type="password"
            placeholder="Enter password"
            class="mt-1"
          />
        </div>

        <div v-if="!isLogin">
          <label class="text-sm font-medium text-foreground">Confirm Password</label>
          <Input
            v-model="confirmPassword"
            type="password"
            placeholder="Confirm password"
            class="mt-1"
          />
        </div>

        <Button type="submit" class="w-full" :disabled="loading">
          {{ loading ? 'Processing...' : (isLogin ? 'Login' : 'Register') }}
        </Button>
      </form>
    </div>
  </div>
</template>
