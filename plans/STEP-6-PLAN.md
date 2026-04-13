# Step 6: Agent 工具集 — 聚焦子计划

## 目标
实现 6 个 AI Agent 工具 + test-runner + tool-registry，使 AI 能够生成、读取、测试、管理 Mock 模块。

## Task 清单

### Task 1: test-runner.ts
**文件**: src/server/core/test-runner.ts
- 导出 `test(name, fn)` — 注册测试用例，fn 接收 ctx（含 lastId），返回值存入 ctx.lastId
- 导出 `assert` — ok/not/eq/exists 断言
- 导出 `request` — HTTP 客户端（get/post/put/delete），baseURL = http://localhost:{PORT}

### Task 2: write-file.ts + read-file.ts
**文件**: src/server/agent/tools/write-file.ts, read-file.ts
- write-file: 路径校验（禁 ../ 和绝对路径），写入 generated/{userId}/；.sql 后缀自动 db.exec()；_meta.json 自动同步 modules 表
- read-file: 路径校验，读取 generated/{userId}/ 下文件

### Task 3: run-test.ts + manage-data.ts
- run-test: 清理残留数据 → 动态 import test.ts（?t=timestamp）→ 顺序执行 → 返回结果
- manage-data: insert/bulk_generate/delete/clear 四个 action

### Task 4: list-modules.ts + delete-module.ts
- list-modules: 从 modules 系统表查询当前用户的模块列表
- delete-module: DROP 表 + 删除 generated/ 目录 + 删除 modules 记录

### Task 5: tool-registry.ts + index.ts
**文件**: src/server/agent/tool-registry.ts, src/server/agent/tools/index.ts
- 集中注册所有工具，注入 userId
- 导出 buildTools(userId) 函数
