<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useProviderStore } from '../stores/provider';
import { usePresetStore } from '../stores/preset';
import { useAuthStore } from '../stores/auth';
import { useApi } from '../composables/use-api';
import { toast } from '../composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Plus, Pencil, Trash2, Check, X, Copy, RefreshCw, Key } from 'lucide-vue-next';
import { usePageHeader } from '@/composables/use-page-header';

usePageHeader({ title: '设置', description: 'AI 服务商与项目预设管理' });

const providerStore = useProviderStore();
const presetStore = usePresetStore();
const authStore = useAuthStore();
const api = useApi();
const { confirm } = useConfirm();

const activeTab = ref<'providers' | 'presets' | 'api-keys'>('providers');

// ===== API Key (MCP) =====
interface ApiKeyStatus { hasKey: boolean; createdAt: string | null; lastUsedAt: string | null }
const apiKeyStatus = ref<ApiKeyStatus>({ hasKey: false, createdAt: null, lastUsedAt: null });
const apiKeyLoading = ref(false);
const newApiKey = ref<string | null>(null);
const showNewKeyDialog = ref(false);

async function loadApiKeyStatus() {
  try {
    const res = await api.get<{ data: ApiKeyStatus }>('/api/users/me/api-key');
    apiKeyStatus.value = res.data;
  } catch { /* toast handled */ }
}

async function generateApiKey() {
  if (apiKeyStatus.value.hasKey) {
    const ok = await confirm({
      title: '重新生成 API Key？',
      description: '旧 Key 会立即失效，所有使用它的 IDE / 工具都需要更新配置。',
      variant: 'destructive',
      confirmText: '重新生成',
    });
    if (!ok) return;
  }
  apiKeyLoading.value = true;
  try {
    const res = await api.post<{ data: { apiKey: string; createdAt: string } }>('/api/users/me/api-key');
    newApiKey.value = res.data.apiKey;
    showNewKeyDialog.value = true;
    await loadApiKeyStatus();
  } catch { /* */ } finally {
    apiKeyLoading.value = false;
  }
}

async function revokeApiKey() {
  const ok = await confirm({
    title: '吊销 API Key？',
    description: '吊销后将无法通过 MCP 访问 MockForge，需要重新生成。',
    variant: 'destructive',
    confirmText: '吊销',
  });
  if (!ok) return;
  try {
    await api.del('/api/users/me/api-key');
    toast.success('API Key 已吊销');
    await loadApiKeyStatus();
  } catch { /* */ }
}

async function copyApiKey() {
  if (!newApiKey.value) return;
  try {
    await navigator.clipboard.writeText(newApiKey.value);
    toast.success('已复制到剪贴板');
  } catch {
    toast.error('复制失败，请手动选中文本');
  }
}

function mcpConfigSnippet(apiKey: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  return JSON.stringify({
    mcpServers: {
      mockforge: {
        url: `${origin}/mcp`,
        headers: { 'X-API-Key': apiKey },
      },
    },
  }, null, 2);
}

async function copyMcpConfig() {
  const key = newApiKey.value || '<your-api-key>';
  try {
    await navigator.clipboard.writeText(mcpConfigSnippet(key));
    toast.success('配置片段已复制');
  } catch {
    toast.error('复制失败');
  }
}

// Provider form
const showProviderForm = ref(false);
const editingProviderId = ref<number | null>(null);
const providerForm = ref({
  name: '',
  type: 'openai',
  apiKey: '',
  baseUrl: '',
  defaultModel: '',
  scope: 'private',
});

function openProviderForm(provider?: any) {
  if (provider) {
    editingProviderId.value = provider.id;
    providerForm.value = {
      name: provider.name,
      type: provider.type,
      apiKey: '',
      baseUrl: provider.baseUrl || '',
      defaultModel: provider.defaultModel,
      scope: provider.scope,
    };
  } else {
    editingProviderId.value = null;
    providerForm.value = { name: '', type: 'openai', apiKey: '', baseUrl: '', defaultModel: '', scope: 'private' };
  }
  showProviderForm.value = true;
}

async function saveProvider() {
  if (!providerForm.value.name || !providerForm.value.defaultModel) {
    toast.error('名称和模型为必填项');
    return;
  }
  try {
    const data: Record<string, unknown> = { ...providerForm.value };
    if (!data.apiKey) delete data.apiKey;

    if (editingProviderId.value) {
      await providerStore.updateProvider(editingProviderId.value, data);
      toast.success('服务商已更新');
    } else {
      await providerStore.createProvider(data);
      toast.success('服务商已保存');
    }
    showProviderForm.value = false;
  } catch { /* toast handled by useApi */ }
}

async function deleteProvider(id: number) {
  const ok = await confirm({ title: '确定删除此 Provider？', description: '删除后不可恢复', variant: 'destructive', confirmText: '删除' });
  if (!ok) return;
  try {
    await providerStore.deleteProvider(id);
    toast.success('服务商已删除');
  } catch { /* toast handled by useApi */ }
}

// Preset form
const showPresetForm = ref(false);
const editingPresetId = ref<number | null>(null);
const presetForm = ref({
  name: '',
  description: '',
  content: '{}',
  scope: 'private',
});

function openPresetForm(preset?: any) {
  if (preset) {
    editingPresetId.value = preset.id;
    presetForm.value = {
      name: preset.name,
      description: preset.description || '',
      content: preset.content,
      scope: preset.scope,
    };
  } else {
    editingPresetId.value = null;
    presetForm.value = { name: '', description: '', content: '{}', scope: 'private' };
  }
  showPresetForm.value = true;
}

async function savePreset() {
  if (!presetForm.value.name) {
    toast.error('名称为必填项');
    return;
  }
  try {
    if (editingPresetId.value) {
      await presetStore.updatePreset(editingPresetId.value, presetForm.value);
      toast.success('预设已更新');
    } else {
      await presetStore.createPreset(presetForm.value);
      toast.success('预设已保存');
    }
    showPresetForm.value = false;
  } catch { /* toast handled by useApi */ }
}

async function deletePreset(id: number) {
  const ok = await confirm({ title: '确定删除此预设？', description: '删除后不可恢复', variant: 'destructive', confirmText: '删除' });
  if (!ok) return;
  try {
    await presetStore.deletePreset(id);
    toast.success('预设已删除');
  } catch { /* toast handled by useApi */ }
}

onMounted(() => {
  providerStore.fetchProviders();
  presetStore.fetchPresets();
  loadApiKeyStatus();
});
</script>

<template>
  <div class="max-w-4xl mx-auto p-6">
    <!-- Tabs -->
    <div class="flex border-b border-border mb-6">
      <button
        @click="activeTab = 'providers'"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'providers' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
      >
        AI 服务商
      </button>
      <button
        @click="activeTab = 'presets'"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'presets' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
      >
        项目预设
      </button>
      <button
        @click="activeTab = 'api-keys'"
        data-testid="tab-api-keys"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'api-keys' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
      >
        API Keys
      </button>
    </div>

    <!-- Providers Tab -->
    <div v-if="activeTab === 'providers'">
      <div class="flex justify-between items-center mb-4">
        <p class="text-sm text-muted-foreground">配置用于生成 Mock API 的 AI 服务商</p>
        <Button size="sm" @click="openProviderForm()">
          <Plus class="w-4 h-4 mr-1" /> 添加服务商
        </Button>
      </div>

      <!-- Provider list -->
      <div class="space-y-3">
        <div
          v-for="p in providerStore.providers"
          :key="p.id"
          class="border border-border rounded-lg p-4 flex items-center justify-between"
        >
          <div>
            <div class="font-medium">{{ p.name }}</div>
            <div class="text-sm text-muted-foreground">
              {{ p.type }} | {{ p.defaultModel }} | {{ p.scope }}
              <span v-if="p.baseUrl" class="ml-1">| {{ p.baseUrl }}</span>
            </div>
          </div>
          <div class="flex gap-2">
            <button @click="openProviderForm(p)" class="p-1.5 rounded hover:bg-accent">
              <Pencil class="w-4 h-4" />
            </button>
            <button @click="deleteProvider(p.id)" class="p-1.5 rounded hover:bg-destructive/10 text-destructive">
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
        </div>
        <div v-if="providerStore.providers.length === 0" class="text-center py-8 text-muted-foreground">
          暂未配置服务商
        </div>
      </div>

      <!-- Provider form dialog -->
      <div v-if="showProviderForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showProviderForm = false">
        <div class="bg-background border border-border rounded-lg p-6 w-full max-w-md space-y-4">
          <h3 class="text-lg font-semibold">{{ editingProviderId ? '编辑服务商' : '添加服务商' }}</h3>
          <div>
            <label class="text-sm font-medium">名称</label>
            <Input v-model="providerForm.name" placeholder="我的 OpenAI 服务商" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">类型</label>
            <select v-model="providerForm.type" class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
              <option value="openai-compatible">OpenAI 兼容</option>
              <option value="custom">自定义</option>
            </select>
          </div>
          <div>
            <label class="text-sm font-medium">接口地址（选填）</label>
            <Input v-model="providerForm.baseUrl" placeholder="https://api.openai.com/v1" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">API 密钥</label>
            <Input v-model="providerForm.apiKey" type="password" :placeholder="editingProviderId ? '留空保持不变' : '请输入 API 密钥'" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">默认模型</label>
            <Input v-model="providerForm.defaultModel" placeholder="gpt-4o-mini" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">可见范围</label>
            <select v-model="providerForm.scope" class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="private">私有</option>
              <option value="public">公开</option>
            </select>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="outline" @click="showProviderForm = false">取消</Button>
            <Button @click="saveProvider">保存</Button>
          </div>
        </div>
      </div>
    </div>

    <!-- Presets Tab -->
    <div v-if="activeTab === 'presets'">
      <div class="flex justify-between items-center mb-4">
        <p class="text-sm text-muted-foreground">定义项目预设，统一 API 生成规范</p>
        <Button size="sm" @click="openPresetForm()">
          <Plus class="w-4 h-4 mr-1" /> 添加预设
        </Button>
      </div>

      <div class="space-y-3">
        <div
          v-for="p in presetStore.presets"
          :key="p.id"
          class="border border-border rounded-lg p-4 flex items-center justify-between"
        >
          <div>
            <div class="font-medium">{{ p.name }}</div>
            <div class="text-sm text-muted-foreground">{{ p.description || '暂无描述' }} | {{ p.scope }}</div>
          </div>
          <div class="flex gap-2">
            <button @click="openPresetForm(p)" class="p-1.5 rounded hover:bg-accent">
              <Pencil class="w-4 h-4" />
            </button>
            <button @click="deletePreset(p.id)" class="p-1.5 rounded hover:bg-destructive/10 text-destructive">
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
        </div>
        <div v-if="presetStore.presets.length === 0" class="text-center py-8 text-muted-foreground">
          暂未配置预设
        </div>
      </div>

      <!-- Preset form dialog -->
      <div v-if="showPresetForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showPresetForm = false">
        <div class="bg-background border border-border rounded-lg p-6 w-full max-w-md space-y-4">
          <h3 class="text-lg font-semibold">{{ editingPresetId ? '编辑预设' : '添加预设' }}</h3>
          <div>
            <label class="text-sm font-medium">名称</label>
            <Input v-model="presetForm.name" placeholder="企业 API 规范" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">描述</label>
            <textarea v-model="presetForm.description" placeholder="预设描述" class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px]" />
          </div>
          <div>
            <label class="text-sm font-medium">配置（JSON）</label>
            <textarea v-model="presetForm.content" placeholder='{"responseFormat":{}, "fieldNaming":"camelCase"}' class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[100px]" />
          </div>
          <div>
            <label class="text-sm font-medium">可见范围</label>
            <select v-model="presetForm.scope" class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="private">私有</option>
              <option value="public">公开</option>
            </select>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="outline" @click="showPresetForm = false">取消</Button>
            <Button @click="savePreset">保存</Button>
          </div>
        </div>
      </div>
    </div>

    <!-- API Keys Tab -->
    <div v-if="activeTab === 'api-keys'" data-testid="tab-panel-api-keys">
      <p class="text-sm text-muted-foreground mb-4">
        API Key 用于 IDE（Cursor / Claude Code 等）通过 MCP 协议访问本 MockForge 实例。
      </p>

      <!-- 未生成态 -->
      <div
        v-if="!apiKeyStatus.hasKey"
        class="border border-dashed border-border rounded-lg p-8 text-center space-y-4"
      >
        <Key class="w-10 h-10 text-muted-foreground mx-auto" />
        <div class="text-sm text-muted-foreground">你还没有 API Key</div>
        <Button :disabled="apiKeyLoading" @click="generateApiKey" data-testid="generate-api-key-btn">
          <Plus class="w-4 h-4 mr-1" /> 生成 API Key
        </Button>
      </div>

      <!-- 已有态 -->
      <div v-else class="space-y-4">
        <div class="border border-border rounded-lg p-4 space-y-3">
          <div class="flex items-center gap-2">
            <Check class="w-4 h-4 text-green-600" />
            <span class="font-medium">已有 API Key</span>
          </div>
          <div class="text-sm text-muted-foreground space-y-1">
            <div>创建时间：{{ apiKeyStatus.createdAt || '—' }}</div>
            <div>上次使用：{{ apiKeyStatus.lastUsedAt || '尚未使用' }}</div>
          </div>
          <div class="flex gap-2 pt-2">
            <Button size="sm" variant="outline" :disabled="apiKeyLoading" @click="generateApiKey" data-testid="regenerate-api-key-btn">
              <RefreshCw class="w-3.5 h-3.5 mr-1.5" /> 重新生成
            </Button>
            <Button size="sm" variant="outline" class="text-destructive hover:text-destructive" :disabled="apiKeyLoading" @click="revokeApiKey" data-testid="revoke-api-key-btn">
              <Trash2 class="w-3.5 h-3.5 mr-1.5" /> 吊销
            </Button>
          </div>
        </div>

        <div class="border border-amber-200 bg-amber-50 text-amber-900 rounded-lg p-3 text-xs">
          ⚠ API Key 等同账户密码。泄漏后他人可操作你的全部 Mock 模块。请妥善保管；若疑似泄漏，立即「重新生成」。
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">IDE 配置片段</span>
            <Button size="sm" variant="ghost" @click="copyMcpConfig">
              <Copy class="w-3.5 h-3.5 mr-1.5" /> 复制
            </Button>
          </div>
          <pre class="bg-muted rounded-md p-3 text-xs overflow-x-auto font-mono">{{ mcpConfigSnippet('&lt;your-api-key&gt;') }}</pre>
          <p class="text-xs text-muted-foreground">
            把上面片段加到 Cursor / Claude Code 的 <code>mcp.json</code>，替换 <code>&lt;your-api-key&gt;</code> 为你实际的 Key。
          </p>
        </div>
      </div>
    </div>

    <!-- 新 Key 展示 Dialog（生成后只展示一次） -->
    <div
      v-if="showNewKeyDialog"
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      data-testid="new-api-key-dialog"
    >
      <div class="bg-background border border-border rounded-lg p-6 w-full max-w-lg space-y-4">
        <h3 class="text-lg font-semibold">你的新 API Key</h3>
        <p class="text-xs text-muted-foreground">
          ⚠ 此 Key 仅展示这一次，请立即复制保存。离开此弹窗后将无法再次查看。
        </p>
        <div class="flex items-stretch gap-2">
          <code class="flex-1 bg-muted rounded-md p-3 text-sm font-mono break-all" data-testid="new-api-key-value">{{ newApiKey }}</code>
          <Button variant="outline" @click="copyApiKey" data-testid="copy-api-key-btn">
            <Copy class="w-4 h-4 mr-1" /> 复制
          </Button>
        </div>
        <div class="space-y-2">
          <div class="text-sm font-medium">IDE 配置片段（已含此 Key）</div>
          <pre class="bg-muted rounded-md p-3 text-xs overflow-x-auto font-mono">{{ mcpConfigSnippet(newApiKey || '') }}</pre>
        </div>
        <div class="flex justify-end pt-2">
          <Button @click="() => { showNewKeyDialog = false; newApiKey = null; }" data-testid="close-new-api-key-dialog-btn">
            我已保存，关闭
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
