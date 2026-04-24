# Step-Perf-1:让 MockForge 真正好用 — 提速 + 简化 + UX

> 状态:待用户确认
> 目标:AI Agent(Cursor/Claude Code)通过 MCP 调用本工具时,**速度快、工具精简、语义清晰、出错有救**;chat 端用户体验同步受益
> 原则:**试错阶段,怎么好怎么来** — API 可改可删,目的是工具更好用
> 预估:5-7 天(里程碑 M1 核心提速 3 天 + M2 简化 2 天 + M3 最终验收 1 天)

---

## 零、核心原则

1. **最终由"让 AI 跑通一个真实任务"来判定是否成功**:完成后用真实 LLM + 真实 MCP client 跑 3 个端到端场景,通不过就继续迭代
2. **每个 Task 必有测试 + 必过**:单元 / 集成 / E2E 三层覆盖;测试失败零容忍
3. **不留僵尸代码**:删就删干净,被替换的老路径不保留(否则又是新的冗余)
4. **测试本身也精简**:移除因 API 删除而失效的旧测试,不保留"测一个已经不存在的 API 是否还不存在"这种反向测试
5. **整改期间功能中断窗口为 0**:每 Task 独立 commit 且 main 始终可用
6. **不引入新 provider / 新模型**:基于现有 Doubao / gemma 等做优化

---

## 一、核心痛点(最终要被解决)

| 痛点 | 用户感受 | 本计划修复 |
|------|---------|-----------|
| 生成一个模块要 7-15 分钟 | "等到怀疑人生" | M1 提速到 3-5 分钟 |
| MCP 有 14 个工具,AI 要在 guide 里来回翻 | AI 有时选错工具 | M2 精简到 8-10 个核心工具 |
| 工具报错只说"失败"不说为什么 | AI 反复重试踩同一个坑 | M2 错误码+hint 标准化 + 增强 |
| update_module 没改东西也默默完成 | 用户不知道 AI 是不是真懂需求 | 已在 MCP-4/5 做过,M2 再打磨 |
| write_file 一次只写一个文件 | AI 写 6 次非常慢 | M1 批量 write_files 替代 |
| system prompt 18KB 每次都发 | 响应延迟大 | M1 slim + caching |
| MCP 4 个工具是 Agent 工具的薄包装(重复代码) | 维护成本高 | M2 合并 |

---

## 二、里程碑 M1 — 核心生成链路提速(3 天)

### Task M1.1 — System prompt 瘦身 + 模板外置
**目标:** 18KB → ≤7KB;AI 决策速度和响应更快

**文件:**
- `src/server/agent/system-prompt.ts`(瘦身)
- 新增 `src/server/agent/templates/samples.ts`(外置 todo 模块模板)
- 新增 Agent tool `get_module_template(kind)`(按需读,少数情况才调)

**改动:**
- 删除 L181-300 的 120 行硬编码 todo 模块 6 文件示例,搬到 `samples.ts`
- 合并冗余:L55-61 安全边界 + L103-108 禁止动作 + L114-129 最佳实践 → 单段分层表述
- 保留所有硬规则(决策流程、字段命名、响应信封、工具决策树)不改语义
- 新增短行"如需完整模块示例可调 get_module_template" 让 AI 按需拉

**删除(不保留老版本):**
- 老 system-prompt.ts 里的 120 行模板(已搬出)

**测试:**
- 更新 `tests/system-prompt.spec.ts` 断言 size < 7KB(原 SP01-SP06 保留,值需要更新)
- 更新 `tests/mcp-priority.spec.ts` P01-P07 硬规则全绿
- 新增 T-SP07:AI 请求 get_module_template('crud-basic') 能拿到完整示例(用 FAKE_AI 验证工具注册)

**commit:** `Step-Perf-1.1: slim system prompt 18KB→7KB, templates lazy-loaded`
**收益:** 每 round transport 耗时 ↓30%

---

### Task M1.2 — 批量 write_files 工具(替换 write_file)
**目标:** 6 次 LLM round-trip → 1-2 次,生成时长 ↓60%

**文件:**
- 新增 `src/server/agent/tools/write-files.ts`
- 删除 `src/server/agent/tools/write-file.ts`
- `src/server/agent/tool-registry.ts` 只注册 write_files

**改动:**
- `write_files({ files: Array<{ path, content }> })`:一次写 N 个文件
- 事务语义:stage 到临时目录 → fs.rename 原子提交 → 失败全回滚
- 继承老 write_file 的 SQL 解析 + 表同步 + _meta.json 更新逻辑
- system prompt 指引改为"用 write_files 一次写完模块 5-6 个文件"

**删除:**
- 老的单文件 `write_file` 工具彻底移除(AI 若执意调会收到 unknown tool 错误,用 system-prompt 强约束避免)

**测试:**
- 新增 `tests/write-files.spec.ts`:
  - WF01 一次写 6 个文件,所有内容磁盘可见
  - WF02 中间文件失败 → 全部回滚,磁盘无残留
  - WF03 schema.sql 的表创建同步到 SQLite
  - WF04 _meta.json 的 `entities`/`endpoints` 一次性更新
  - WF05 二次 write_files 对同模块是 "overwrite" 语义
- 更新所有使用 write_file 的既有测试(`chat-resumable`、`step-ux-polish-*`、`update-module-richdiff` 等)替换为 write_files
- `run_test` 在 write_files 产出的模块上全流程 CRUD 绿

**commit:** `Step-Perf-1.2: batch write_files with atomic transaction, remove write_file`
**收益:** 总时长 ↓60%(7-15min → 3-6min)

---

### Task M1.3 — Prompt caching(provider-aware)
**目标:** 命中缓存时 token 成本 ↓70%,首 token ↓30-50%

**文件:**
- 新增 `src/server/agent/prompt-cache.ts`
- `src/server/agent/chat-runner.ts` streamText 调用处集成

**改动:**
- 按 provider.type 分派:
  - `anthropic`:注入 `providerOptions.anthropic.cacheControl` 给 system + tools 前缀
  - `openai` / `openai-compatible`(Doubao / gemma / DeepSeek 等):确保 system + tools + history 前缀字节稳定(去时间戳等),后端自动缓存
- 不支持的 provider 自动 no-op,不报错不降级其他功能

**测试:**
- `tests/prompt-cache.spec.ts`:
  - PC01 anthropic provider 时注入 cacheControl(mock fetch 断言 request payload)
  - PC02 openai-compat provider 时不注入 anthropic 字段,不报错
  - PC03 前后两次相同 userContent 请求的 system 段字节完全相等(保证 cache 可命中)
- 完整 MCP 回归 100% 绿(功能无影响)

**commit:** `Step-Perf-1.3: provider-aware prompt caching`
**收益:** 大项目长会话 token 成本 ↓70%,首 token 延迟 ↓30-50%

---

### Task M1.4 — 并行 tool-call + 写锁保护
**目标:** 只读工具并行;写工具串行避免冲突

**文件:** `src/server/agent/chat-runner.ts`(streamText 选项 + tool 调度层)

**改动:**
- streamText 开启 `parallelToolCalls: true`
- tool-executor 层加 per-session async mutex,write_files 等写工具串行
- 只读 tool(list_modules / read_file / get_module_template / manage_data 的 list action / run_test)真正并发

**测试:**
- `tests/parallel-tools.spec.ts`:
  - PT01 AI 一次 emit 3 个 list_modules / read_file 并发 → 都成功
  - PT02 一次 emit 2 个 write_files → server 内部串行,两次都成功无覆盖
  - PT03 混合 read + write → 读并行、写按序

**commit:** `Step-Perf-1.4: parallel read tools + mutex on write tools`
**收益:** 读/诊断阶段 ↓30%

---

## 三、里程碑 M2 — 工具表面简化 + UX 打磨(2 天)

### Task M2.1 — MCP 工具精简 14→10
**目标:** AI 选择困难减少;维护成本降低

**改动:**

**合并** `get_api_doc` + `get_openapi` + `get_module_health` → 单个 `inspect_module(moduleName, view?: 'doc'|'openapi'|'health'|'all')`(默认 all)
- 一个 round-trip 拿全模块信息,AI 不需要学三个工具的区别
- 支持 `view` 选项后续按需拆分

**删除 MCP 端 4 个薄包装,改为** agent-side 调用:
- `mcp/tools/list-modules.ts` / `manage-data.ts` / `run-test.ts` / `delete-module.ts` → 保留 MCP 暴露但改为 wrapAgentTool 方式(~40 行 vs ~150 行),或直接删了让 AI 通过 `inspect_module` + chat flow 完成(看 UX 取舍)

**保留:** `create_module_from_spec` / `update_module` / `cancel_session` / `get_session_status` / `diff_with_openapi` / `get_mock_access_log` / `generate_handoff_report` / `inspect_module`(+ 可能 `manage_data` 做数据管理)= 8-9 个

**测试:**
- `tests/mcp-inspect-module.spec.ts`:
  - IM01 view='all' 返回 doc + openapi + health 三段
  - IM02 view='doc' 只返 doc
  - IM03 view='health' 只返 health 状态
  - IM04 模块不存在返 MODULE_NOT_FOUND
- 更新 `mcp-server-v2.spec.ts` 的 M30 工具列表(14→ 新数量)
- 删除被移除工具的旧测试

**commit:** `Step-Perf-1.5: merge get_api_doc/openapi/health into inspect_module, prune MCP tool count`
**收益:** AI 决策压力 ↓,guide 简短化,维护成本 ↓40%

---

### Task M2.2 — 写工具去重:update / create 合并逻辑
**目标:** 消除 [update-module.ts](../src/server/mcp/tools/update-module.ts) 和 [create-module-from-spec.ts](../src/server/mcp/tools/create-module-from-spec.ts) 70% 同构代码

**文件:**
- 新增 `src/server/mcp/lib/write-tool-runner.ts`:抽公共 `runWriteTool(opts)` 处理 in-flight 检查 / concurrency gate / onConflict / attach-resume / 错误映射 / response 构造
- update-module.ts 和 create-module-from-spec.ts 瘦身到每个 ~80 行(只留差异化的 userContent 构造和 terminal response 的特有字段)

**测试:** 保持原 AR01-AR08 / E01-E03 全绿(纯重构无语义变化)

**commit:** `Step-Perf-1.6: extract write-tool-runner, shrink update+create by 60%`

---

### Task M2.3 — 三道 gate 合并 + module-repo + 错误增强
**文件:**
- 新增 `src/server/mcp/lib/session-coordinator.ts`(合并 concurrency-gate + in-flight-lock)
- 新增 `src/server/core/module-repo.ts`(封装 12 处散落的模块行 / meta.json 读取)
- 增强 [error-codes.ts](../src/server/mcp/lib/error-codes.ts):每个 code 附 **recovery_steps**(AI-actionable 下一步 tool 调用建议,非自然语言 hint)

**改动:**
- concurrency-gate.ts / in-flight-lock.ts 废弃,代码删除或变成 thin re-export
- `mcpError({ code, ... })` 自动根据 code 注入对应 recovery_steps
- retry-counter 保留(软 warning 语义独立)

**测试:**
- 原 CC01-CC05 / D01-D04 全绿
- 新增 `tests/mcp-error-recovery.spec.ts`:每个 error code 的 recovery_steps 内容存在且指向有效工具

**commit:** `Step-Perf-1.7: SessionCoordinator + module-repo + error recovery_steps`

---

### Task M2.4 — 流程 UX 打磨(chat + MCP 双端)
**目标:** 针对用户实测过的痛点,补齐最后一公里

**改动:**
- **Chat 端**:生成过程的进度事件更贴近人话 — 现在 "tool:write_file"、"tool:run_test" 偏工程化,改成 "正在写入模块文件..."、"正在运行测试..."(改 [chat-runner.ts](../src/server/agent/chat-runner.ts) stage label)
- **MCP 端**:`progress notification` 改为 AI 能理解的动作词(例:"generating_controller" / "creating_tables" / "validating"),而不是内部 tool name
- **统一错误描述**:所有 mcpError 的 text 开头加一个 emoji 或标记(例 `[NOT_FOUND]` / `[BUSY]` / `[TIMEOUT]`)方便 AI 快速识别
- **still-running 响应增强**:加一个 `expectedRemainingSec`(根据 stage 估算)和 `suggestedNextAction`("再调一次即可续接" / "用 cancel_session 放弃" 二选一)

**测试:**
- 更新 progress event 相关现有测试
- `tests/ux-progress.spec.ts`:
  - UX01 chat 进度事件不含 tool 内部名
  - UX02 MCP progress message 含 AI 友好动作词
  - UX03 still-running 响应含 expectedRemainingSec + suggestedNextAction
  - UX04 所有错误 text 前缀含 `[CODE]` 标记

**commit:** `Step-Perf-1.8: humanize progress events, enrich error text, still-running hints`

---

## 四、里程碑 M3 — 最终 E2E 验收(1 天)

### Task M3.1 — 真实 LLM 端到端场景回归
**目标:** 用户最终会让 AI Agent 调 MCP,所以我必须先跑通

**场景(真实 LLM 用 admin 的免费 gemma provider):**

1. **E2E-1 全新创建 + 业务闭环**
   - MCP 调 `create_module_from_spec` 生成一个"订单管理"模块(真实自然语言 spec)
   - 断言:< 5 分钟内完成、返回 mockBaseUrl、/mock/order GET 返 200、POST 创建一条记录返 success:true

2. **E2E-2 timeout 续接**
   - 以 waitMaxSec=10 调 update_module(大改动)
   - 断言 still-running
   - 立即重发同 args → 断言 attached:true → 最终拿到 updated

3. **E2E-3 出错 + 恢复**
   - 故意传一个引发 ValidationError 的 spec
   - 断言:错误码正确、recovery_steps 指向具体下一步工具
   - AI(用 fake sentinel 模拟)按 recovery_steps 修复重试 → 成功

**测试文件:** `tests/mcp-e2e-real-llm.spec.ts`(打 tag `@real-llm`,默认不跑,手动触发:`pnpm test:real-llm`)

**验收门槛:**
- 上述 3 个场景**单跑 + 串跑**都绿
- 完整 Playwright 回归(含原 430+ 测试)100% 绿
- 手动 Cursor 里配 MCP → 让 Claude Code 跑一次"帮我生成一个任务管理模块"→ 能成、<5min、返回可用 mockBaseUrl

**commit:** `Step-Perf-1.9: real-LLM E2E suite for final acceptance`

---

### Task M3.2 — 文档 + 交接(同步)
**文件:** docs/mcp-usage.md / CURSOR.md / PROGRESS.md

**改动:**
- 更新工具数(14 → 新数量)和工具分类(读/写/诊断/会话/汇报)
- `docs/mcp-usage.md` 加新章节"为什么这么快"讲 prompt caching + 批量写 + 并行
- CURSOR.md / PROGRESS.md 记录 Step-Perf-1 变更摘要
- 删除 plans/STEP-PERF-1-PLAN.md

**commit:** `Step-Perf-1: final docs + progress bookkeeping`

---

## 五、每 Task 的测试要求(通用)

每个 Task 在 commit 前必须:

1. ✅ **新测试**:本 Task 新增的功能 100% 覆盖
2. ✅ **既有测试**:相关既有测试 100% 绿(含被删 API 对应的测试一同清理)
3. ✅ **完整回归**:`playwright test` 完整套件 100% 绿(除 CURSOR.md 登记的已知 flaky)
4. ✅ **真实 LLM 冒烟**:M1.2 / M1.3 / M1.4 / M3.1 必须跑一次真实 LLM 的 create + update 流(不是只 __fake__)
5. ✅ **手动 UX 观察**:chat 页生成一条模块,观察进度词是否人话、时长是否在预期

---

## 六、风险与缓解

| 风险 | 缓解 |
|------|------|
| batch write_files 事务回滚在 Windows fs 不原子 | 用 fs.rename(Windows 上 rename 同盘原子);失败保留 temp dir 便于调查;测试覆盖半成功回滚 |
| prompt 瘦身后 AI 漏掉某条硬规则 | mcp-priority 的 P01-P07 每次必跑;真实 LLM E2E 场景 E2E-1 能暴露 |
| 删除老 write_file 后某处测试漏改 | 每 Task 完整回归兜底;CI 本身会挂 |
| inspect_module 合并三工具后某 client 仍在用老名字 | 工具删除是破坏性变更,但试错阶段用户可接受;文档清楚说明;MCP client 会收到 unknown tool 错误提示去查 guide |
| 并行 tool-call 导致 race | mutex 保护 + PT02 测试;如果真出问题 feature 代码可以 O(1) 改回串行 |
| 真实 LLM 偶发不稳定 | retries=2 + 失败记录详情;3 次 retry 仍失败视为 bug |

---

## 七、预期最终状态

| 维度 | 改造前 | M1 完成 | M2 完成 | M3 完成(最终) |
|------|--------|---------|---------|-----------------|
| 生成 6 文件模块时长 | 7-15 min | 3-6 min | 3-5 min | **3-5 min** |
| LLM round-trip 次数 | 5-6 | 1-2 | 1-2 | 1-2 |
| system prompt 体积 | 18 KB | 7 KB | 7 KB | 7 KB |
| token 成本(缓存命中) | 100% | 30% | 30% | 30% |
| MCP 工具数 | 14 | 14 | **8-10** | 8-10 |
| 代码总行数 | ~4500 | ~4400 | **~3600** | ~3600 |
| 原测试通过 | 430+ | 430+ | 430+ | **430+ 不减** |
| 新增测试 | — | ~20 | ~15 | ~10(E2E) |

---

## 八、如果用户实测后还觉得不够快/不够好用

预留后手(Step-Perf-2,本计划不做):
- Sampling 优化(MCP 协议 sampling,让 server 反向问 client AI,减少 round-trip)
- Speculative decoding / draft model
- 模块生成结果缓存(同模块名 + 同 spec 命中秒返)
- Thinking 预算自适应(简单 update 禁用 thinking)

---

## 九、开始时机

等你确认后从 **Task M1.1(system prompt 瘦身)** 开始 — 这是风险最低、收益最直接的起点。

每个 Task 完成后我会:
1. 跑完整回归 + 报结果
2. 更新本计划的 Task 状态栏
3. commit + 进入下一 Task

如果某 Task 失败超 3 轮自修,暂停报告用户。

完。
