<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useModulesStore } from '../stores/modules';
import { useChatStore } from '../stores/chat';
import { toast } from '../composables/use-toast';
import { Button } from '../components/ui/button';
import { Play, Database, BookOpen, Copy, Download, FileJson, RefreshCw, AlertCircle, Activity, Loader2 } from 'lucide-vue-next';
import DataTable from '../components/data/DataTable.vue';
import TimelineView from '../components/observability/TimelineView.vue';
import { usePageHeader } from '@/composables/use-page-header';
import { copyToClipboard } from '@/composables/use-clipboard';
import MarkdownIt from 'markdown-it';

const route = useRoute();
const router = useRouter();
const modulesStore = useModulesStore();
const chatStore = useChatStore();

const moduleName = computed(() => route.params.name as string);
const moduleData = ref<any>(null);
const dataFields = computed<any[]>(() => moduleData.value?.meta?.entities?.[0]?.fields ?? []);
const activeTab = ref('endpoints');
const testResult = ref<{ url: string; method: string; status: number; body: any } | null>(null);
const docContent = ref('');
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });
const renderedDoc = computed(() => docContent.value ? md.render(docContent.value) : '');

// page-header 的 meta 行展示模块的 basePath + 创建/更新审计,让用户随手看见"谁的、什么时候动过"
function formatAuditLine(m: any): string {
  if (!m) return '';
  const parts: string[] = [];
  if (m.basePath) parts.push(m.basePath);
  const createdBy = m.createdByUsername || (m.userId ? `#${m.userId}` : null);
  const updatedBy = m.updatedByUsername || (m.updatedBy ? `#${m.updatedBy}` : createdBy);
  if (createdBy) parts.push(`创建人 ${createdBy}`);
  if (updatedBy && updatedBy !== createdBy) parts.push(`最后更新 ${updatedBy}`);
  if (m.updatedAt) parts.push(`更新于 ${m.updatedAt}`);
  return parts.join(' · ');
}

usePageHeader(() => ({
  title: moduleData.value?.displayName || moduleName.value || '模块详情',
  description: moduleData.value?.description || '',
  meta: formatAuditLine(moduleData.value),
  back: '/modules',
}));

async function loadModule() {
  try {
    moduleData.value = await modulesStore.fetchModule(moduleName.value);
  } catch {
    toast.error('加载模块失败');
  }
}

async function quickTest(method: string, path: string) {
  const url = moduleData.value?.basePath + path;
  try {
    const res = await fetch(url);
    const body = await res.json();
    testResult.value = { url, method, status: res.status, body };
  } catch (err) {
    toast.error('请求失败');
  }
}

// 完整可复制访问 URL — 当前页面 origin + /mock/<moduleName> + endpoint.path。
// 业务代码 / curl 直接用这个 URL,零身份信息(框架按 moduleName 全局路由)。
const pageOrigin = computed(() => (typeof window !== 'undefined' ? window.location.origin : ''));
function buildFullUrl(path: string): string {
  return `${pageOrigin.value}/mock/${moduleName.value}${path}`;
}
async function copyUrl(url: string) {
  try {
    await copyToClipboard(url);
    toast.success('已复制 URL');
  } catch {
    toast.error('复制失败,请手动选中地址复制');
  }
}

async function loadDoc() {
  try {
    docContent.value = await modulesStore.fetchModuleDoc(moduleName.value);
  } catch {
    docContent.value = '暂无文档';
  }
}

// ===== 文档操作：复制 / 下载 Markdown / 导出 OpenAPI =====
async function copyDoc() {
  try {
    await copyToClipboard(docContent.value || '');
    toast.success('已复制文档');
  } catch {
    toast.error('复制失败');
  }
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadMarkdown() {
  if (!docContent.value) { toast.error('文档为空'); return; }
  downloadBlob(docContent.value, `${moduleName.value}-api-doc.md`, 'text/markdown;charset=utf-8');
  toast.success('已下载 Markdown');
}

function fieldTypeToOpenApi(t: string): { type: string; format?: string } {
  switch (t) {
    case 'integer': case 'number': return { type: 'integer', format: 'int64' };
    case 'float': case 'decimal': return { type: 'number', format: 'float' };
    case 'boolean': return { type: 'boolean' };
    case 'date': return { type: 'string', format: 'date' };
    case 'datetime': case 'timestamp': return { type: 'string', format: 'date-time' };
    case 'text': case 'string': default: return { type: 'string' };
  }
}

function buildOpenApiSpec(): any {
  const meta = moduleData.value?.meta;
  if (!meta) return null;
  const spec: any = {
    openapi: '3.0.3',
    info: {
      title: meta.displayName || meta.name,
      version: String(meta.version ?? 1),
      description: meta.description || '',
    },
    paths: {} as Record<string, any>,
    components: { schemas: {} as Record<string, any> },
  };

  // Build entity schemas
  const entityMap: Record<string, any> = {};
  for (const ent of meta.entities || []) {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const f of ent.fields || []) {
      properties[f.name] = {
        ...fieldTypeToOpenApi(String(f.type || 'string')),
        description: f.displayName || undefined,
      };
      if (f.required) required.push(f.name);
    }
    const schema = { type: 'object', properties, ...(required.length ? { required } : {}) };
    spec.components.schemas[ent.name] = schema;
    entityMap[ent.name] = schema;
  }

  // Default entity = first
  const firstEntityName = meta.entities?.[0]?.name;
  const firstRef = firstEntityName ? `#/components/schemas/${firstEntityName}` : undefined;
  const basePath = meta.basePath || '';

  const successEnvelope = (dataSchema: any) => ({
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      data: dataSchema,
    },
  });

  for (const ep of meta.endpoints || []) {
    const fullPath = (basePath + (ep.path || '')).replace(/\/:([A-Za-z0-9_]+)/g, '/{$1}');
    const method = String(ep.method || 'GET').toLowerCase();
    const op: any = {
      summary: ep.name || ep.type,
      tags: [meta.name],
    };
    // path params
    const paramNames: string[] = [];
    const re = /\{([A-Za-z0-9_]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fullPath)) !== null) paramNames.push(m[1]);
    if (paramNames.length > 0) {
      op.parameters = paramNames.map(n => ({
        name: n,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
    }
    if (method === 'post' || method === 'put' || method === 'patch') {
      if (firstRef) {
        op.requestBody = {
          required: true,
          content: { 'application/json': { schema: { $ref: firstRef } } },
        };
      }
    }
    // response
    let dataSchema: any = firstRef ? { $ref: firstRef } : { type: 'object' };
    if (ep.type === 'list') {
      dataSchema = {
        type: 'object',
        properties: {
          list: { type: 'array', items: firstRef ? { $ref: firstRef } : { type: 'object' } },
          total: { type: 'integer' },
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
        },
      };
    } else if (ep.type === 'delete') {
      dataSchema = { type: 'null' };
    }
    op.responses = {
      '200': {
        description: 'OK',
        content: { 'application/json': { schema: successEnvelope(dataSchema) } },
      },
    };
    spec.paths[fullPath] = { ...(spec.paths[fullPath] || {}), [method]: op };
  }
  return spec;
}

function downloadOpenApi() {
  const spec = buildOpenApiSpec();
  if (!spec) { toast.error('模块元数据不可用'); return; }
  downloadBlob(JSON.stringify(spec, null, 2), `${moduleName.value}-openapi.json`, 'application/json;charset=utf-8');
  toast.success('已下载 OpenAPI');
}

function selectTab(id: string) {
  activeTab.value = id;
  if (id === 'doc') loadDoc();
}

onMounted(() => {
  loadModule();
});

// ===== 重新生成（error 模块）=====
async function regenerateModule() {
  if (!moduleData.value) return;
  const displayName = moduleData.value.displayName || moduleData.value.name;
  try {
    const session = await chatStore.createSession({ moduleName: moduleData.value.name });
    await router.push(`/chat/${session.id}`);
    // 自动发送提示让 AI 继续 / 修复
    setTimeout(() => {
      chatStore.send(session.id, `继续完善"${displayName}"模块，修复上次未完成的部分`).catch(() => {});
    }, 400);
  } catch (err) {
    toast.error((err as Error).message || '创建会话失败');
  }
}
</script>

<template>
  <div class="px-6 py-4">
    <div v-if="!moduleData" class="text-center py-12 text-muted-foreground">加载中...</div>

    <template v-else>
      <!-- Active-session banner: module is ready but a chat session is still
           running against it. Lets the user know the module may keep changing
           until the conversation ends — fixes the "ready but timer ticking"
           confusion users hit when looking at the modules list mid-generation. -->
      <div
        v-if="moduleData.hasActiveSession && moduleData.status === 'active'"
        class="mb-4 flex items-start gap-3 px-4 py-3 rounded-lg border border-blue-200 bg-blue-50"
        data-testid="module-active-session-banner"
      >
        <Loader2 class="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5 animate-spin" />
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-blue-800">模块已就绪，对话仍在进行</div>
          <div class="text-xs text-blue-700 mt-0.5">
            AI 仍在与该模块交互（可能在测试或修改），结构与数据可能继续变化。
          </div>
        </div>
      </div>

      <!-- Error banner + Retry (for degraded/error modules with functional fallback) -->
      <div
        v-if="moduleData.status === 'error'"
        class="mb-4 flex items-start gap-3 px-4 py-3 rounded-lg border border-red-200 bg-red-50"
        data-testid="module-error-banner"
      >
        <AlertCircle class="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-red-800">
            {{ moduleData.lastRunStatus === 'timeout' ? '生成超时' : '生成未完成' }}
          </div>
          <div class="text-xs text-red-700 mt-0.5">
            {{ moduleData.errorMessage || moduleData.lastRunError || '上一次生成未成功完成。' }}
            <span v-if="moduleData.health === 'healthy'" class="ml-1 text-green-700 font-medium">
              （模块文件已就绪，功能可用）
            </span>
          </div>
        </div>
        <Button size="sm" variant="outline" @click="regenerateModule" data-testid="module-retry-btn">
          <RefreshCw class="w-3.5 h-3.5 mr-1.5" />
          重新生成
        </Button>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-border mb-4 sticky top-0 bg-background z-10">
        <button
          v-for="tab in [
            { id: 'endpoints', label: '接口', icon: Play },
            { id: 'data', label: '数据', icon: Database },
            { id: 'doc', label: '文档', icon: BookOpen },
            { id: 'timeline', label: '执行日志', icon: Activity },
          ]"
          :key="tab.id"
          @click="selectTab(tab.id)"
          class="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors"
          :class="activeTab === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
        >
          <component :is="tab.icon" class="w-4 h-4" />
          {{ tab.label }}
        </button>
      </div>

      <!-- Endpoints Tab -->
      <div v-if="activeTab === 'endpoints'" class="max-w-6xl">
        <!-- 访问 URL 提示横条 — 复制即用 -->
        <div class="mb-4 p-3 rounded-md bg-muted/40 border border-border text-xs text-muted-foreground">
          <div class="font-medium text-foreground mb-1">访问 URL 公式</div>
          <div class="font-mono">
            <span class="text-primary">{{ pageOrigin }}/mock/{{ moduleName }}</span><span>&lt;endpoint.path&gt;</span>
          </div>
          <div class="mt-1.5">业务代码 / curl / 代理都直接用,不需要带任何 token / userId / header。</div>
        </div>
        <div class="space-y-3">
          <div
            v-for="ep in moduleData.meta?.endpoints || []"
            :key="ep.method + ep.path"
            class="border border-border rounded-lg p-4 flex items-center justify-between gap-3"
          >
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <span
                class="text-xs font-mono font-bold px-2 py-0.5 rounded flex-shrink-0"
                :class="{
                  'bg-green-100 text-green-700': ep.method === 'GET',
                  'bg-blue-100 text-blue-700': ep.method === 'POST',
                  'bg-yellow-100 text-yellow-700': ep.method === 'PUT',
                  'bg-red-100 text-red-700': ep.method === 'DELETE',
                }"
              >
                {{ ep.method }}
              </span>
              <span class="font-mono text-sm truncate" :title="buildFullUrl(ep.path)">{{ pageOrigin }}/mock/{{ moduleName }}{{ ep.path }}</span>
              <span class="text-sm text-muted-foreground truncate hidden md:inline">{{ ep.name }}</span>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <Button
                size="sm"
                variant="outline"
                @click="copyUrl(buildFullUrl(ep.path))"
                title="复制完整 URL"
              >
                复制
              </Button>
              <Button
                v-if="ep.method === 'GET'"
                size="sm"
                variant="outline"
                @click="quickTest(ep.method, ep.path === '/:id' ? '/1' : ep.path)"
              >
                <Play class="w-3 h-3 mr-1" /> 测试
              </Button>
            </div>
          </div>
        </div>

        <!-- Test result -->
        <div v-if="testResult" class="mt-6 border border-border rounded-lg p-4">
          <div class="flex items-center gap-2 mb-2 text-sm">
            <span class="font-mono">{{ testResult.method }} {{ testResult.url }}</span>
            <span
              class="px-2 py-0.5 rounded text-xs font-bold"
              :class="testResult.status < 400 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'"
            >
              {{ testResult.status }}
            </span>
          </div>
          <pre class="bg-muted p-3 rounded text-xs overflow-auto max-h-[300px]">{{ JSON.stringify(testResult.body, null, 2) }}</pre>
        </div>
      </div>

      <!-- Data Tab -->
      <div v-if="activeTab === 'data'">
        <DataTable
          v-if="dataFields.length > 0"
          :module-name="moduleName"
          :fields="dataFields"
        />
        <div v-else class="text-center py-12 text-muted-foreground">
          <Database class="w-12 h-12 mx-auto mb-4 opacity-30" />
          <p>此模块没有实体定义</p>
        </div>
      </div>

      <!-- Documentation Tab -->
      <div v-if="activeTab === 'doc'" class="max-w-4xl">
        <div v-if="docContent" class="space-y-3">
          <div class="flex gap-2 flex-wrap" data-testid="doc-toolbar">
            <Button size="sm" variant="outline" @click="copyDoc" data-testid="doc-copy-btn">
              <Copy class="w-3.5 h-3.5 mr-1.5" />
              复制全文
            </Button>
            <Button size="sm" variant="outline" @click="downloadMarkdown" data-testid="doc-download-md-btn">
              <Download class="w-3.5 h-3.5 mr-1.5" />
              下载 Markdown
            </Button>
            <Button size="sm" variant="outline" @click="downloadOpenApi" data-testid="doc-download-openapi-btn">
              <FileJson class="w-3.5 h-3.5 mr-1.5" />
              下载 OpenAPI JSON
            </Button>
          </div>
          <div class="api-doc prose prose-sm max-w-none" v-html="renderedDoc" />
        </div>
        <div v-else class="text-center py-12 text-muted-foreground">
          暂无文档
        </div>
      </div>

      <!-- Timeline Tab (执行日志) -->
      <div v-if="activeTab === 'timeline'" class="max-w-6xl" data-testid="timeline-tab">
        <TimelineView :module-name="moduleName" :active="activeTab === 'timeline'" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.api-doc :deep(h1) { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.5rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.5rem; }
.api-doc :deep(h2) { font-size: 1.1rem; font-weight: 600; margin-top: 1.5rem; margin-bottom: 0.4rem; }
.api-doc :deep(h3) { font-size: 1rem; font-weight: 600; margin-top: 1rem; }
.api-doc :deep(table) { border-collapse: collapse; width: 100%; font-size: 0.85rem; margin: 0.5rem 0; }
.api-doc :deep(th),
.api-doc :deep(td) { border: 1px solid #e2e8f0; padding: 0.35rem 0.6rem; text-align: left; }
.api-doc :deep(th) { background: #f8fafc; font-weight: 600; }
.api-doc :deep(code) { background: #f1f5f9; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85em; }
.api-doc :deep(pre) { background: #1e293b; color: #e2e8f0; padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.8rem; }
.api-doc :deep(pre code) { background: transparent; padding: 0; color: inherit; }
.api-doc :deep(ul) { padding-left: 1.5rem; }
.api-doc :deep(li) { margin-bottom: 0.15rem; }
</style>
