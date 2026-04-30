# Step-Observability-1: 模块生成全链路日志 + 前端可视化

> **状态**: 设计草案,等用户最终确认后执行
> **前置上下文**: `plans/CONTEXT-WORKFLOW-NEXT.md`
> **目标**: 把 8min 的真实时间分配看清楚,识别真正瓶颈

---

## 一、目标

回答一个具体问题: **生成一个简单模块的 8 分钟,究竟花在哪?**

成功标志: 任务跑完后,在前端打开模块详情页 → 切到"执行日志" tab → 能一眼看到:
- 总耗时 = X min Y sec
- 各阶段占比(LLM 思考 / 文件写入 / SQL 执行 / run_test / 修复循环)
- 每次"修复"被触发的原因 + 修复了哪些文件 + 第几次成功
- 每个工具调用的耗时和参数摘要
- LLM 每轮 round-trip 的 token 消耗(可选)

---

## 二、硬约束(绝对不能违反)

1. **不影响功能** — 加日志不能改变任何现有逻辑分支、不能改 LLM 行为、不能改文件落盘内容
2. **不影响速度** — 性能开销 < 5%(对 8min 任务即 < 24s)。具体:
   - 不引入新的同步阻塞操作
   - 不在 LLM 调用链路上加同步 IO
   - 日志写入走异步 / 批量 / 复用现有 message_events 表
3. **不冗余** — 不新建表(用现有 `message_events`)、不新加 MCP 工具、不动 chat-runner 主循环结构,只加 emit 点
4. **失败兜底** — 日志写入失败必须静默,不能让主任务报错

---

## 三、设计方案

### 3.1 后端: 复用 message_events 扩展事件

**不新建表**。 `src/server/core/schema.ts:82` 的 `message_events` 已经在记录 thinking/tool_call/tool_result/error/done。我们只在 payload 里加细粒度字段。

#### 新增 event types(只新增,不改动现有)

| type | 触发时机 | payload(JSON)关键字段 |
|------|---------|-------------------|
| `phase_start` | 每个逻辑阶段开始 | `phase` (枚举见下), `ts` |
| `phase_end` | 每个逻辑阶段结束 | `phase`, `ts`, `durationMs`, `outcome` ('ok' / 'failed' / 'partial') |
| `repair_triggered` | 检测到失败 → 决定修复 | `cause` ('sql_exec_failed' / 'run_test_failed' / 'write_failed' / 'spec_invalid' / 'meta_parse_error'), `attempt` (第几次), `targetFiles` (string[]), `errorSnippet` (≤500 字符) |
| `tool_timing` | 每次工具调用完成后补记 | `toolName`, `startedAt`, `finishedAt`, `durationMs`, `argSummary` (脱敏), `resultSummary` ('ok' / 'error' + 简述) |
| `llm_round` | 每轮 LLM 完成后 | `round` (第几轮), `ttftMs` (首 token 延迟), `totalMs`, `inputTokens?`, `outputTokens?`, `model?` |

#### Phase 枚举(覆盖典型 8min 流程)

```
prompt_build       — 构建 system prompt + moduleList + preset
llm_thinking       — LLM 思考阶段(一次或多次)
write_files        — 一次 write_files / write_file 落盘
sql_execute        — schema.sql 执行
run_test           — 跑测试
repair_loop        — 修复循环(整体)
finalize           — 收尾(注册 mock 路由 / 落 modules 表)
```

#### emit 点位(代码改动清单)

| 文件 | 改动 | 行数估计 |
|------|------|---------|
| `src/server/agent/chat-runner.ts` | 主循环每个 step 前后 emit `phase_start/phase_end`、`llm_round` | ~50 行 |
| `src/server/agent/tools/write-files.ts` | 入口 emit `tool_timing`,内部 SQL 执行段单独 emit `phase_start('sql_execute')` | ~20 行 |
| `src/server/agent/tools/write-file.ts` | 同上,单文件版 | ~10 行 |
| `src/server/agent/tools/run-test.ts` | 入口 / 出口 emit `tool_timing` + `phase_start/end('run_test')` | ~15 行 |
| `src/server/mcp/lib/write-tool-runner.ts` | 修复循环触发处 emit `repair_triggered`(传 cause / attempt / targetFiles) | ~20 行 |
| `src/server/agent/system-prompt.ts` | 不改 | 0 |
| **新增** `src/server/core/observability.ts` | 统一 emit helper,封装"塞进 message_events 但永不抛错" | ~50 行 |

**关键: emit helper 必须 fire-and-forget**。
```ts
// 伪代码
export function emitObservability(sessionId, type, payload) {
  setImmediate(() => {
    try { db.insert(messageEvents).values({...}).run(); } catch { /* 静默 */ }
  });
}
```

### 3.2 后端: 时间线查询 API

新增 `GET /api/sessions/:id/timeline`:
- 读 message_events 全量(按 seq 排序)
- 服务端聚合成阶段视图:
  ```ts
  {
    sessionId, totalMs, startedAt, finishedAt,
    phases: [{phase, startMs, durationMs, outcome, children?}],
    tools: [{toolName, count, totalMs, avgMs}],
    repairs: [{attempt, cause, targetFiles, errorSnippet}],
    llmRounds: [{round, ttftMs, totalMs, tokens?}],
    rawEvents: [...] // 原始事件供详细视图
  }
  ```
- 路由: `src/server/api/sessions.ts`(若已存在则扩展,不存在则新建一个 route 文件)

### 3.3 前端: 模块详情页加 Tab

**位置**: `src/client/pages/ModuleDetailPage.vue:263-281` 现有 tabs(endpoints/data/doc)右侧加一个 `执行日志`。

**视图分两层**:

**Top: 总览面板**
- 总耗时大字 + 阶段占比横条(类似 Chrome DevTools 的 timeline)
- 关键统计: 修复次数 / LLM 轮次 / 总 tokens
- 颜色: 思考(蓝) / 写盘(绿) / SQL(黄) / 测试(紫) / 修复(红)

**Bottom: 时间轴列表**
- 按时序展示每个 event,点击展开看 payload
- 修复事件高亮红色,展示 cause + errorSnippet
- 工具调用展示参数摘要(脱敏)

**实现**:
- 新增 `src/client/components/observability/TimelineView.vue` (~200 行)
- 新增 `src/client/components/observability/PhaseBar.vue` (~80 行,纯 CSS 横条)
- 调用 timeline API,无需第三方图表库(避免引入依赖)

**只在 tab 激活时拉数据**(避免影响默认页加载速度)。

---

## 四、Task 拆分

### Task 1: observability emit helper + schema 扩展

**改动**:
- 新建 `src/server/core/observability.ts` — 统一 emit 函数,fire-and-forget,失败静默
- `src/server/core/schema.ts` 不改表结构,只在注释里补充新 event types 列表(给后人看)

**测试**:
- `tests/observability-emit.spec.ts` — 验证 emit 不抛错 / 不阻塞 / 失败静默

### Task 2: chat-runner 接入 emit

**改动**:
- `src/server/agent/chat-runner.ts` 在 step 边界 emit `phase_start/phase_end` + `llm_round`
- TTFT 记录: 监听首 token 时间戳

**测试**:
- `tests/chat-runner-observability.spec.ts` — 跑一个简单 session,验证事件序列完整、时间戳合理

### Task 3: 工具层接入 emit

**改动**:
- `write-files.ts / write-file.ts / run-test.ts` 入口出口埋点
- `write-tool-runner.ts` 修复触发点埋点(关键:抓 cause)

**测试**:
- `tests/tool-timing.spec.ts` — 验证每次工具调用产生 `tool_timing` 事件
- `tests/repair-trigger.spec.ts` — 故意制造 SQL 失败,验证 `repair_triggered` 事件含正确 cause

### Task 4: timeline 聚合 API

**改动**:
- `src/server/api/sessions.ts` 加 `/sessions/:id/timeline` route
- 服务端聚合逻辑 — 把 raw events 折叠成 phases/tools/repairs/llmRounds 四类

**测试**:
- `tests/timeline-api.spec.ts` — 给定一组 mock events,验证聚合结果正确

### Task 5: 前端 Tab + Timeline 组件

**改动**:
- `ModuleDetailPage.vue` 加 tab 按钮 + 内容区
- 新建 `TimelineView.vue` + `PhaseBar.vue`
- 调 timeline API,渲染总览 + 时间轴

**Playwright 测试**:
- `tests/observability-ui.spec.ts` — 跑一次模块生成 → 打开 tab → 验证关键元素可见、点击 event 能展开 payload

### Task 6: 性能基准 + 集成验收

**目标**: 证明硬约束 2 不被违反。

**做法**:
- 加日志前,跑同一个简单模块生成 3 次,记录均值 T0
- 加日志后,跑同样 3 次,记录均值 T1
- 验证 (T1 - T0) / T0 < 5%

**输出**: 一份 `OBSERVABILITY-BASELINE.md`(放 plans/ 下),记录:
- T0 / T1 数据
- 第一次真实数据下 8min 的实际分配(把 phases 占比贴出来)
- 这份数据直接驱动 `CONTEXT-WORKFLOW-NEXT.md` 的 Q1 决策

---

## 五、文件改动总览

### 新增
- `src/server/core/observability.ts`
- `src/server/api/sessions.ts`(若不存在)/ 扩展 timeline route
- `src/client/components/observability/TimelineView.vue`
- `src/client/components/observability/PhaseBar.vue`
- `plans/OBSERVABILITY-BASELINE.md`(Task 6 产出)

### 改动
- `src/server/agent/chat-runner.ts` — emit 点位
- `src/server/agent/tools/write-files.ts` / `write-file.ts` / `run-test.ts` — emit 点位
- `src/server/mcp/lib/write-tool-runner.ts` — 修复触发埋点
- `src/client/pages/ModuleDetailPage.vue` — 加 tab

### 不改
- 任何 LLM prompt
- 任何工具的入参 / 出参 schema
- message_events 表结构
- 现有所有测试用例的预期

---

## 六、验收清单

- [ ] 跑一次完整模块生成,前端 timeline tab 能看到完整阶段分解
- [ ] 修复事件能看到 cause + errorSnippet + 第几次重试
- [ ] 工具调用耗时统计正确(spot check 几个工具的 durationMs 跟 console.time 对得上)
- [ ] 性能开销 < 5%(Task 6 数据)
- [ ] **关键**: 拿到典型 8min 任务的真实时间分配,写入 OBSERVABILITY-BASELINE.md
- [ ] 全套回归测试 100% 绿(零容忍规则)
- [ ] CURSOR.md 更新至本 Step 完成状态
- [ ] 删除本 STEP-OBSERVABILITY-1-PLAN.md → 归档进 PROGRESS.md

---

## 七、用户最终确认前的待回答问题

执行前请用户回答这 4 个,避免执行中卡壳:

1. **timeline tab 是否对所有用户可见,还是只在某种"开发者模式"下展示?**(影响是否要加权限/开关)
2. **修复触发的 errorSnippet 是否会暴露敏感信息(如 prompt 片段)?是否需要脱敏?**
3. **LLM token 统计是否必须?**(SDK 不一定提供,如果要做需要从 streamText usage 字段里取)
4. **历史已完成的 sessions(没有这些 emit 点的)在 timeline tab 显示什么?** — 建议显示"无详细数据,本会话早于日志能力"

---

## 八、不做什么(明确避免冗余)

- 不做实时流式更新(SSE / WebSocket)— polling 足够,任务跑完了再看
- 不做跨 session 性能聚合 dashboard — 当前需求只是看单个任务的分配
- 不做 export / 分享功能 — 调试用,不必
- 不引入第三方图表库(d3/echarts)— 一个 PhaseBar 用 div + flex 就够
- 不做日志保留策略 / 自动清理 — message_events 已有的清理策略够用
