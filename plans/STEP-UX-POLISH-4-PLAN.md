# STEP-UX-POLISH-4 计划

## 背景

用户反馈的 5 个问题（按优先级 + 依赖关系排序）：

| # | 问题 | 性质 | 优先级 |
|---|------|------|--------|
| 5 | 10 分钟仍显示"进行中"（前端 error 事件未设 streamDone） | Bug | **P0** |
| 4 | 模块列表轮询抖动、滚动条闪烁 | UX | **P0** |
| 2 | 生成完成后卡片显示红色 `creating` | Bug | **P0** |
| 1 | 思考标签半闭合泄漏 `</tho` 到正文 | Bug | P1 |
| 3 | 失败但功能可用（session状态 vs 模块健康度耦合）+ 超时机制 + 重试 | 架构 | **P0** |

---

## Task 1 — 前端 error 事件补 streamDone（修问题 5 根因）

**位置**：`src/client/stores/chat.ts` `applyEvent` 的 `case 'error'`

**当前**：
```ts
case 'error': {
  const msg = ensureAssistant(s);
  msg.messageError = String((p as any).message ?? 'Error');
  break;
}
```

**改为**：
```ts
case 'error': {
  const msg = ensureAssistant(s);
  msg.messageError = String((p as any).message ?? 'Error');
  msg.streamDone = true;
  msg.thinkingComplete = true;
  s.status = 'error';
  break;
}
```

**附加兜底（connect() finally 块）**：
- 订阅结束时遍历 messages，如果 `s.status` 是 done/error/paused 但最后 assistant 消息 `streamDone` 是 false → 强制标 true

**测试**：手工构造一条 `run_status='error'` 的 session，刷新页面，验证不再显示"进行中..."

---

## Task 2 — 模块列表轮询优化（修问题 4）

**位置**：`src/client/pages/ModulesPage.vue` + `src/client/stores/modules.ts`

### 2a. 条件轮询

```ts
onMounted(() => {
  modulesStore.fetchModules();
  pollTimer = setInterval(() => {
    const hasTransient = modulesStore.modules.some(m =>
      m.status === 'creating' || m.status === 'editing'
    );
    if (hasTransient) modulesStore.fetchModules().catch(() => {});
  }, 2000);
});
```

当前已有条件轮询。但问题是：一次 fetchModules() 调用仍会整体替换数组 → 闪烁。

### 2b. fetchModules in-place merge

```ts
async function fetchModules() {
  const api = useApi();
  loading.value = true;
  try {
    const res = await api.get<{ success: boolean; data: Module[] }>('/api/modules');
    const incoming = res.data;

    if (modules.value.length === 0) {
      // 首次加载：直接赋值
      modules.value = incoming;
      return;
    }

    // 按 name 做 key 合并
    const byName = new Map(modules.value.map(m => [m.name, m]));
    const nextOrder: Module[] = [];
    for (const fresh of incoming) {
      const existing = byName.get(fresh.name);
      if (existing) {
        // 只覆盖变动字段（保持 Vue 响应式 identity）
        Object.assign(existing, fresh);
        nextOrder.push(existing);
        byName.delete(fresh.name);
      } else {
        nextOrder.push(fresh);
      }
    }
    // byName 中剩下的是被删除的模块
    // 使用 splice 原地替换，尽量保证顺序稳定
    modules.value.splice(0, modules.value.length, ...nextOrder);
  } finally {
    loading.value = false;
  }
}
```

### 2c. 避免 loading 状态引起闪烁

轮询时不要把 `loading.value = true`，避免首屏 Loading 替换。

改动：
- 新增内部 `refetch()` 不触碰 loading state
- 外部 onMounted 首次用 `fetchModules()`（设置 loading）
- 轮询使用 `refetch()`

### 2d. 页面容器稳定

给 `.grid` 容器加 `min-height: 200px; contain: layout;` 避免空态时高度塌陷。

**测试**：Playwright 监控 DOM 变动次数 + 滚动条是否出现；或手工检查 2 分钟无抖动。

---

## Task 3 — 模块 Card 状态时序 + 样式（修问题 2）

### 3a. chat-runner 发 card 时机

**位置**：`src/server/agent/chat-runner.ts`

**当前**：`runAIGeneration` 流结束前 loadModuleCards → appendEvent('card') → finalize('done')。`loadModuleCards` 读到的 status 还是 'creating'。

**改为**：把 card 发射延后到 finalize 之后。但 finalize 会发 'done' 事件关闭订阅，后续 card 事件会被丢弃。

**方案**：改变 finalize 流程 — 在发 terminal 事件前先 emit cards。

```ts
// 在 finalize 第一步之前新增 hook
private finalize(terminal, extra?): void {
  this.clearRunTimeout();
  this.flushTextBuffers();

  // 更新模块状态（done 时 → active）
  this.applyModuleFinalize(terminal);  // ← 提前到这里

  // 然后再发 card（此时 DB.status 是最终值）
  this.emitFinalCards?.();

  // 发 terminal 事件
  this.appendEvent(terminal, extra ?? {});
  ...
}
```

把 loadModuleCards 调用从 streamErr/done 分支移到 finalize 内，统一处理。

### 3b. MessageBubble card 样式对齐

**位置**：`src/client/components/chat/MessageBubble.vue`

```vue
<span class="module-card-status" :class="statusClass(m.status)">
  {{ statusText(m.status) }}
</span>
```

```ts
function statusClass(s: string) {
  return {
    active: 'status-active',
    creating: 'status-creating',
    editing: 'status-editing',
    error: 'status-error',
  }[s] || 'status-error';
}
function statusText(s: string) {
  return { active: '可用', creating: '创建中...', editing: '编辑中', error: '失败' }[s] || s;
}
```

CSS 新增 status-creating（蓝）/ status-editing（黄）。

### 3c. Tailwind safelist 修复（防问题 2 再现）

检查 `tailwind.config.js` 是否安全列入了 bg-blue-100、bg-yellow-100、text-blue-700、text-yellow-700 —— ModulesPage 动态 class 依赖。

**测试**：手工 + 已有 T07（creating 徽章）扩展。

---

## Task 4 — ThinkingParser 半闭合标签缓冲（修问题 1）

**位置**：`src/server/agent/thinking-adapter.ts`

### 4a. 增强状态机

当前（推测）：简单的子串查找 `<thinking>` / `</thinking>`。

**改为**：
- 状态：`TEXT | IN_THINKING | LT_BUFFER`
- TEXT 态遇到 `<` → 进入 LT_BUFFER 态，缓冲
- LT_BUFFER 期间继续收字符，累计 `<...`
- 累计足以判断：
  - 是 `<thinking>` → 切到 IN_THINKING，清缓冲
  - 不是（例如 `<!` 或 `<p>` 或任何其他字符让前缀不再匹配 `<thinking>` 前缀） → 把缓冲以 text 发射，回 TEXT 态
- 流结束 flush：LT_BUFFER 缓冲以 text 发射

IN_THINKING 态同理处理 `</thinking>` 的前缀匹配。

### 4b. 单元测试

新增 `tests/thinking-parser.spec.ts`：
- 正常 `<thinking>x</thinking>y` 分一次 feed
- 分片 feed：`["<thi", "nking>x</thi", "nking>y"]`
- 分片在 `</thinking>` 中间：`["x</thi", "nking>y"]`
- 标签内嵌文本字符但非完整闭合：`"x<y>z"` 应全作为 text

**测试关键**：`"</tho"` 绝不单独出现在 text 流中。

---

## Task 5 — 模块状态机重构（修问题 3，架构级）

### 5a. 新增 "health" 函数

**位置**：新文件 `src/server/core/module-health.ts`

```ts
export type ModuleHealth = 'healthy' | 'degraded' | 'missing';

interface HealthReport {
  health: ModuleHealth;
  missing: string[];   // 缺失文件名
  hasTable: boolean;
  metaValid: boolean;
}

export function computeModuleHealth(userId: number, moduleName: string): HealthReport {
  const dir = join(GENERATED_DIR, String(userId), moduleName);
  const required = ['_meta.json', 'schema.sql', 'controller.ts', 'test.ts', 'api-doc.md'];
  const missing = required.filter(f => !existsSync(join(dir, f)));

  let metaValid = false;
  let tableName: string | null = null;
  try {
    const meta = JSON.parse(readFileSync(join(dir, '_meta.json'), 'utf-8'));
    metaValid = typeof meta.name === 'string' && Array.isArray(meta.entities);
    tableName = meta.entities?.[0]?.tableName;
  } catch {}

  let hasTable = false;
  if (tableName) {
    const injected = `mock__${userId}_${tableName.replace(/^mock__/, '')}`;
    const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(injected);
    hasTable = !!row;
  }

  const health: ModuleHealth =
    missing.length === 0 && metaValid && hasTable ? 'healthy'
    : missing.length === required.length && !metaValid ? 'missing'
    : 'degraded';

  return { health, missing, hasTable, metaValid };
}
```

### 5b. 新增字段 modules.lastRunStatus + lastRunError

Schema + migration。

### 5c. finalize 时用 health 派生 status

**位置**：`chat-runner.ts applyModuleFinalize`

```ts
private applyModuleFinalize(terminal: 'done' | 'paused' | 'error' | 'aborted'): void {
  if (!this.moduleIntent) return;
  const { moduleName, operation } = this.moduleIntent;
  const { userId } = this;

  const report = computeModuleHealth(userId, moduleName);
  const nowStr = now();

  // Determine last run status
  const lastRunStatus =
    terminal === 'done' ? 'done'
    : terminal === 'error' ? (this._timedOut ? 'timeout' : 'error')
    : 'interrupted';

  const lastRunError =
    terminal === 'error' ? (extra?.message ?? '生成失败')
    : terminal === 'paused' || terminal === 'aborted' ? null
    : null;

  // Health-derived module status
  let nextStatus: string;
  if (report.health === 'healthy') {
    nextStatus = 'active';
  } else if (report.health === 'missing') {
    // Never completed — if created by this run, delete it
    if (operation === 'create' && terminal !== 'done') {
      sqlite.prepare(`DELETE FROM modules WHERE name = ? AND user_id = ? AND status = 'creating'`)
        .run(moduleName, userId);
      return;
    }
    nextStatus = 'error';
  } else {
    // degraded: some files exist but incomplete
    nextStatus = terminal === 'done' ? 'error' : 'error';
  }

  sqlite.prepare(
    `UPDATE modules SET status = ?, error_message = ?, last_run_status = ?, last_run_error = ?, updated_at = ?
     WHERE name = ? AND user_id = ?`
  ).run(
    nextStatus,
    nextStatus === 'error' ? (lastRunError || '模块文件不完整') : null,
    lastRunStatus,
    lastRunError,
    nowStr,
    moduleName,
    userId,
  );
}
```

### 5d. 超时阈值改为 10 分钟（可配）

```ts
const RUN_TIMEOUT_MS = Number(process.env.CHAT_RUN_TIMEOUT_MS || 10 * 60 * 1000);
```

### 5e. 前端"重新生成"按钮

**位置**：`src/client/pages/ModuleDetailPage.vue`

- 当 `moduleData.status === 'error'` 时，在 header 区域右侧显示"重新生成"按钮 + error tooltip
- 点击 → 新建 session（带 moduleName 绑定）→ 跳转 /chat/{sid}?prefill=重新生成{模块displayName}
- 或更简单：在 Modules 列表页 error 状态卡片右上角加 Refresh icon

**测试**：构造一个 `status=error` 且文件齐全的模块，验证"重新生成"跳转工作；并验证列表页点击健康模块无阻塞。

---

## Task 顺序 + 工时

| 顺序 | Task | 工时 | 依赖 |
|------|------|------|------|
| 1 | Task 1 前端 error case | 15min | 无 |
| 2 | Task 2 列表轮询优化 | 40min | 无 |
| 3 | Task 3 card 时序 + 样式 | 45min | Task 5d（超时） |
| 4 | Task 4 ThinkingParser 缓冲 | 1h | 无 |
| 5 | Task 5 模块健康度派生 + 重试 | 2h | 无 |

**合计**：约 4.5-5 小时

---

## 测试策略

### 新增 Playwright 测试（`tests/step-ux-polish-4.spec.ts`）

| Test | 覆盖 |
|------|------|
| T4-01 | Task 1: error 事件后 isGenerating=false（不再显示进行中） |
| T4-02 | Task 2: 2s 轮询期间 DOM 抖动指标（数组长度/高度稳定） |
| T4-03 | Task 3: fake 流完成后，最新 card 的 status === 'active'（不是 creating） |
| T4-04 | Task 3: MessageBubble card 的 creating 徽章中文 + 蓝色样式 |
| T4-05 | Task 4: ThinkingParser 分片 `</thi` + `nking>` 不泄漏 text |
| T4-06 | Task 5: health-derived module status — 手工构造"文件齐全但 run=error"，最终 status === 'active' |
| T4-07 | Task 5: 重新生成按钮在 error 模块详情页可见并可点击 |

### 单元测试（`tests/unit/thinking-parser.spec.ts`）

纯 parser 的 6 个场景（见 Task 4.b）

### 回归

- 全部 STEP-UX-POLISH-3 的 10 测试保持绿
- chat-resumable 7 测试保持绿
- page-chat 22 / page-modules 12 / e2e-flows 8 / navigation 14 保持绿

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 1 | Task 5d 超时 10min 对 fake 测试无影响（fake 2s 内完成） |
| 2 | Task 2 in-place merge 破坏 Vue reactivity | 保留 `modules.value.splice(0, len, ...)` 写法，触发 reactivity |
| 3 | Task 4 ThinkingParser 误判真正的 `<code>` 段 | 只匹配 `<thinking>` 和 `</thinking>` 确切前缀，其他 `<x>` 尽快放回 text |
| 4 | Task 5 迁移 lastRunStatus/lastRunError 两列 | 用 `PRAGMA table_info` 条件 ALTER，向后兼容 |

---

## 用户决策点

- [ ] 超时阈值 10min 是否合适？还是 15min？
- [ ] "重新生成"按钮位置：Modules 列表卡片右上 vs ModuleDetail header 右侧 vs 两者都有？
- [ ] MessageBubble 的 module-card 显示 status 中文：'可用' vs '就绪'？（与 ModulesPage "就绪" 对齐建议）

默认按 10min + ModuleDetail header + "就绪" 推进。

---

## 不做 / 暂缓

- 重新生成时自动传入原始 prompt（需跨 session 绑定，暂用用户手动重发）
- 多模块并发状态追踪（当前一次只处理一个 moduleIntent）
- 真正意义的"进度百分比"（仍用 "进行中..." + 已用时）
