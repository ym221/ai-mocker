# Step 2: 数据库 + Schema — 聚焦子计划

## 目标
配置 SQLite + Drizzle ORM，定义 7 张系统表的 schema，启动时自动建表。

## 前置条件
- Step 1 已完成：better-sqlite3、drizzle-orm、drizzle-kit、@types/better-sqlite3 已安装
- .env 中 DB_PATH=./data/mockforge.db

## Task 清单

### Task 1: database.ts — SQLite 连接 + Drizzle 配置
**文件**: src/server/core/database.ts
**关键细节**:
- 使用 better-sqlite3 创建 SQLite 连接
- 从 .env 读取 DB_PATH（默认 ./data/mockforge.db）
- 自动创建 data/ 目录（如不存在）
- 启用 WAL 模式（性能优化）
- 导出 drizzle 实例和原始 db 实例
- 开启 foreign_keys pragma
**验收**: import database.ts 不报错

### Task 2: schema.ts — 7 张系统表定义
**文件**: src/server/core/schema.ts
**表定义**:

1. **users**: id(int pk auto), username(text not null unique), password_hash(text not null), display_name(text), role(text not null default 'user'), is_active(int default 1), created_at(text default datetime('now')), updated_at(text default datetime('now'))

2. **providers**: id(int pk auto), name(text not null), type(text not null), api_key_encrypted(text), base_url(text), default_model(text not null), scope(text not null default 'private'), owner_id(int ref users), is_verified(int default 0), is_active(int default 1), created_at, updated_at

3. **presets**: id(int pk auto), name(text not null), description(text), content(text not null), scope(text not null default 'private'), owner_id(int ref users), is_active(int default 1), created_at, updated_at

4. **sessions**: id(text pk uuid), title(text default '新对话'), user_id(int ref users), provider_id(int ref providers), model(text), preset_id(int ref presets), module_name(text), created_at, updated_at

5. **messages**: id(int pk auto), session_id(text not null ref sessions on delete cascade), role(text not null), content(text), tool_calls(text json), attachments(text json), created_at

6. **modules**: id(int pk auto), name(text not null), user_id(int ref users), display_name(text not null), description(text), base_path(text not null), status(text default 'active'), created_at, updated_at, UNIQUE(name, user_id)

7. **mock_requests**: id(int pk auto), user_id(int ref users), module_name(text not null), method(text not null), path(text not null), status_code(int), duration_ms(int), request_body(text), response_body(text), created_at

**验收**: schema.ts 导出所有 7 张表的 Drizzle table 定义，TypeScript 编译无错

### Task 3: 启动时自动建表 + 验证
**操作**:
- 在 server.ts 启动流程中调用 database 初始化
- 使用 drizzle-kit push 或在代码中直接执行 CREATE TABLE IF NOT EXISTS
- 启动后验证 7 张表存在
**验收**: `pnpm dev:server` 启动后，data/mockforge.db 文件生成，包含 7 张系统表

## 编码规范
- Drizzle schema 使用 sqliteTable 定义
- 字段名 snake_case（数据库层）
- 导出类型 InferSelectModel / InferInsertModel

## 回归检查
- pnpm dev:server 仍能正常启动
- /api/health 仍返回 ok
