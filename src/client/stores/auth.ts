import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { toast } from '../composables/use-toast';

interface User {
  id: number;
  username: string;
  displayName: string | null;
  role: string;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export const useAuthStore = defineStore('auth', () => {
  const currentUser = ref<User | null>(null);
  const token = ref<string | null>(localStorage.getItem('mockforge_token'));

  const isAuthenticated = computed(() => !!token.value && !!currentUser.value);
  const isAdmin = computed(() => currentUser.value?.role === 'admin');

  async function login(username: string, password: string) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data: ApiResponse<{ token: string; user: User }> = await res.json();

    if (!data.success) {
      throw new Error(data.message || 'Login failed');
    }

    token.value = data.data.token;
    currentUser.value = data.data.user;
    localStorage.setItem('mockforge_token', data.data.token);
  }

  async function register(username: string, password: string) {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data: ApiResponse<User> = await res.json();

    if (!data.success) {
      throw new Error(data.message || 'Registration failed');
    }

    // Auto-login after register
    await login(username, password);
  }

  function logout() {
    token.value = null;
    currentUser.value = null;
    localStorage.removeItem('mockforge_token');
  }

  async function checkAuth() {
    if (!token.value) return false;

    try {
      const res = await fetch('/api/health', {
        headers: { 'Authorization': `Bearer ${token.value}` },
      });
      if (!res.ok) {
        logout();
        return false;
      }

      // Decode user from token payload
      const payload = JSON.parse(atob(token.value.split('.')[1]));
      currentUser.value = {
        id: payload.userId,
        username: payload.username,
        displayName: payload.username,
        role: payload.role,
      };
      return true;
    } catch {
      logout();
      return false;
    }
  }

  return {
    currentUser,
    token,
    isAuthenticated,
    isAdmin,
    login,
    register,
    logout,
    checkAuth,
  };
});
