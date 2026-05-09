<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useApi } from '../composables/use-api';
import { toast } from '../composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';
import { useAuthStore } from '../stores/auth';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Shield, Plus, Trash2 } from 'lucide-vue-next';
import { usePageHeader } from '@/composables/use-page-header';

usePageHeader({ title: '管理面板', description: '用户与权限管理' });

const api = useApi();
const authStore = useAuthStore();
const { confirm } = useConfirm();
const users = ref<any[]>([]);

/** 系统超级管理员 = id=1(seed 创建,后端不允许降级/禁用/删除) */
function isProtected(u: any): boolean {
  return u?.id === 1;
}

const currentUserId = computed(() => authStore.user?.id);

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

async function deleteUser(user: any) {
  const ok = await confirm({
    title: `删除用户 ${user.username}?`,
    description: '不可恢复',
    variant: 'destructive',
    confirmText: '删除',
  });
  if (!ok) return;
  try {
    await api.del(`/api/users/${user.id}`);
    toast.success('用户已删除');
    await fetchUsers();
  } catch { /* handled by useApi */ }
}

// ==== 新增用户 dialog ====
const showCreate = ref(false);
const createForm = ref({ username: '', password: '', displayName: '', role: 'user' as 'user' | 'admin' });

function openCreate() {
  createForm.value = { username: '', password: '', displayName: '', role: 'user' };
  showCreate.value = true;
}

async function submitCreate() {
  if (!createForm.value.username || !createForm.value.password) {
    toast.error('用户名与密码必填');
    return;
  }
  if (createForm.value.password.length < 6) {
    toast.error('密码至少 6 位');
    return;
  }
  try {
    await api.post('/api/users', createForm.value);
    toast.success('用户已创建');
    showCreate.value = false;
    await fetchUsers();
  } catch { /* handled by useApi */ }
}

onMounted(fetchUsers);
</script>

<template>
  <div class="max-w-4xl mx-auto p-6">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold flex items-center gap-2">
        <Shield class="w-5 h-5" />
        用户管理
      </h2>
      <Button size="sm" @click="openCreate" data-testid="admin-new-user-btn">
        <Plus class="w-4 h-4 mr-1" /> 新增用户
      </Button>
    </div>

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
          <tr
            v-for="u in users"
            :key="u.id"
            class="border-t border-border"
            :data-testid="`user-row-${u.id}`"
          >
            <td class="px-4 py-2">{{ u.id }}</td>
            <td class="px-4 py-2">
              {{ u.username }}
              <span v-if="isProtected(u)" class="text-xs text-yellow-600 ml-1" title="系统管理员,不能修改">🔒</span>
              <span v-else-if="u.id === currentUserId" class="text-xs text-muted-foreground ml-1">(自己)</span>
            </td>
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
              <Button
                size="sm"
                variant="outline"
                @click="toggleRole(u)"
                :disabled="isProtected(u)"
                :title="isProtected(u) ? '系统管理员不可降级' : ''"
              >
                {{ u.role === 'admin' ? '降级' : '升级' }}
              </Button>
              <Button
                size="sm"
                variant="outline"
                @click="toggleActive(u)"
                :disabled="isProtected(u)"
                :title="isProtected(u) ? '系统管理员不可禁用' : ''"
              >
                {{ u.isActive ? '禁用' : '启用' }}
              </Button>
              <Button
                size="sm"
                variant="outline"
                class="text-destructive"
                @click="deleteUser(u)"
                :disabled="isProtected(u) || u.id === currentUserId"
                :title="isProtected(u) ? '系统管理员不可删除' : (u.id === currentUserId ? '不能删除自己' : '删除')"
                :data-testid="`user-delete-${u.id}`"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新增用户 dialog -->
    <div
      v-if="showCreate"
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      @click.self="showCreate = false"
      data-testid="admin-new-user-dialog"
    >
      <div class="bg-background border border-border rounded-lg p-6 w-full max-w-md space-y-4">
        <h3 class="text-lg font-semibold">新增用户</h3>
        <div>
          <label class="text-sm font-medium">用户名 *</label>
          <Input v-model="createForm.username" placeholder="登录名" class="mt-1" data-testid="admin-new-username" />
        </div>
        <div>
          <label class="text-sm font-medium">密码 *</label>
          <Input v-model="createForm.password" type="password" placeholder="至少 6 位" class="mt-1" data-testid="admin-new-password" />
        </div>
        <div>
          <label class="text-sm font-medium">显示名(可选)</label>
          <Input v-model="createForm.displayName" placeholder="不填默认用用户名" class="mt-1" />
        </div>
        <div>
          <label class="text-sm font-medium">角色</label>
          <select v-model="createForm.role" class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="outline" @click="showCreate = false">取消</Button>
          <Button @click="submitCreate" data-testid="admin-new-submit">创建</Button>
        </div>
      </div>
    </div>
  </div>
</template>
