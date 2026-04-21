<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useApi } from '../composables/use-api';
import { toast } from '../composables/use-toast';
import { Button } from '../components/ui/button';
import { Shield } from 'lucide-vue-next';
import { usePageHeader } from '@/composables/use-page-header';

usePageHeader({ title: '管理面板', description: '用户与权限管理' });

const api = useApi();
const users = ref<any[]>([]);

async function fetchUsers() {
  try {
    const res = await api.get<{ success: boolean; data: any[] }>('/api/users');
    users.value = res.data;
  } catch { /* handled by useApi */ }
}

async function toggleActive(user: any) {
  try {
    await api.put(`/api/users/${user.id}`, { isActive: user.isActive ? 0 : 1 });
    toast.success(`用户已${user.isActive ? '禁用' : '启用'}`);
    await fetchUsers();
  } catch { /* handled by useApi */ }
}

async function toggleRole(user: any) {
  const newRole = user.role === 'admin' ? 'user' : 'admin';
  try {
    await api.put(`/api/users/${user.id}`, { role: newRole });
    toast.success(`角色已变更为 ${newRole}`);
    await fetchUsers();
  } catch { /* handled by useApi */ }
}

onMounted(fetchUsers);
</script>

<template>
  <div class="max-w-4xl mx-auto p-6">
    <h2 class="text-lg font-semibold mb-4 flex items-center gap-2">
      <Shield class="w-5 h-5" />
      用户管理
    </h2>

    <div class="border border-border rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-muted">
          <tr>
            <th class="px-4 py-2 text-left">ID</th>
            <th class="px-4 py-2 text-left">用户名</th>
            <th class="px-4 py-2 text-left">角色</th>
            <th class="px-4 py-2 text-left">状态</th>
            <th class="px-4 py-2 text-left">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id" class="border-t border-border">
            <td class="px-4 py-2">{{ u.id }}</td>
            <td class="px-4 py-2">{{ u.username }}</td>
            <td class="px-4 py-2">
              <span class="text-xs px-2 py-0.5 rounded-full"
                :class="u.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'">
                {{ u.role }}
              </span>
            </td>
            <td class="px-4 py-2">
              <span class="text-xs px-2 py-0.5 rounded-full"
                :class="u.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'">
                {{ u.isActive ? '正常' : '已禁用' }}
              </span>
            </td>
            <td class="px-4 py-2 space-x-2">
              <Button size="sm" variant="outline" @click="toggleRole(u)">
                {{ u.role === 'admin' ? '降级' : '升级' }}
              </Button>
              <Button size="sm" variant="outline" @click="toggleActive(u)">
                {{ u.isActive ? '禁用' : '启用' }}
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
