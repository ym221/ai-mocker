import { useAuthStore } from '../stores/auth';
import { toast } from './use-toast';
import { useRouter } from 'vue-router';

export function useApi() {
  const authStore = useAuthStore();

  async function request<T = unknown>(
    url: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> || {}),
    };

    if (authStore.token) {
      headers['Authorization'] = `Bearer ${authStore.token}`;
    }

    // 只在有 body 且不是 FormData 时设置 application/json
    // 否则 Fastify 对 DELETE 等无 body 请求会报 "Body cannot be empty"
    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      authStore.logout();
      toast.error('Session expired, please login again');
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }

    const text = await response.text();
    let data: any = null;
    if (text) {
      try { data = JSON.parse(text); } catch { /* non-JSON response */ }
    }

    if (!response.ok) {
      const message = data?.message || `Request failed (${response.status})`;
      toast.error(message);
      throw new Error(message);
    }

    return data as T;
  }

  function get<T = unknown>(url: string) {
    return request<T>(url);
  }

  function post<T = unknown>(url: string, body?: unknown) {
    return request<T>(url, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  function put<T = unknown>(url: string, body?: unknown) {
    return request<T>(url, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  function del<T = unknown>(url: string) {
    return request<T>(url, { method: 'DELETE' });
  }

  function upload<T = unknown>(url: string, formData: FormData) {
    return request<T>(url, {
      method: 'POST',
      body: formData,
    });
  }

  return { get, post, put, del, upload, request };
}
