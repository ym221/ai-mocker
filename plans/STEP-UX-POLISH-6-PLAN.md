# STEP-UX-POLISH-6 计划

## 用户反馈（3 项）

| # | 问题 | 根因 |
|---|------|------|
| 1 | 删除确认弹窗用的浏览器原生 confirm()，样式丑且阻塞线程 | 6 处 `confirm()` 未替换为自定义组件 |
| 2 | Toast 消息仍在页面底部显示 + 删除后出现滚动条 | vue-sonner position prop 可能未生效；需验证并换 CSS 方案兜底 |
| 3 | 日志模块批量生成报 no such table: mock__1_log | AI 生成的 schema.sql 表名 `mock__logs` 与 _meta.json 的 `mock__log` 不一致；ensureTableExists 自愈后仍找不到 |

---

## Task 1 — 封装 ConfirmDialog + 替换全部 6 处 confirm()

### 方案

**新建** `src/client/components/ui/confirm-dialog/ConfirmDialog.vue`（基于 reka-ui AlertDialog）

```vue
<AlertDialogRoot v-model:open="open">
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogContent>
      <AlertDialogTitle>{{ title }}</AlertDialogTitle>
      <AlertDialogDescription>{{ description }}</AlertDialogDescription>
      <AlertDialogCancel>取消</AlertDialogCancel>
      <AlertDialogAction @click="onConfirm">确定</AlertDialogAction>
    </AlertDialogContent>
  </AlertDialogPortal>
</AlertDialogRoot>
```

**新建** `src/client/composables/use-confirm.ts`（Promise-based API）

```ts
const { confirm } = useConfirm();
const ok = await confirm({ title: '确定删除？', description: '不可撤销' });
if (!ok) return;
```

实现思路：provide/inject 一个全局 ConfirmDialog + resolve/reject Promise。

**替换 6 处**：
- ModulesPage.vue:51 — 删除模块
- SettingsPage.vue:73 — 删除 provider
- SettingsPage.vue:124 — 删除 preset
- DataTable.vue:211 — 删除单行
- DataTable.vue:225 — 批量删除
- DataTable.vue:237 — 清空

---

## Task 2 — Toast 位置修复

### 根因

vue-sonner ^2.0.9 的 Toaster `position` prop 是生效的（data-y-position=top 已确认），但渲染出的 `<ol>` 实际定位可能被某些全局 CSS 或 Tailwind reset 影响。

### 方案

显式在全局 CSS 中加 `[data-sonner-toaster][data-y-position="top"]` 定位规则，确保覆盖。

```css
[data-sonner-toaster][data-y-position="top"] {
  top: 32px !important;
  bottom: auto !important;
}
```

---

## Task 3 — 日志模块表名不一致修复

### 根因

AI 创建模块时 _meta.json 的 `entities[0].tableName` 和 schema.sql 的 `CREATE TABLE` 表名不一致（如 `mock__log` vs `mock__logs`）。当前 ensureTableExists 执行 schema.sql 后用 _meta.json 的表名检查，自然找不到。

### 方案

**ensureTableExists 增强**：执行 schema.sql 后，不再只检查 _meta.json 指定的表名，改为查 `sqlite_master` 里所有 `mock__{userId}_%` 前缀的新建表，若有任何匹配则视为成功。

**更聪明的策略**：如果 schema.sql 里的表名和 _meta.json 不一致，自动修正 _meta.json 的 tableName 字段。

---

## 执行顺序

| # | Task | 工时 |
|---|------|------|
| 1 | ConfirmDialog + 替换 6 处 | 1h |
| 2 | Toast 位置 CSS 兜底 | 10min |
| 3 | ensureTableExists 增强 | 20min |
| 4 | 测试 + 全量回归 | 30min |
