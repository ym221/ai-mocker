import { useAuthStore } from '../stores/auth';
import { toast } from 'vue-sonner';
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

    // Don't set Content-Type for FormData
    if (!(options.body instanceof FormData)) {
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

    const data = await response.json();

    if (!response.ok) {
      const message = data?.message || 'Request failed';
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
