# Workflow 简化讨论 · 暂存上下文

> **状态**: 暂停。等 Step-Observability-1 落地、观测到 8min 真实分配后,接着这份上下文继续讨论。
> **不要直接执行此文档里的任何方案** — 它是讨论快照,不是计划。
> **关联文件**:
> - `plans/STEP-OBSERVABILITY-1-PLAN.md`(下一步要做的:加日志,先观测)
> - `plans/STEP-WORKFLOW-1-PLAN.md`(已废弃,过度设计,准备删)
> - `plans/STEP-WORKFLOW-MASTER-PLAN.md`(待用户确认是否一并删)

---

## 一、讨论的起点

用户测试中发现:**生成一个简单模块需要 ~8 分钟**。

最初想让 user 端 AI agent 在调用 MCP 时:
- 知道这个任务 5-15min,自己决定怎么调度(开 sub-agent / poll / 异步等)
- 提前拿到接口文档(api-doc),不用等完整 implementation,就能开始写业务代码
- 用户已有接口文档时,user agent 直接用自己的,无需等

讨论中确认: **8 分钟不是常规 LLM 生成耗时**, 大概率是修复循环堆出来的。在不知道时间分配前,任何拆分/优化都是猜测,所以先做观测。

---

## 二、已达成的共识(不变项)

这些是讨论中明确否定 / 肯定的,继续讨论时无需推翻:

### ❌ 不做的事

| 否定项 | 原因 |
|--------|------|
| spec ownership / specSource / specHash / lock 模型 | 派生品装 ACL,过度设计。"覆盖即更新"足够 |
| `commit_spec` / `lint_spec` / `wait_for_milestone` 三个独立工具 | 工具数膨胀,本质能用现有 `inspect_module` + 内部 hook 解决 |
| milestone 事件总线 / 订阅机制 | poll `inspect_module` 派生字段更简单 |
| 两轮 LLM session(round 1 写 spec → round 2 写 impl) | 失真风险高(round 2 LLM 丢上下文)、多一次 LLM spinup 反而更慢 |
| MCP 服务管 user agent 调度(sub-agent / 异步) | 不该是 MCP 操心的事,只需在响应里给 timing 提示 |
| `update_module` 加 overrideSpec / 各种权限分支 | 改成无条件文件级硬规则:`update_module` 永远不动 `_meta.json / api-doc.md / openapi`,要改 spec 就走 `create_module_from_spec` 重写 |

### ✅ 确定要做的事(等观测后再决定具体怎么做)

| 肯定项 | 备注 |
|--------|------|
| 让 user agent 自己负责 spec ↔ requirement 对齐验证 | MCP 没用户的需求上下文,语义验证只能在 user agent 那边做。靠 prompt 强约束 |
| 增加 `mockforge://workflow-guide` resource | 教 user agent SOP + 决策树 + timing 契约。dumb tools + smart prompts |
| `inspect_module` 派生字段 `specReady` / `implReady` | 用现有 `_meta.json` + 文件存在 + 完整性派生,不新加表字段 |
| `create_module_from_spec` 加 bring-your-own 分支 | 用户给完整 OpenAPI 时直接落盘,跳过 LLM 生成 spec 阶段 |
| 文件级硬边界 | `write_files` 拦截:某些场景下禁止修改 spec 文件 |

---

## 三、未决问题(等观测数据再判断)

这些问题需要 Step-Observability-1 完成后,看真实数据再做决定:

### Q1: 8 分钟究竟花在哪里?

候选拆解(先验猜测,等数据验证):
- LLM 思考 + 写 5 个文件: ~60-90s
- 第一次 run_test 失败 → 修复 → 再跑: 每轮 1-3min
- 平均 2-3 轮修复: 加起来 3-9min
- 总和 ~5-10min,跟实测 8min 量级吻合,但**比例未知**

如果观测到:
- **(A) spec 阶段在前 1-2 分钟就完成,后面全是 impl + 修复** → 提前暴露 spec 价值大,值得做"两批 write_files"分阶段
- **(B) spec / impl / 修复混杂,没有清晰边界** → 优先级转向"减少修复循环"(修 schema validator / prompt / template),不做 spec 提前暴露
- **(C) 修复占比极高(>60%)** → 根本问题是生成质量,提前拿 spec 也救不了 8min,优先优化 prompt + 模板

### Q2: 是否需要"一轮 LLM + 两批 write_files"?

仅在 Q1 结果是 (A) 时才有意义。如果是 (B) / (C),这个改动属于伪优化。

### Q3: bring-your-own 分支是否必须?

取决于:
- user agent 真实使用场景里,有几成是"用户已有完整 OpenAPI"
- 跳过 spec 阶段能省多少秒(估计 30-60s,跟 8min 比是小头)

**可能结论**: 优先级低于减少修复循环。

### Q4: workflow-guide resource 内容

要等 Q1-Q3 决定后才能写最终版,因为 timing 契约 / 决策树都依赖真实数据。

---

## 四、当前代码现状摘记(避免下次讨论时重新探查)

| 事实 | 位置 | 说明 |
|------|------|------|
| MCP 工具列表 | `src/server/mcp/tools/` | 13 个工具,见 `index.ts`。`inspect_module` 已支持 view: 'all'/'doc'/'openapi'/'health' |
| api-doc 不是分阶段生成 | `src/server/agent/system-prompt.ts:60-66` | 当前 prompt 强制"一轮写全 5 文件",api-doc 跟 controller 同时落盘 |
| 写文件原子性 | `src/server/agent/tools/write-file.ts:145` / `write-files.ts:193` | `writeFileSync` 同步写,单文件原子。`write_files` 批写按数组顺序跑 `writeFileSync`,毫秒级 |
| message_events 表已存在 | `src/server/core/schema.ts:82` | 已记录 thinking/tool_call/tool_result/error/done 等。**新加细粒度日志只需扩展 payload,不需新表** |
| 前端模块详情页 tab 结构 | `src/client/pages/ModuleDetailPage.vue:263+` | 当前 tabs: endpoints / data / doc。加新 tab 不复杂 |
| chat-runner 主循环 | `src/server/agent/chat-runner.ts:733` | `stopWhen: stepCountIs(40)`。修复重试在主循环里 |

---

## 五、继续讨论时的入口

观测完成后,带着真实数据回到这份文档,按以下顺序判断:

1. 读 Step-Observability-1 输出的"典型 8min 任务时间分布"
2. 对照 Q1 的 A/B/C 三种情况,确定真正瓶颈
3. 根据瓶颈选择优化方向(可能是): 
   - spec 提前暴露(方案 D 一轮两批)
   - 减少修复循环(prompt / template / validator 改进)
   - bring-your-own 分支
4. 写最小改动版 `STEP-WORKFLOW-2-PLAN.md`,只动真正瓶颈,不碰其他

---

## 六、讨论纪律(下次接着聊时遵守)

- **不重新讨论已否定项**(见第二节)
- **不在没数据时做架构决策** — 这是上一版冗余的根因
- **每个改动都问: 性价比?** 用户原话:"修改必须有意义,有实际提升"
- **怀疑用户方向时直接说** — 用户原话:"就算我的方向错了,你也需要提出来"
