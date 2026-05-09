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
import { Plus, Pencil, Trash2, Check, X, Copy, RefreshCw, Key, Zap, CheckCircle2, XCircle, Star } from 'lucide-vue-next';
import type { TestProviderResult, ProviderModel } from '../stores/provider';
import ModelCombobox from '../components/ai/ModelCombobox.vue';
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

// Provider 连接测试状态(必须在 openProviderForm 之前声明,后者会读 draftTestResult)
const testingDraft = ref(false);
const draftTestResult = ref<TestProviderResult | null>(null);
const testingSavedId = ref<number | null>(null);

function openProviderForm(provider?: any) {
  draftTestResult.value = null; // 清除上次测试结果
  editingProviderModels.value = [];
  newModelName.value = '';
  newModelNote.value = '';
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
    // 加载该 provider 的预置模型清单
    loadEditingModels();
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

async function testDraftProvider() {
  if (!providerForm.value.defaultModel) {
    toast.error('请先填默认模型');
    return;
  }
  // 编辑模式且 apiKey 为空 → 让用户去列表上测已保存的;否则需要 apiKey
  if (!providerForm.value.apiKey) {
    if (editingProviderId.value) {
      toast.message('未填新 API Key,请关闭后在列表行点 ⚡ 测试已保存的配置');
    } else {
      toast.error('请填 API Key');
    }
    return;
  }
  testingDraft.value = true;
  draftTestResult.value = null;
  try {
    const result = await providerStore.testDraft({
      type: providerForm.value.type,
      apiKey: providerForm.value.apiKey,
      baseUrl: providerForm.value.baseUrl || null,
      modelName: providerForm.value.defaultModel,
    });
    draftTestResult.value = result;
    if (result.ok) {
      toast.success(`测试通过 (${result.latencyMs}ms)`);
    } else {
      toast.error(`${result.errorCode || 'UNKNOWN'}: ${result.hint || result.errorMessage || ''}`);
    }
  } catch (e: any) {
    toast.error(e?.message || '测试失败');
  } finally {
    testingDraft.value = false;
  }
}

async function testSavedProvider(id: number) {
  testingSavedId.value = id;
  try {
    const result = await providerStore.testSaved(id);
    if (result.ok) {
      toast.success(`测试通过 (${result.latencyMs}ms)`);
    } else {
      toast.error(`${result.errorCode || 'UNKNOWN'}: ${result.hint || result.errorMessage || ''}`);
    }
  } catch (e: any) {
    toast.error(e?.message || '测试失败');
  } finally {
    testingSavedId.value = null;
  }
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
  providerStore.fetchUserPreferences();
  presetStore.fetchPresets();
  loadApiKeyStatus();
});

// ==== 默认 provider 操作 ====
async function setAsDefaultProvider(id: number) {
  try {
    await providerStore.setDefaultProvider(id);
    toast.success('已设为默认服务商');
  } catch (e: any) {
    toast.error(e?.message || '设置失败');
  }
}

// ==== 预置模型管理(在编辑 provider 表单里) ====
const editingProviderModels = ref<ProviderModel[]>([]);
const newModelName = ref('');
const newModelNote = ref('');
const testingModelId = ref<number | null>(null);

async function loadEditingModels() {
  if (!editingProviderId.value) {
    editingProviderModels.value = [];
    return;
  }
  try {
    editingProviderModels.value = await providerStore.fetchProviderModels(editingProviderId.value);
  } catch { /* toast in store */ }
}

async function addNewModel() {
  if (!editingProviderId.value || !newModelName.value.trim()) {
    toast.error('请填模型名');
    return;
  }
  try {
    await providerStore.addModel(editingProviderId.value, newModelName.value.trim(), newModelNote.value.trim() || undefined);
    newModelName.value = '';
    newModelNote.value = '';
    await loadEditingModels();
    toast.success('已添加');
  } catch (e: any) {
    toast.error(e?.message || '添加失败');
  }
}

async function updateModelNote(model: ProviderModel, newNote: string) {
  if (!editingProviderId.value) return;
  if ((newNote || '') === (model.note || '')) return;
  try {
    await providerStore.updateModel(editingProviderId.value, model.id, { note: newNote || null });
    await loadEditingModels();
  } catch (e: any) {
    toast.error(e?.message || '更新失败');
  }
}

async function removeModel(model: ProviderModel) {
  if (!editingProviderId.value) return;
  const ok = await confirm({
    title: `删除模型 ${model.modelName}?`,
    description: model.isDefault ? '这是默认模型,删除后会自动选剩余的第一个(优先已验证的)' : '',
    variant: 'destructive',
    confirmText: '删除',
  });
  if (!ok) return;
  try {
    await providerStore.deleteModel(editingProviderId.value, model.id);
    await Promise.all([loadEditingModels(), providerStore.fetchProviders()]);
  } catch (e: any) {
    toast.error(e?.message || '删除失败');
  }
}

async function testModelConn(model: ProviderModel) {
  if (!editingProviderId.value) return;
  testingModelId.value = model.id;
  try {
    const r = await providerStore.testModel(editingProviderId.value, model.id);
    if (r.ok) toast.success(`${model.modelName} 测试通过 (${r.latencyMs}ms)`);
    else toast.error(`${model.modelName}: ${r.errorCode || 'FAILED'} — ${r.hint || r.errorMessage || ''}`);
    await loadEditingModels();
  } catch (e: any) {
    toast.error(e?.message || '测试失败');
  } finally {
    testingModelId.value = null;
  }
}

async function setModelDefault(model: ProviderModel) {
  if (!editingProviderId.value) return;
  try {
    await providerStore.setProviderDefaultModel(editingProviderId.value, model.id);
    providerForm.value.defaultModel = model.modelName;
    await loadEditingModels();
    toast.success(`已将 ${model.modelName} 设为该服务商默认`);
  } catch (e: any) {
    toast.error(e?.message || '设置失败');
  }
}
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
          :data-testid="`provider-row-${p.id}`"
        >
          <div class="min-w-0 flex-1">
            <div class="font-medium flex items-center gap-2 flex-wrap">
              <span>{{ p.name }}</span>
              <!-- 默认 provider 标识 -->
              <span
                v-if="providerStore.userPreferences.defaultProviderId === p.id"
                class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700 border border-yellow-200"
                :data-testid="`provider-default-badge-${p.id}`"
              >
                <Star class="w-3 h-3" /> 默认
              </span>
              <!-- 验证状态 badge -->
              <span
                v-if="p.isVerified === 1"
                class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200"
                :title="p.lastVerifiedAt ? `上次验证 ${p.lastVerifiedAt}` : ''"
                :data-testid="`provider-badge-${p.id}`"
              >
                <CheckCircle2 class="w-3 h-3" /> 已验证
              </span>
              <span
                v-else-if="p.lastVerifiedAt"
                class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200"
                :title="p.lastVerifiedError || ''"
                :data-testid="`provider-badge-${p.id}`"
              >
                <XCircle class="w-3 h-3" /> 验证失败
              </span>
              <span
                v-else
                class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200"
                :data-testid="`provider-badge-${p.id}`"
              >
                未验证
              </span>
            </div>
            <div class="text-sm text-muted-foreground">
              {{ p.type }} | {{ p.defaultModel }} | {{ p.scope }}
              <span v-if="p.baseUrl" class="ml-1">| {{ p.baseUrl }}</span>
            </div>
            <div
              v-if="p.lastVerifiedError && p.isVerified !== 1"
              class="text-xs text-red-500 mt-1 truncate max-w-md"
              :title="p.lastVerifiedError"
            >
              {{ p.lastVerifiedError }}
            </div>
          </div>
          <div class="flex gap-2 shrink-0">
            <!-- 注:编辑按钮放第一位,旧测试用 .first() 选编辑按钮,顺序变更会破坏回归 -->
            <button @click="openProviderForm(p)" class="p-1.5 rounded hover:bg-accent" :title="'编辑'">
              <Pencil class="w-4 h-4" />
            </button>
            <button
              @click="testSavedProvider(p.id)"
              :disabled="testingSavedId === p.id"
              class="p-1.5 rounded hover:bg-accent disabled:opacity-50"
              :title="'测试连接'"
              :data-testid="`provider-test-${p.id}`"
            >
              <Zap class="w-4 h-4" :class="testingSavedId === p.id ? 'animate-pulse' : ''" />
            </button>
            <button
              v-if="providerStore.userPreferences.defaultProviderId !== p.id"
              @click="setAsDefaultProvider(p.id)"
              class="p-1.5 rounded hover:bg-yellow-50 text-yellow-600"
              :title="'设为默认服务商'"
              :data-testid="`provider-set-default-${p.id}`"
            >
              <Star class="w-4 h-4" />
            </button>
            <button @click="deleteProvider(p.id)" class="p-1.5 rounded hover:bg-destructive/10 text-destructive" :title="'删除'">
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
        </div>
        <div v-if="providerStore.providers.length === 0" class="text-center py-8 text-muted-foreground">
          暂未配置服务商
        </div>
      </div>

      <!-- Provider form dialog -->
      <div v-if="showProviderForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" @click.self="showProviderForm = false">
        <div class="bg-background border border-border rounded-lg p-6 w-full max-w-md space-y-4 max-h-[90vh] overflow-y-auto">
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
            <ModelCombobox
              v-model="providerForm.defaultModel"
              :suggestions="editingProviderModels"
              placeholder="如 gpt-4o-mini / deepseek-chat / claude-sonnet-4-5-20250929"
              testid="provider-form-default-model"
              class="mt-1"
            />
          </div>
          <div>
            <label class="text-sm font-medium">可见范围</label>
            <select v-model="providerForm.scope" class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="private">私有</option>
              <option value="public">公开</option>
            </select>
          </div>

          <!-- 预置模型管理面板(仅编辑模式) -->
          <div v-if="editingProviderId" class="border-t pt-4 space-y-3" data-testid="provider-models-panel">
            <div class="flex items-center justify-between">
              <label class="text-sm font-medium">预置模型清单</label>
              <span class="text-xs text-muted-foreground">{{ editingProviderModels.length }} 个</span>
            </div>
            <div v-if="editingProviderModels.length === 0" class="text-xs text-muted-foreground py-2">
              暂无预置模型 — 第一个保存的模型会自动成为默认
            </div>
            <div
              v-for="m in editingProviderModels"
              :key="m.id"
              class="border border-border rounded p-2 space-y-1"
              :data-testid="`provider-model-row-${m.id}`"
            >
              <div class="flex items-center gap-2">
                <span
                  v-if="m.isVerified === 1"
                  class="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200"
                  title="测试已通过"
                >✅</span>
                <span
                  v-else-if="m.lastVerifiedAt"
                  class="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200"
                  :title="m.lastVerifiedError || '上次测试失败'"
                >❌</span>
                <span
                  v-else
                  class="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200"
                  title="未测试"
                >⚪</span>
                <span class="text-sm font-mono flex-1 truncate" :title="m.modelName">{{ m.modelName }}</span>
                <span
                  v-if="m.isDefault"
                  class="text-xs px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700 border border-yellow-200"
                >默认</span>
                <button
                  @click="testModelConn(m)"
                  :disabled="testingModelId === m.id"
                  class="p-1 rounded hover:bg-accent disabled:opacity-50"
                  :title="'测试'"
                  :data-testid="`provider-model-test-${m.id}`"
                >
                  <Zap class="w-3.5 h-3.5" :class="testingModelId === m.id ? 'animate-pulse' : ''" />
                </button>
                <button
                  v-if="!m.isDefault"
                  @click="setModelDefault(m)"
                  class="p-1 rounded hover:bg-yellow-50 text-yellow-600"
                  :title="'设为该服务商默认'"
                  :data-testid="`provider-model-set-default-${m.id}`"
                >
                  <Star class="w-3.5 h-3.5" />
                </button>
                <button
                  @click="removeModel(m)"
                  class="p-1 rounded hover:bg-destructive/10 text-destructive"
                  :title="'删除'"
                  :data-testid="`provider-model-delete-${m.id}`"
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
              <Input
                :model-value="m.note ?? ''"
                @blur="(e) => updateModelNote(m, e.target.value)"
                placeholder="备注(可选,如 '便宜快速' / '推理重慢但强')"
                class="text-xs h-7"
                :data-testid="`provider-model-note-${m.id}`"
              />
            </div>
            <!-- 新增 model -->
            <div class="border border-dashed border-border rounded p-2 space-y-1">
              <div class="flex gap-2">
                <Input v-model="newModelName" placeholder="新模型名" class="flex-1 text-sm" data-testid="new-model-name" />
                <Button size="sm" @click="addNewModel" data-testid="new-model-add-btn">
                  <Plus class="w-4 h-4" />
                </Button>
              </div>
              <Input v-model="newModelNote" placeholder="备注(可选)" class="text-xs h-7" data-testid="new-model-note" />
            </div>
          </div>
          <div v-else class="text-xs text-muted-foreground border-t pt-2">
            保存后可在此管理预置模型清单
          </div>
          <!-- 测试结果显示 -->
          <div
            v-if="draftTestResult"
            class="rounded-md p-3 text-sm border"
            :class="draftTestResult.ok
              ? 'bg-green-50 text-green-800 border-green-200'
              : 'bg-red-50 text-red-800 border-red-200'"
            data-testid="draft-test-result"
          >
            <div class="font-medium flex items-center gap-1.5">
              <CheckCircle2 v-if="draftTestResult.ok" class="w-4 h-4" />
              <XCircle v-else class="w-4 h-4" />
              {{ draftTestResult.ok ? '测试通过' : (draftTestResult.errorCode || '失败') }}
              <span class="text-xs font-normal opacity-70">({{ draftTestResult.latencyMs }}ms)</span>
            </div>
            <div v-if="!draftTestResult.ok && draftTestResult.hint" class="mt-1 text-xs">
              {{ draftTestResult.hint }}
            </div>
            <div v-if="!draftTestResult.ok && draftTestResult.errorMessage" class="mt-1 text-xs opacity-70 break-all">
              {{ draftTestResult.errorMessage }}
            </div>
          </div>

          <div class="flex justify-between gap-2 pt-2">
            <Button
              variant="outline"
              @click="testDraftProvider"
              :disabled="testingDraft"
              data-testid="draft-test-btn"
            >
              <Zap class="w-4 h-4 mr-1" :class="testingDraft ? 'animate-pulse' : ''" />
              {{ testingDraft ? '测试中...' : '测试连接' }}
            </Button>
            <div class="flex gap-2">
              <Button variant="outline" @click="showProviderForm = false">取消</Button>
              <Button @click="saveProvider">保存</Button>
            </div>
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
