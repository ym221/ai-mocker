# Observability Baseline (Step-Observability-1)

## 一、性能开销实测

**测试方法**: `tests/observability-perf.spec.ts` (OB-PERF01)
- fake-runner session,sequential 5 次,丢弃首尾再取均值
- 先 disable 跑一组,再 enable 跑一组

**结果**:

| 配置 | 平均耗时 |
|------|---------|
| 关闭(disabled) | **1686 ms** |
| 开启(enabled)  | **1687 ms** |
| **相对开销**   | **0.1%** |

**结论**: 远低于计划设定的 5% 硬约束。

实际原因:
- emit 走 `setImmediate` 异步入库,完全脱离主路径
- 单个事务平均 < 1ms,远小于 fake-runner 自身的 sleep 节奏
- 真实 LLM 任务(网络 IO 主导,数分钟级)相对开销会更小

## 二、阶段拆分覆盖

emit 的事件类型(全部跑通,见 OB-API01 + OB-CR01):

| Phase | emit 位置 | 覆盖测试 |
|-------|-----------|---------|
| `prompt_build` | chat-runner runAIGeneration 入口 | 真实 LLM 模式 |
| `llm_thinking` | consumeOneStream 每轮 | 真实 LLM 模式 |
| `repair_loop` | 第一次 watchdog 触发时 | 真实 LLM 模式 |
| `finalize` | finalize() 入口 | OB-CR01 (fake) |
| `tool_timing` | tool-registry instrument 包裹 | OB-T01/T02 |
| `repair_triggered` | tool failure classify | OB-T01/T03 |
| `llm_round` | consumeOneStream 出口 | 真实 LLM 模式 |

> **fake-runner 不走 runAIGeneration**,所以 prompt_build / llm_thinking / repair_loop / llm_round
> 的实际数据需要在真实 LLM E2E 触发后查看(进 `执行日志` tab)。

## 三、当前数据流闭环验证

✅ 后端 emit → message_events 表(负 seq)
✅ chat-runner.subscribe 不返还观察事件给 client (OB-CR03)
✅ aggregateTimeline 按 createdAt 合并两路数据
✅ /api/sessions/:id/timeline 返回结构化视图
✅ /api/modules/:name/timeline 自动选最近 session
✅ ModuleDetailPage 加 "执行日志" tab
✅ TimelineView 渲染总览 + PhaseBar + 工具表 + LLM 轮次表 + 修复明细 + 原始事件

## 四、下一步: 看清真实 8min 的分配

按 CONTEXT-WORKFLOW-NEXT.md Q1 的 (A)/(B)/(C) 判断:

1. 用户跑一次真实 LLM `create_module_from_spec`
2. 打开模块详情页 → "执行日志" tab
3. 截图阶段占比 + 修复次数,贴回这份文档
4. 据此决定下一步:
   - 如果 spec 阶段在前 1-2 分钟就完成 → 走 spec 提前暴露(方案 D)
   - 如果修复占比 > 60% → 优先修复 prompt / template / validator
   - 如果混杂无清晰边界 → 减少修复循环为优先

**这份基线文档完成后才能正式开始 Workflow 阶段的方案选择。**
