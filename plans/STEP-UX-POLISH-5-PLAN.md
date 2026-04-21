# STEP-UX-POLISH-5 计划

## 背景

用户反馈的 3 个问题：

| # | 问题 | 性质 | 优先级 |
|---|------|------|--------|
| 1 | Toast 消息位置错乱、文字被截断（图1 左下、"logs 仍在生成中" 被侧边栏遮挡） | UX | **P0** |
| 2 | 模块卡片已生成 + "已完成思考" 已显示，但 "进行中... 7m12s" banner 仍存在 | Bug | **P0** |
| 3 | AI 宣称完成但数据表未创建：bulk-generate 报 `no such table: mock__1_log` | 架构 + AI 流程 | **P0** |

---

## Task 1 — 统一封装 Toast 组件 + 全局替换

### 现状
- 9 处文件 `import { toast } from 'vue-sonner'` 直接调用
- `App.vue` 配置 `<Toaster position="top-right" :duration="3000" />` 但实际渲染到左下（可能 vue-sonner 的 prop 未生效，需排查）
- 调用样式不统一，部分用 `toast.success`、部分 `toast.error`、部分 `toast.info`
- 长文本 toast 会被左侧 sidebar 遮挡

### 方案

**1.1 统一 Toaster 配置（修渲染位置）**

在 `App.vue` 中把 `<Toaster>` 升级：
- `position="top-center"`（避开左右侧边栏遮挡）
- `richColors` 启用默认色
- `closeButton` 让长 toast 可手动关闭
- `expand` + `visibleToasts: 3`
- `:toastOptions="{ classes: { toast: 'app-toast' } }"` 统一样式兜底
- 全局 CSS 加 z-index 确保在最上层

**1.2 封装 use-toast composable**

新建 `src/client/composables/use-toast.ts`：

```ts
import { toast as sonner } from 'vue-sonner';

export interface ToastOptions { description?: string; duration?: number; }

export const toast = {
  success(message: string, opts?: ToastOptions) { sonner.success(message, { ...opts }); },
  error(message: string, opts?: ToastOptions)   { sonner.error(message,   { ...opts, duration: opts?.duration ?? 5000 }); },
  info(message: string, opts?: ToastOptions)    { sonner.info(message,    { ...opts }); },
  warning(message: string, opts?: ToastOptions) { sonner.warning(message, { ...opts }); },
  message(message: string, opts?: ToastOptions) { sonner(message, { ...opts }); },
  dismiss: sonner.dismiss,
};

export function useToast() { return toast; }
```

**1.3 全局替换（9 个文件）**

把所有 `from 'vue-sonner'` 的 `toast` 导入改为从封装处导入。保留 sonner 作为底层实现。

**文件清单**：
- `src/client/pages/ModuleDetailPage.vue`
- `src/client/pages/ModulesPage.vue`
- `src/client/pages/SettingsPage.vue`
- `src/client/pages/AdminPage.vue`
- `src/client/pages/LoginPage.vue`
- `src/client/composables/use-api.ts`
- `src/client/components/chat/ChatInput.vue`
- `src/client/stores/auth.ts`
- 保留 `App.vue` 的 `Toaster` 组件导入不变

### 测试
- 手工：触发任意 toast（登录错误/删除模块），验证出现在 top-center 且不被遮挡
- Playwright：新增 `tests/toast.spec.ts`
  - 登录失败 → toast `data-sonner-toaster` 位置 = top-center
  - 文本不被任何 z-index 更高的元素遮挡

---

## Task 2 — 修复 "进行中" 卡死 + isGenerating 强化

### 根因分析

**(a) `send()` finally 缺少安全网**：
```ts
} finally {
  if (s.abortController === ac) s.abortController = null;
  if (s.status === 'running' || s.status === 'connecting') s.status = 'done';
}
```
只改 `s.status`，没把**最后一条 assistant 消息的 `streamDone` 标记为 true**。即使 session 整体进入 done 状态，`isGenerating` 仍因 `!streamDone` 判定为 true。

**(b) `isGenerating` 的判定太宽**：
```ts
const isGenerating = computed(() =>
  !isUser.value && !props.streamDone && (props.toolCalls?.length ?? 0) > 0
);
```
只看单条消息的 streamDone，忽略 session 整体状态。

### 方案

**2.1 send() finally 补兜底（与 connect() 对齐）**

```ts
} finally {
  if (s.abortController === ac) s.abortController = null;
  if (s.status === 'running' || s.status === 'connecting') s.status = 'done';
  // Safety: mirror connect() — force-close last assistant msg if terminal
  if (s.status === 'done' || s.status === 'error' || s.status === 'paused') {
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === 'assistant' && !last.streamDone) {
      last.streamDone = true;
      last.thinkingComplete = true;
    }
  }
}
```

**2.2 MessageBubble isGenerating 加启发式**

当出现**任意 module card**或 **messageError**时，强制视为已完成（AI 大模型执行结束的信号）：

```ts
const isGenerating = computed(() => {
  if (isUser.value) return false;
  if (props.streamDone) return false;
  if (props.messageError) return false;
  if ((props.modules?.length ?? 0) > 0) return false; // cards present → finalize reached
  return (props.toolCalls?.length ?? 0) > 0;
});
```

**2.3 connect() 重连时主动同步终态**

`GET /api/chat/stream` 的 meta 响应已包含 `runStatus`。我们已在 `handleIncoming` 的 meta 分支里处理过；但 send() 的 POST 响应的第一个事件也是 meta，确保该路径也走同样的关流。

检查并补齐。

### 测试
- 新增 T5-01：POST /api/chat 响应后，流断开 + 终态事件未到，frontend 应该在 100ms 内清 "进行中"
- 新增 T5-02：当 message.modules 非空，MessageBubble 不显示 generating-banner
- 已有 T4-01 继续保持

---

## Task 3 — 数据表自愈 + AI 测试规范强化

### 根因分析

错误：`no such table: mock__1_log`

可能链路：
1. AI 生成 schema.sql，但实际 SQL 语法错误被 write_file 捕获，返回失败消息（AI 可能没重试）
2. AI 用了不同表名：schema.sql 里写 `mock__log`，但 _meta.json 里 entities[0].tableName 是 `mock__logs` 或相反
3. write_file 成功执行 SQL 但表注入时，模块名 vs 表名不一致
4. run_test 根本没触发数据层操作（没 insert），检测不到表缺失

**AI 测试规范缺陷**：system prompt 要求 run_test，但 test.ts 模板里确实有 insert/list/get/update/delete，按理应该能检测表是否存在。那么 run_test 要么**失败了但 AI 没修**，要么**没跑**。

### 方案

**3.1 manage-data 自愈：表不存在时尝试重建**

`manage-data.ts` 的 bulk_generate / insert 等操作前，先检查表是否存在；不存在时尝试从 generated/{userId}/{moduleName}/schema.sql 读取并执行（注入 userId 前缀，与 write-file 同逻辑）。

```ts
function ensureTableExists(userId: number, moduleName: string, tableName: string): void {
  const injected = `mock__${userId}_${tableName.replace(/^mock__/, '')}`;
  const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(injected);
  if (row) return;
  // Try to heal from schema.sql
  const sqlPath = join(GENERATED_DIR, String(userId), moduleName, 'schema.sql');
  if (!existsSync(sqlPath)) {
    throw new Error(`模块数据表 ${injected} 不存在，且找不到 schema.sql，请让 AI 重新生成模块。`);
  }
  const sql = readFileSync(sqlPath, 'utf-8');
  const injectedSql = sql
    .replace(/`mock__([a-zA-Z0-9_]+)`/g, `\`mock__${userId}_$1\``)
    .replace(/(?<![`\w])mock__([a-zA-Z0-9_]+)(?![`\w])/g, `mock__${userId}_$1`);
  try { sqlite.exec(injectedSql); }
  catch (e) {
    throw new Error(`自愈失败：${(e as Error).message}。请让 AI 重新生成模块。`);
  }
}
```

在 `manageData` 入口先调用 ensureTableExists（仅对 list/insert/update/bulk_generate/delete/batch_delete/clear 操作），失败时抛带友好信息的错。

**3.2 write-file SQL 失败反馈给 AI**

当前 write-file 遇到 SQL exec 失败返回 `"File written but SQL execution failed: ..."`。这个返回值就是 tool_result，AI 能看到。需要加强：返回错误里明确指出"建议 AI 修复 schema.sql 后重新 write_file"。

此外：在 chat-runner 里 tool_result 事件的 payload 加 `success: false` 当 SQL exec 失败，让 UI 把这一步标红。write-file 当前返回 string，我们需要改成返回结构化结果。

**3.3 system-prompt 强化 run_test 规范**

追加约束：
- **run_test 失败时必须修复并重新 run_test**，失败次数 ≤ 3
- 如果 schema.sql 执行失败，**优先修 schema.sql** 然后重新 write_file
- 禁止在未通过 run_test 的情况下声明任务完成

**3.4 模块详情页表缺失的友好提示**

若 data API 返回表不存在错误，前端显示"数据表缺失 → 去对话页让 AI 修复"按钮（复用 Task 5 的重新生成按钮）。

### 测试
- 新增 T5-03：把 `mock__1_order` 重命名/删除后调用 /api/data/order/bulk-generate，应自愈并成功
- 新增 T5-04：schema.sql 不存在时，API 返回明确错误而非 500
- 回归：已有 api-data.spec.ts 的 bulk_generate 测试不变

---

## 顺序与工时

| 顺序 | Task | 工时 | 依赖 |
|------|------|------|------|
| 1 | Task 1 Toast 封装 + 替换 | 40min | 无 |
| 2 | Task 2 send() 兜底 + isGenerating | 20min | 无 |
| 3 | Task 3 表自愈 + system-prompt | 1h | 无 |

**合计**：~2h

---

## 测试策略

新增 `tests/step-ux-polish-5.spec.ts`：

| Test | 覆盖 |
|------|------|
| T5-01 | send() 流断开后 100ms 内不再显示 generating-banner |
| T5-02 | modules 非空的 assistant msg 永不显示 generating-banner |
| T5-03 | 表丢失后 bulk-generate 自愈成功 |
| T5-04 | schema.sql 缺失返回友好错误（含提示） |
| T5-05 | Toast 位置 = top-center，不被侧边栏遮挡 |
| T5-06 | use-toast 封装导出的四个方法（success/error/info/warning）可用 |

回归：所有已有测试（step-ux-polish-3/4、chat-resumable、page-chat、page-modules、navigation、e2e-flows、thinking-parser）保持全绿。

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 批量替换 toast import 破坏旧测试 | 保持 API 形状（success/error/info/warning）不变 |
| ensureTableExists 产生副作用（AI 未完成就有表）| 仅在 manage-data 入口查表，不主动创建新表（只恢复已有 schema） |
| isGenerating 新启发式误杀正在 emit cards 过程中的 running 状态 | cards 仅在 finalize 中 emit，到达前端时流已结束，判定安全 |

---

## 用户决策点

- [ ] Toast 默认 position：`top-center`（避开两侧） vs `top-right`（当前配置但渲染错）？默认 **top-center**
- [ ] run_test 失败重试上限：**3 次** 还是 **无限**？默认 3 次
- [ ] 表自愈时是否自动执行？是否需要用户确认？默认 **自动执行**（幂等操作）

---

## 不做 / 暂缓

- 更通用的 DB migration 框架（目前 schema.sql 是唯一来源即可）
- Toast 的去重/合并（vue-sonner 原生支持，不重复造）
- 自动触发 "重新生成"（仍保留按钮交互）
