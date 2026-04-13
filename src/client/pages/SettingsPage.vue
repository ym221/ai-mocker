<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useProviderStore } from '../stores/provider';
import { usePresetStore } from '../stores/preset';
import { useAuthStore } from '../stores/auth';
import { useApi } from '../composables/use-api';
import { toast } from 'vue-sonner';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-vue-next';

const providerStore = useProviderStore();
const presetStore = usePresetStore();
const authStore = useAuthStore();
const api = useApi();

const activeTab = ref<'providers' | 'presets'>('providers');

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
    toast.error('Name and model are required');
    return;
  }
  try {
    const data: Record<string, unknown> = { ...providerForm.value };
    if (!data.apiKey) delete data.apiKey;

    if (editingProviderId.value) {
      await providerStore.updateProvider(editingProviderId.value, data);
      toast.success('Provider updated');
    } else {
      await providerStore.createProvider(data);
      toast.success('Provider created');
    }
    showProviderForm.value = false;
  } catch { /* toast handled by useApi */ }
}

async function deleteProvider(id: number) {
  if (!confirm('Delete this provider?')) return;
  try {
    await providerStore.deleteProvider(id);
    toast.success('Provider deleted');
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
    toast.error('Name is required');
    return;
  }
  try {
    if (editingPresetId.value) {
      await presetStore.updatePreset(editingPresetId.value, presetForm.value);
      toast.success('Preset updated');
    } else {
      await presetStore.createPreset(presetForm.value);
      toast.success('Preset created');
    }
    showPresetForm.value = false;
  } catch { /* toast handled by useApi */ }
}

async function deletePreset(id: number) {
  if (!confirm('Delete this preset?')) return;
  try {
    await presetStore.deletePreset(id);
    toast.success('Preset deleted');
  } catch { /* toast handled by useApi */ }
}

onMounted(() => {
  providerStore.fetchProviders();
  presetStore.fetchPresets();
});
</script>

<template>
  <div class="max-w-4xl mx-auto p-6">
    <h1 class="text-2xl font-bold mb-6">Settings</h1>

    <!-- Tabs -->
    <div class="flex border-b border-border mb-6">
      <button
        @click="activeTab = 'providers'"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'providers' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
      >
        AI Providers
      </button>
      <button
        @click="activeTab = 'presets'"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'presets' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
      >
        Project Presets
      </button>
    </div>

    <!-- Providers Tab -->
    <div v-if="activeTab === 'providers'">
      <div class="flex justify-between items-center mb-4">
        <p class="text-sm text-muted-foreground">Configure AI providers for generating Mock APIs</p>
        <Button size="sm" @click="openProviderForm()">
          <Plus class="w-4 h-4 mr-1" /> Add Provider
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
          No providers configured
        </div>
      </div>

      <!-- Provider form dialog -->
      <div v-if="showProviderForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showProviderForm = false">
        <div class="bg-background border border-border rounded-lg p-6 w-full max-w-md space-y-4">
          <h3 class="text-lg font-semibold">{{ editingProviderId ? 'Edit' : 'Add' }} Provider</h3>
          <div>
            <label class="text-sm font-medium">Name</label>
            <Input v-model="providerForm.name" placeholder="My OpenAI Provider" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">Type</label>
            <select v-model="providerForm.type" class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
              <option value="openai-compatible">OpenAI Compatible</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div>
            <label class="text-sm font-medium">Base URL (optional)</label>
            <Input v-model="providerForm.baseUrl" placeholder="https://api.openai.com/v1" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">API Key</label>
            <Input v-model="providerForm.apiKey" type="password" :placeholder="editingProviderId ? 'Leave blank to keep current' : 'Enter API key'" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">Default Model</label>
            <Input v-model="providerForm.defaultModel" placeholder="gpt-4o-mini" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">Scope</label>
            <select v-model="providerForm.scope" class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="outline" @click="showProviderForm = false">Cancel</Button>
            <Button @click="saveProvider">Save</Button>
          </div>
        </div>
      </div>
    </div>

    <!-- Presets Tab -->
    <div v-if="activeTab === 'presets'">
      <div class="flex justify-between items-center mb-4">
        <p class="text-sm text-muted-foreground">Define project presets for consistent API generation</p>
        <Button size="sm" @click="openPresetForm()">
          <Plus class="w-4 h-4 mr-1" /> Add Preset
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
            <div class="text-sm text-muted-foreground">{{ p.description || 'No description' }} | {{ p.scope }}</div>
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
          No presets configured
        </div>
      </div>

      <!-- Preset form dialog -->
      <div v-if="showPresetForm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showPresetForm = false">
        <div class="bg-background border border-border rounded-lg p-6 w-full max-w-md space-y-4">
          <h3 class="text-lg font-semibold">{{ editingPresetId ? 'Edit' : 'Add' }} Preset</h3>
          <div>
            <label class="text-sm font-medium">Name</label>
            <Input v-model="presetForm.name" placeholder="Company API Standard" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">Description</label>
            <textarea v-model="presetForm.description" placeholder="Describe this preset" class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px]" />
          </div>
          <div>
            <label class="text-sm font-medium">Configuration (JSON)</label>
            <textarea v-model="presetForm.content" placeholder='{"responseFormat":{}, "fieldNaming":"camelCase"}' class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[100px]" />
          </div>
          <div>
            <label class="text-sm font-medium">Scope</label>
            <select v-model="presetForm.scope" class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="outline" @click="showPresetForm = false">Cancel</Button>
            <Button @click="savePreset">Save</Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
