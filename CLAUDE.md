# MockForge 开发指南

## 项目背景
MockForge 是 AI 驱动的 Mock API 平台。完整设计见 PLAN.md，实时进度见 PROGRESS.md，执行游标见 CURSOR.md。

---

## 【强制】执行协议（违反此协议 = 必然出错）

**禁止直接从 PLAN.md 执行任何 Step。** PLAN.md 有 2700+ 行，直接执行必然遗漏上下文。

### 正确流程
1. **读 `CURSOR.md`** → 10 秒定位当前 Phase/Step/Task + 下一步动作
2. **读 `STEP-N-PLAN.md`** → 当前 Step 的聚焦子计划（唯一执行依据）
3. 如果 `STEP-N-PLAN.md` 不存在 → 读 PLAN.md 所有相关章节 → 生成子计划 → 用户确认后再执行
4. **按 Task 循环**：写代码 → 自测 → 通过则 git commit + 更新 CURSOR.md → 下一 Task
   - 失败 → 修复 → 再验证（最多 3 轮，超出则暂停报告用户）
5. Step 所有 Task 完成 → 集成验收 + 回归检查 → 更新 PROGRESS.md → 删除 STEP-N-PLAN.md → `/compact` → 下一 Step

### 关键文件（按读取优先级排列）
| 优先级 | 文件 | 用途 | 何时读 |
|--------|------|------|--------|
| 1 | `CURSOR.md` | 执行游标：当前在哪 + 下一步做什么 | **每次会话开始必读** |
| 2 | `plans/STEP-N-PLAN.md` | 当前 Step 的聚焦子计划 | 实施时的唯一依据 |
| 3 | `PROGRESS.md` | 已完成归档 + 关键决策 | 需要了解历史背景时 |
| 4 | `PLAN.md` | 完整设计文档（2700+ 行） | **仅在生成子计划时读取** |

### 子计划目录
所有 Step 子计划文件统一存放在 `plans/` 文件夹下，命名格式：`plans/STEP-N-PLAN.md`。

### 不可跳过的规则
- **不跳过子计划**：无论 Step 多简单，至少生成精简版 STEP-N-PLAN.md
- **不跨 Step 执行**：未完成验收前，不得开始下一个 Step
- **不脱离子计划写代码**：发现遗漏 → 先补充子计划 → 再写代码
- **每个 Task 完成后必须更新 CURSOR.md**：这是断点续传的关键

完整执行策略详见 PLAN.md 第十二节。

### 功能缺失时的处理
- **发现任何功能缺失或不确定的细节，必须先读 PLAN.md 对应章节**
- PLAN.md 是唯一权威设计文档，所有 UI 交互、API 格式、数据流、错误处理的细节都在其中
- 不要凭记忆或推测实现功能，以 PLAN.md 为准

---

## 开发命令
- `pnpm dev` — 启动开发环境（前端 Vite + 后端 tsx watch）
- `pnpm build` — 构建生产版本
- `pnpm start` — 启动生产服务

## Git 规范
- 每个 Task 完成后 commit：`Step N.M: Task 描述`
- 不要积攒多个 Task 一起 commit
- 不要 commit 未验证的代码

## 编码规范
见 PLAN.md 第九节
