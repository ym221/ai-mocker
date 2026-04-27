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

  // Read JSON with a friendlier error when the server returns empty / non-JSON
  // (typical cause: dev-proxy ECONNREFUSED, gateway HTML error page, browser
  // extension stripping body). The default JSON.parse throws "Unexpected end
  // of JSON input" which is opaque to end users.
  async function readJsonOrThrow<T>(res: Response, action: string): Promise<T> {
    const txt = await res.text();
    if (!txt) {
      throw new Error(
        `${action}失败：服务器返回空响应（HTTP ${res.status}）。请检查后端是否运行 (http://127.0.0.1:3000)`
      );
    }
    try {
      return JSON.parse(txt) as T;
    } catch {
      throw new Error(
        `${action}失败：服务器响应不是合法 JSON（HTTP ${res.status}）。响应前 80 字符：${txt.slice(0, 80)}`
      );
    }
  }

  async function login(username: string, password: string) {
    let res: Response;
    try {
      res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch (err) {
      throw new Error('登录失败：无法连接到服务器，请检查后端是否启动');
    }
    const data = await readJsonOrThrow<ApiResponse<{ token: string; user: User }>>(res, '登录');

    if (!data.success) {
      throw new Error(data.message || '登录失败');
    }

    token.value = data.data.token;
    currentUser.value = data.data.user;
    localStorage.setItem('mockforge_token', data.data.token);
  }

  async function register(username: string, password: string) {
    let res: Response;
    try {
      res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch (err) {
      throw new Error('注册失败：无法连接到服务器，请检查后端是否启动');
    }
    const data = await readJsonOrThrow<ApiResponse<User>>(res, '注册');

    if (!data.success) {
      throw new Error(data.message || '注册失败');
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
