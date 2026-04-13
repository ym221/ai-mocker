# Step 3: BaseModel — 聚焦子计划

## 目标
实现通用 CRUD Model，为 AI 生成的 Mock 数据表提供统一的数据操作接口。

## 前置条件
- database.ts 已提供 sqlite 实例
- Mock 表命名规则：mock__{userId}_{表名}
- userId 通过 AsyncLocalStorage 传递

## Task 清单

### Task 1: AsyncLocalStorage 上下文 + BaseModel 核心实现
**文件**: src/server/core/base-model.ts
**API**:
- `new BaseModel('mock__{表名}')` — AI 只写 mock__+表名，实际表名由 BaseModel 自动拼接 userId 前缀
- `findAll({ page, pageSize, where, orderBy })` → `{ list, total, page, pageSize }`
- `findById(id)` → Record | null
- `create(data)` → Record（自动 camelCase→snake_case，自动 id/created_at/updated_at）
- `update(id, data)` → Record（自动更新 updated_at）
- `delete(id)` → boolean
- `count(where?)` → number
- `raw(sql, params?)` → any[]

**where 条件解析**:
- 直接值: `{ status: 'active' }` → `WHERE status = ?`
- like: `{ name: { like: '%test%' } }` → `WHERE name LIKE ?`
- gt/lt/gte/lte: `{ age: { gt: 18 } }` → `WHERE age > ?`
- in: `{ status: { in: ['a','b'] } }` → `WHERE status IN (?,?)`
- 多条件 AND 连接

**camelCase ↔ snake_case**:
- 写入时 camelCase → snake_case（如 orderNo → order_no）
- 读取时 snake_case → camelCase（如 order_no → orderNo）

**AsyncLocalStorage**:
- 导出 mockContext: AsyncLocalStorage<{ userId: number }>
- BaseModel 构造时从 mockContext 读取 userId
- 实际表名 = `mock__{userId}_{originalTableSuffix}`

### Task 2: 验证
**操作**: 启动后端，确认 import 无报错，基本逻辑可执行
**验收**: TypeScript 编译通过，pnpm dev:server 正常启动
