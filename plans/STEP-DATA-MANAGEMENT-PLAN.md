# STEP-DATA-MANAGEMENT-PLAN

PLAN.md 依据：§6.3（详细设计 6.3.1–6.3.10）、§6.4（API）、§6.6（faker 映射）、Step 17 验收、§十三 数据流。

## 一、目标

把模块详情页 Data Tab 从占位升级为功能完备的数据管理表格：符合 §6.3 的展示/编辑/批量/扩展能力 + §6.4 的 REST API 契约。

## 二、与现状的差距

| 维度 | 现状 | 目标 |
|------|------|------|
| API 形态 | 单入口 `POST /:name/:action`（给 Agent 用） | PLAN §6.4 要求的 7 个 REST 端点 |
| 列表查询 | `manageData` 无 `list` 动作 | 支持分页、排序、筛选 |
| 单行更新 | 无 `update` | 支持部分字段 PUT |
| 单行删除 | `DELETE /:id` 走 REST 路径 | 新增（当前全是 POST） |
| 批量删除 | 无 | POST batch-delete |
| 前端 Data Tab | 占位文字 | DataTable + EditableCell + DataGenerator |
| checkbox UI | 未安装 | 需要补 shadcn-vue Checkbox |

**保留兼容**：Agent 工具 `manageData` 继续使用内部函数，不破坏 agent 工具链。

## 三、Task 拆分

### Task 1 — 后端 manage-data 扩展
**文件**：[src/server/agent/tools/manage-data.ts](src/server/agent/tools/manage-data.ts)

- 新增 `list` case：支持 `{ page, pageSize, orderBy, filter }`，走 `BaseModel.findAll`（已有方法）。orderBy 格式 `field+DESC|ASC`；filter 为 `{ field: value }` 对象，字符串走 LIKE，其他走等值。
- 新增 `update` case：`model.update(id, data)`。
- 新增 `batch_delete` case：`{ ids: number[] }`，循环 `model.delete`。
- `bulk_generate` 扩展：支持可选 `rules?: Record<string, 'faker'|'sequence'|{fixed: any}>`（PLAN §6.3.7）。
- `generateFakerValue` 补全 PLAN §6.6 的字段名智能匹配（已部分覆盖，补充 address/url/description 等缺失项）。

**验证**：新增 `tests/data-manage-data.spec.ts` 覆盖 list/update/batch_delete/bulk_generate(rules) 4 用例。

---

### Task 2 — 后端 REST API 重构
**文件**：[src/server/api/data.ts](src/server/api/data.ts)

把单入口拆为 7 个路由（§6.4）：
- `GET /api/data/:moduleName` — Query: page/pageSize/orderBy/filter[field]
- `POST /api/data/:moduleName` — Body = 行数据
- `PUT /api/data/:moduleName/:id` — Body = 部分字段
- `DELETE /api/data/:moduleName/:id`
- `POST /api/data/:moduleName/batch-delete` — Body: `{ ids }`
- `POST /api/data/:moduleName/clear`
- `POST /api/data/:moduleName/bulk-generate` — Body: `{ count, rules? }`

filter 解析：Fastify 默认把 `filter[field]=x` 解成 `{ filter: { field: 'x' } }`（qs 风格），需确认 `app.ts` 是否配置 `querystringParser`；未配置就手动解析。

**注意**：保持鉴权（authMiddleware）；所有路由通过 `userId = request.user!.id`。

**验证**：`tests/api-data.spec.ts` 对 7 条路由各发一次请求（seed 一个 module）。

---

### Task 3 — 前端 API 封装
**文件**：新建 [src/client/composables/use-data-api.ts](src/client/composables/use-data-api.ts)

导出 `useDataApi(moduleName)` — 返回 `list / create / update / remove / batchDelete / clear / bulkGenerate`，内部复用 [use-api.ts](src/client/composables/use-api.ts)。

---

### Task 4 — Checkbox 组件补齐
**文件**：新建 [src/client/components/ui/checkbox/](src/client/components/ui/checkbox/)

参考其他 shadcn-vue 组件风格新增 Checkbox（基于 reka-ui 或原生 input，保持与现有风格一致）。**先看现有 switch/select 如何实现**，复用依赖。

---

### Task 5 — DataTable 组件（核心）
**文件**：新建 [src/client/components/data/DataTable.vue](src/client/components/data/DataTable.vue)

- 使用 `@tanstack/vue-table`，`useVueTable({ columns, data, getCoreRowModel, getSortedRowModel, getPaginationRowModel, manualPagination: true, manualSorting: true, manualFiltering: true })`
- Props: `moduleName`, `fields: Field[]`（从 `_meta.json` entities[0].fields 传入）
- 工具栏：`[+ 新增] [批量生成] [清空] [列设置]` + 全局搜索
- 列头：显示名、必填 `*`、排序箭头点击切换；筛选输入栏（string 模糊 / enum 下拉 / number 范围 / date 范围）
- 行：checkbox + fields + 创建时间 + `[···]` 操作
- 底部：`共 N 条` + `[批量删除(M)]`（选中时显示）+ 分页
- 空状态 / 骨架屏
- 列宽：按类型（§6.3.2）；拖拽存 localStorage key `datatable:${moduleName}:colWidths`

- 集成 **ColumnSettings**（见 Task 5.5）：通过 tanstack 的 `state.columnVisibility / columnOrder / columnPinning` + 对应 onChange 回调接入；tanstack 原生支持这三种状态，无需额外状态机
- 冻结列 CSS：`position: sticky; left|right: 0` + z-index + 阴影分隔线，由 `column.getIsPinned()` 驱动；滚动时视觉停留

**本轮不做**：行展开、Ctrl+Z 撤销、修改历史栏——延后，PLAN §6.3.8 标为"扩展能力"。

---

### Task 5.5 — 通用 ColumnSettings 组件（新增）
**目标**：可复用的表格列配置面板；本次给 DataTable 用，后续其他表格（如请求日志 Step 20、管理员面板 Step 22）可直接复用。

**文件**：
- 新建 [src/client/components/data-table/ColumnSettings.vue](src/client/components/data-table/ColumnSettings.vue)
- 新建 [src/client/components/data-table/types.ts](src/client/components/data-table/types.ts)
- 新建 [src/client/composables/use-table-preferences.ts](src/client/composables/use-table-preferences.ts) — localStorage 持久化

**依赖新增**：`sortablejs` + `@vueuse/integrations`（`useSortable`）。理由：
- tanstack/vue-table 本身不含拖拽 UI，只管状态
- sortablejs 是业界事实标准，体积小，支持 handle / 禁用项 / 动画
- `@vueuse/integrations/useSortable` 提供 Vue 响应式封装，避免手写 ref/lifecycle
- 项目已用 @vueuse 生态，风格一致

**接口（通用 API）**：
```ts
// types.ts
interface ColumnConfig {
  id: string;             // 列 id
  label: string;          // 显示名
  visible: boolean;
  pinned: 'left' | 'right' | false;
  fixed?: boolean;        // true 表示不允许用户隐藏/移动（如 ID、actions 列）
  group?: string;         // 可选分组名
}

// ColumnSettings.vue props
{
  columns: ColumnConfig[];         // v-model
  storageKey?: string;             // 传入则自动 localStorage 持久化
  density?: 'compact'|'normal'|'comfortable';  // v-model:density
  showDensity?: boolean;
  showReset?: boolean;
  showPresets?: boolean;
}
// emits: update:columns, update:density, reset
```

**UI 结构（Popover 弹出）**：
```
┌─ 列设置 ─────────────────────────┐
│ 🔍 [搜索列名...]                  │  ← 列多时快速定位
│ [全选] [全不选] [重置默认]         │
├────────────────────────────────┤
│ 密度: (·)紧凑 ( )标准 ( )宽松     │  ← 可选
├────────────────────────────────┤
│ 📌 左固定                         │
│   ⋮⋮ ☑ ID           [📌左][📌右] │  ← ⋮⋮ 拖拽柄，📌 切换冻结
│ ─── 可滚动列 ────                │
│   ⋮⋮ ☑ 订单号       [📌左][📌右] │
│   ⋮⋮ ☐ 备注         [📌左][📌右] │
│ 📌 右固定                         │
│   ⋮⋮ ☑ 操作         [📌左][📌右] │
├────────────────────────────────┤
│ 预设: [默认视图 ▾] [💾 另存为]     │  ← 可选，多套命名配置
└────────────────────────────────┘
```

**功能清单**（用户要求 1-4 + 拓展）：
1. ✅ 显示/隐藏：每行 checkbox
2. ✅ 拖拽排序：sortablejs handle 模式，跨三个区（left/center/right）拖动即改变 pinned
3. ✅ 冻结左/右：每行两个图钉按钮切换（或拖进对应区）
4. **拓展功能**：
   - **搜索列名**（列数多时必要）
   - **全选/全不选/重置默认**
   - **密度切换**（紧凑 32px / 标准 36px / 宽松 44px 行高）— 通用表格常用
   - **命名预设**：保存多套配置（如"精简视图"/"完整视图"），localStorage 存 `tablePrefs:${storageKey}` = `{ presets: {name: config}, active: name, density }`
   - **fixed 列保护**：ID / actions 列标记 `fixed: true`，禁用 checkbox 和拖拽柄灰显
   - **受控 + 非受控双模式**：传 storageKey 自动持久化，不传则纯受控

**与 DataTable 集成**：
```ts
// DataTable.vue
const { columns, density } = useTablePreferences(`datatable:${moduleName}`, defaultConfig);
const table = useVueTable({
  state: {
    columnVisibility: computed(() => Object.fromEntries(columns.value.map(c => [c.id, c.visible]))),
    columnOrder: computed(() => columns.value.map(c => c.id)),
    columnPinning: computed(() => ({
      left: columns.value.filter(c => c.pinned === 'left').map(c => c.id),
      right: columns.value.filter(c => c.pinned === 'right').map(c => c.id),
    })),
  },
  // ...
});
```

**样式风格**：
- 完全使用现有 shadcn-vue 组件（Popover/Checkbox/Button/Input/Select/RadioGroup）
- 图标用 lucide-vue-next（GripVertical 拖拽柄、Pin 冻结、Search、RotateCcw 重置）
- 不引入新样式体系，sortablejs 的默认 ghost/drag class 用 Tailwind 覆写

**验证**：
- Playwright 单独测 ColumnSettings：勾选/反选、拖拽改序、冻结左右、搜索过滤、密度切换、预设保存加载、刷新页后持久化
- 文件：`tests/component-column-settings.spec.ts`

---

### Task 6 — EditableCell 组件
**文件**：新建 [src/client/components/data/EditableCell.vue](src/client/components/data/EditableCell.vue)

- Props: `value`, `field: Field`, `readonly`, `rowId`
- `v-if` 切换展示 `<span>` / 编辑态（按 field.type 映射 Input/Select/Switch/DatePicker/Textarea）
- 展示态 height 36px + padding，编辑态同尺寸无抖动
- 事件：blur / Enter 保存，Esc 取消，Tab 跳右（由父组件协调）
- 文本溢出 tooltip（`scrollWidth > clientWidth` 判断）
- 保存后绿色闪烁 0.3s（transition-colors + 定时器清除）
- 校验失败红边 + toast

**DatePicker**：shadcn-vue 未安装则用 `<input type="date">` 替代（PLAN 未硬性要求组件库）。
**Textarea**：点击 Cell 弹 Popover，避免撑行高。

---

### Task 7 — DataGenerator 对话框
**文件**：新建 [src/client/components/data/DataGenerator.vue](src/client/components/data/DataGenerator.vue)

- Dialog：数量 Input（默认 20） + 每字段规则下拉（faker 默认/递增序号/固定值）
- 固定值选中时展开对应类型的输入
- `[取消] [生成]` → `bulkGenerate(count, rules)` → emit 成功后父组件 refresh

---

### Task 8 — 集成到 ModuleDetailPage
**文件**：[src/client/pages/ModuleDetailPage.vue](src/client/pages/ModuleDetailPage.vue)

替换 L128-132 占位块：
```vue
<DataTable v-if="activeTab === 'data'" :module-name="moduleName" :fields="dataFields" />
```
`dataFields = moduleData.meta.entities?.[0]?.fields ?? []`。

---

### Task 9 — Playwright 测试
**文件**：新建 [tests/page-data-management.spec.ts](tests/page-data-management.spec.ts)

覆盖 PLAN Step 17 验收 7 条：
1. 表格展示 + 长文本截断 tooltip
2. Cell 无抖动编辑切换 + 值回显
3. blur 保存成功绿色闪烁
4. Tab 连续编辑；Esc 取消
5. 新增行保存
6. 批量生成 50 条成功
7. 批量删除成功

依赖：先 seed 一个模块（复用现有测试工具；如无则在 beforeAll 用 POST /api/modules 创建）。

---

### Task 10 — 回归验收
- `pnpm dev` 手动走一遍 Data Tab 全功能
- 跑全量 `pnpm test`（或 playwright 对应套件），确保 chat/module 旧测试不退化
- 更新 CURSOR.md 标记 Step Data-Management 完成并删除本子计划

## 四、风险与决策

| 风险 | 应对 |
|------|------|
| `BaseModel.findAll` 不支持 orderBy/filter | 先读 [base-model.ts](src/server/core/base-model.ts) 确认；若不支持，加参数 |
| qs filter 解析 | 若 Fastify 未启用 qs 风格，手动 `Object.entries(request.query)` 解析 `filter[xxx]` |
| Agent 旧调用破坏 | Agent 调 `manageData` 函数而非 HTTP；只要函数签名不变即安全 |
| DatePicker 缺失 | 用原生 `<input type="date">` |
| 列宽拖拽复杂 | 本 Step 先交付固定列宽（按类型），拖拽留到下一 Step；若时间允许再做 |
| sortablejs 与 Vue 响应式冲突 | 用 `@vueuse/integrations/useSortable`（官方封装），自动同步数组；避免手写 onEnd 改 ref |
| 冻结列横向阴影 | 用 `box-shadow: 2px 0 4px -2px rgba(0,0,0,.1)`（左冻结）/反方向（右冻结）；滚动位置 >0 时才加 class |
| fixed 列被误配置为可隐藏 | ColumnSettings 强制禁用 fixed 列的 checkbox 和拖拽柄；DataTable 传入时对 id/actions 列标 fixed:true |

## 五、交付物清单

- 新：`manage-data.ts` +list/update/batch_delete；`api/data.ts` 7 路由；`use-data-api.ts`；`checkbox/`；`DataTable.vue`；`EditableCell.vue`；`DataGenerator.vue`；`ColumnSettings.vue`（通用）+ `use-table-preferences.ts` + `types.ts`
- 改：`ModuleDetailPage.vue` 集成
- 依赖新增：`sortablejs`、`@vueuse/integrations`
- 测：`tests/api-data.spec.ts`、`tests/data-manage-data.spec.ts`、`tests/page-data-management.spec.ts`、`tests/component-column-settings.spec.ts`
- 文档：更新 CURSOR.md
