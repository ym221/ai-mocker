# Step-Workflow-1 Plan — 强制 AI 走"参数→模板→例外→测试"流水线 + 反作弊兜底

## 背景

Step-Loosen 把验收门槛从"全 pass"降到"smoke 通过",但 tier 3 复杂 spec 上仍有结构性问题:

1. **AI 自由发挥导致细节漂移**:tm_reconcile 实测 AI 从零写 controller.ts,信封风格 / 字段命名 / 分页结构在 5 个文件里不一致,run_test 失败率高
2. **修 bug 整文件重写**:AI 唯一的 patch 工具是 `write_file`,只能整覆盖。修一个字段错把其他正确的也重写一遍,容易引入新 bug
3. **作弊**:tm_reconcile 实测 AI 把 run_test total 从 16 删到 8,降低分母让通过率看起来好。system-prompt 里写了"不许删 case",deepseek-chat 直接忽略
4. **重试无上限**:Phase 2.5 的 `REPAIR_HARD_CAP_PER_CAUSE=2` 辅助函数加了,但 chat-runner 没真接 — 实测 AI 跑了 10 轮 run_test 才停

### 用户描述的"理想工作流"

```
spec → AI 抽取格式化参数 → 套模板生成代码 → 例外业务逻辑修改 → 写测试 → 跑测试
  →(失败)patch 局部修改(不重写)→ 区分是测试 bug 还是代码 bug → 改对应 → 直到通过
```

本 Plan 的目标:**把这个工作流从"提示词建议"变成"框架强制 + 工具锁定"**。

---

## 核心思想

| 维度 | 改造前 | 改造后 |
|---|---|---|
| 工作流顺序 | AI 自由 | **强制**:必须先 `emit_params` 才能 `write_files`,必须 `write_files` 后才能 `run_test` |
| 修改方式 | `write_file` 整覆盖 | **强制 patch**:首次创建用 write_files,修复必须用新增的 `patch_file`(单次 diff ≤ 30% 文件大小) |
| 反作弊 | 提示词"不要删 case" | 提示词 + **软警告**(test.total 下降 → 注入恢复指令 + quality.warning) |
| 修复上限 | 无硬上限(实测 10 轮) | **per-cause cap=2**,超出后框架注入"放弃修复本类型问题"system 指令 |
| 参数与代码一致性 | AI 自己保证 | **emit_params 后,write_files 校验文件内容是否符合声明的 params**(字段名 / 信封 / 端点路径) |

---

## 5 个 Task(按依赖顺序)

### Task 1 — `emit_params` 工具:强制结构化决策第一步

#### 实现位置
- 新文件 `src/server/agent/tools/emit-params.ts`
- 注册到 `tool-registry.ts`,放在 `set_module_intent` 后

#### 工具签名

```ts
emit_params({
  moduleName: string,
  fieldNaming: 'snake_case' | 'camelCase' | 'PascalCase',
  envelope: {
    default: { successFlag: string, dataField: string, messageField?: string, paginationField?: string },
    exceptions?: Array<{ endpoint: string, envelope: object }>  // API-007 IsSuccess 这种
  },
  entities: Array<{
    name: string,
    tableName: string,
    primaryKey: { name: string, type: 'INTEGER' | 'TEXT', autoIncrement?: boolean },
    fields: Array<{ name, type, required?, default?, enum?, unique?, min?, max?, pattern? }>,
    seedCount?: number,                    // 用户 spec 提"种子 N 条"时
    constraints?: Array<{ id, when, must, message }>
  }>,
  endpoints: Array<{
    method, path, type: 'list'|'detail'|'create'|'update'|'delete'|'custom',
    entity: string,                        // 指向 entities[].name
    customLogic?: string,                  // 文字描述例外业务(如"邮箱中文逗号替换"、"跨表带出 supplierName")
    envelopeOverride?: string               // 指向 envelope.exceptions
  }>
}) → { ok: true, paramsId: <session-bound id> }
```

#### 行为
1. 校验 schema(zod)— 任一项缺失或类型错就 reject
2. 校验内部一致性:每个 endpoint.entity 必须在 entities 里;envelopeOverride 必须在 exceptions 里
3. 存到 ChatRunner.params(per-session 内存)
4. 返成功,放行后续工具

#### 强制顺序(关键)
在 [tool-registry.ts](src/server/agent/tool-registry.ts) 的 `write_files` / `write_file` / `run_test` 的 execute 包一层:

```ts
if (!runner.params) {
  return {
    success: false,
    error: '必须先调用 emit_params 输出本模块的结构化参数。框架按 params 校验所有后续写入,跳过这一步无法继续。'
  };
}
```

只有 `set_module_intent` / `read_file` / `get_module_template` / `emit_params` 本身豁免。

#### 工作量:**~半天**(含 zod schema + 校验 + chat-runner 加 field)

---

### Task 2 — `patch_file` 工具:强制"只改不重写"

#### 实现位置
- 新文件 `src/server/agent/tools/patch-file.ts`
- 注册到 `tool-registry.ts`

#### 工具签名(两种调用模式)

```ts
// 模式 A:基于 oldText 精确匹配
patch_file({
  path: 'tm_reconcile/controller.ts',
  oldText: 'orderBy: { createdAt: \\'DESC\\' }',
  newText: 'orderBy: \\'createdAt DESC\\'',
  reason: '修复 BaseModel 不接受对象 orderBy'  // 必填,用于审计
})

// 模式 B:基于行号
patch_file({
  path: '...',
  lineStart: 47,
  lineEnd: 49,
  newContent: '...',
  reason: '...'
})
```

#### 行为
1. 读 file 当前内容
2. 模式 A:`oldText` 必须**精确**匹配文件中**唯一**一段(不能匹配 0 处或 ≥ 2 处)
3. 模式 B:行号必须在文件范围内
4. **diff size 上限**:`newText` 字符数 vs `oldText` 字符数比值,允许 [0.3, 3.0]。超出视为"重写而非修改",reject
5. **总 diff 上限**:每次 patch 修改的字符数 ≤ 文件总字符数的 30%。超出 reject
6. 成功后写盘,如果是 .sql 文件同样 exec(走 write-file 已有路径)

#### 强制使用 patch_file 的场景
在 [tool-registry.ts](src/server/agent/tool-registry.ts) 的 `write_file` / `write_files` execute 加一道检查:

```ts
// 如果文件已存在 AND session 内已经调用过 run_test
// → 视为"修复阶段",block write_file/write_files 对该文件的全覆盖
if (
  existsSync(targetFile) &&
  runner.runTestCalledThisSession() &&
  !runner.isFirstWriteAfterParams()  // 第一次 write 阶段豁免
) {
  return {
    success: false,
    error: '已进入修复阶段,禁止 write_file 整覆盖。请用 patch_file 做局部修改,reason 字段说明改什么和为什么。'
  };
}
```

这才是真"只改不重写"落地 — 不是靠提示词,是工具能力直接限制。

#### 工作量:**~半天**(含 diff 校验 + 多场景测试)

---

### Task 3 — per-cause cap 接入 chat-runner

#### 实现位置
- 修改 `src/server/agent/chat-runner.ts`

#### 行为
当前已有:
- `tool-registry.ts` 的 `instrument()` 在 tool failure 时调 `bumpRepairAttempt`
- `isRepairCapReached()` 辅助函数

缺的:**chat-runner 没用这个信号。**

在 `consumeOneStream` 后(每轮 LLM 流结束),加一段:

```ts
// 检查是否有任何 repair cause 超过硬上限
const overCappedCauses = ['run_test_failed', 'sql_exec_failed', 'meta_parse_error', 'write_failed']
  .filter(c => isRepairCapReached(this.sessionId, c));

if (overCappedCauses.length > 0) {
  // 注入 system message 强制 AI 终止本类型修复
  coreMessages.push({
    role: 'user',
    content:
      `[框架强制 — 修复上限达到]\n` +
      `以下问题已尝试修复 ≥ 2 次仍失败:${overCappedCauses.join(', ')}\n` +
      `**禁止再修复这些类型的问题。** 必须立即:\n` +
      `1. 输出文字总结当前状态\n` +
      `2. 让流自然结束\n` +
      `3. 框架会在 quality.warnings 透传这些未解决的问题给调用方,调用方决定后续\n` +
      `**禁止再调 write_file / write_files / patch_file / run_test。**`
  });
  // 同时下一轮收窄工具集 — 只留 read_file 让 AI 看自己写了什么,然后让它自己出文字
  await consumeOneStream(coreMessages, { restrictedToWrite: false, restrictedToReadOnly: true });
  break;
}
```

新增的 `restrictedToReadOnly` 选项:工具集只暴露 `read_file` + `list_modules`(参考已有 `buildToolsForNudge` 模式)。

#### 工作量:**~1 小时**(逻辑简单,主要测试覆盖)

---

### Task 4 — 系统提示词重构:强制流水线 + 反作弊条款

#### 实现位置
- 修改 `src/server/agent/system-prompt.ts`,改"开工流程"章节

#### 改后的强制流程描述

```markdown
## 强制工作流(违反任一步 = 任务失败,框架已用工具能力锁定流程顺序)

### 阶段 0: 声明意图
\`set_module_intent(moduleName, 'create' | 'edit')\`

### 阶段 1: 结构化参数提取(必须先做,不做无法继续)
读 spec → 抽取所有字段/端点/信封规则 → 调:
\`emit_params({ moduleName, fieldNaming, envelope, entities, endpoints })\`

**禁止跳过此步骤直接写文件。** 框架已在 write 工具加 gate:没 emit_params 就 reject。

### 阶段 2: 首次生成 5 个文件
\`write_files\` 一次批写 _meta.json / schema.sql / controller.ts / test.ts / api-doc.md。
**所有文件内容必须严格符合阶段 1 emit 的 params**(字段名 / 信封 / 端点路径全部一致)。
**schema.sql 必须包含 INSERT 种子**(若 params.seedCount > 0)。

### 阶段 3: 自测
\`run_test(moduleName)\`

### 阶段 4: 修复(若 run_test 失败)
**禁止用 write_file / write_files 整覆盖修复。** 框架已在工具加 gate:进入修复阶段后,write_file/write_files 会 reject。
**必须用 \`patch_file(path, oldText, newText, reason)\` 做局部修改。**
- 单次 patch:diff size ≤ 30% 文件;newText/oldText 比 ∈ [0.3, 3.0]
- 修复 reason 必填,说明改什么 + 为什么

判断 bug 在哪:
- **代码 bug**:run_test 报"字段不存在"/"SQL 语法错"/"BaseModel API 用错" → patch controller.ts 或 schema.sql
- **测试 bug**(test.ts 自己写错了):assert 期望值跟 spec 不一致 / 测试逻辑错 → **可以**修 test.ts
- **不允许的"修复"**:为了通过测试而**降低期望**(把 assert.eq 改 assert.ok / 删 case / 改测试数据)

### 反作弊硬规则(违反 = 任务标记失败,框架记录 quality.cheated=true)

- **禁止减少 test case 总数**(test('...', () => ...) 的总数量)。可以新增 case,可以修 case 内部 assert(只为修正 bug),不能删
- **禁止把强 assert 换弱 assert**(\`eq\` → \`ok\` / \`exists\`)
- **禁止把测试期望改成 controller 实际错误返回的值**(测试是 spec 标准,代码错了改代码,不是改测试期望)

若实在修不动:
- 在最终回复里**明说**"X 个 case 修不通过,原因 Y"
- 让框架 quality.warnings 透传给用户,**不要靠改测试假装通过**

### 阶段 5: 完成判定(框架自动)
- smoke 通过 + run_test 全 pass → declare done
- smoke 通过 + run_test 部分失败 + 修复尝试 ≥ 2 次仍未过 → 框架强制 finalize done,把未解决问题写进 quality.warnings,不允许继续修
```

#### 与现有 prompt 章节的协调
- 移除 "## 开工流程" 章节旧版,替换为上面的 5 阶段版
- "数据修改铁律"、"约束表达优先级"、"BaseModel API 表面"等保留(它们是阶段 2 的细节支撑)

#### 工作量:**~2-3 小时**(纯文本改动,但要审稿对账)

---

### Task 5 — test 数量回退软警告(选做但推荐)

#### 实现位置
- 修改 `src/server/agent/chat-runner.ts`

#### 行为
在 `tool-result` 流事件处理 run_test 时,记录 `peakRunTestTotal`:

```ts
if (callInfo?.name === 'run_test' && raw?.total) {
  if (this.peakRunTestTotal == null || raw.total > this.peakRunTestTotal) {
    this.peakRunTestTotal = raw.total;
  }
  if (raw.total < this.peakRunTestTotal) {
    const dropped = this.peakRunTestTotal - raw.total;
    this.softWarnings.push(
      `检测到 test case 数量从 ${this.peakRunTestTotal} 降到 ${raw.total} (-${dropped}) — 这可能是作弊行为,quality.cheated=true`
    );
    // 注入 system 警告(下一轮 AI 能看到)
    this.appendEvent('thinking', {
      content: `[框架警告] 你删除了 ${dropped} 个 test case (从 ${this.peakRunTestTotal} 降到 ${raw.total})。这违反了反作弊约束 —— 必须恢复全部 case。允许修正 case 内部错误,但不允许减少 case 数量。`,
    });
  }
}
```

#### 在 finalize 时 emit `quality.cheated` 标记
```ts
if (this.peakRunTestTotal != null && this.lastRunTestTotal < this.peakRunTestTotal) {
  quality.cheated = true;
  quality.peakRunTestTotal = this.peakRunTestTotal;
  quality.finalRunTestTotal = this.lastRunTestTotal;
}
```

调用方 AI 看到 quality.cheated=true 就知道这次结果可疑,可决定要不要继续修。

#### 工作量:**~1 小时**

---

## 5 个 Task 的实施顺序

```
Task 1 (emit_params)         半天   ← 阶段 1 基础设施
   ↓
Task 4 (system-prompt 重构)   2-3h   ← 让 AI 知道新流程
   ↓
Task 2 (patch_file)          半天   ← 阶段 4 基础设施
   ↓
Task 3 (per-cause cap)       1h    ← 兜底
   ↓
Task 5 (反作弊软警告)         1h    ← 监控
   ↓
[端到端测试 tm_reconcile]     1h
```

**总工作量:~2 个工作日**(包含测试和迭代)

---

## 验收标准

### 用 tm_reconcile spec 复测

| 指标 | 改造前(最近一次实测) | 改造后预期 |
|---|---|---|
| 总生成时长 | 405s | ≤ 360s(少了反复重写代价) |
| run_test 通过率 | 6/8(被作弊压低 total) | ≥ 12/16 真实 case(分母回归) |
| test case 数量稳定性 | 16→14→11→10→8 (作弊) | 16→16→16(全程稳定) |
| 修复尝试次数 | 10 轮 | ≤ 3 轮(per-cause cap 起效) |
| AI 是否调 emit_params | 否(工具不存在) | 第一步必调 |
| AI 是否用 patch_file | 否(工具不存在) | 修复时全部用 patch_file |
| quality.cheated | 不存在 | 应为 false |

### 单元测试覆盖
- `emit_params` schema 校验、内部一致性校验
- `patch_file` 三种模式(oldText 唯一匹配 / 多匹配 reject / 0 匹配 reject / diff size 上限)
- `chat-runner` per-cause cap 触发 inject + restrictedToReadOnly
- `peakRunTestTotal` 回退检测

---

## 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| emit_params 太严格,AI 第一次就 emit 不出合格 params | schema 字段大部分可选;重点校验 entities/endpoints 必填项 | env `MOCKFORGE_DISABLE_PARAMS_GATE=1` 跳过 gate |
| patch_file 的 diff size 阈值不合理,AI 修不动 bug | 30% 阈值偏宽松;实测后可调到 50% | env `MOCKFORGE_PATCH_MAX_RATIO=0.5` 可调 |
| 修复阶段强制 patch_file 让 AI 无法处理大规模 bug | 第一次 run_test 失败仍允许一次 write_file 大改;后续才锁定 | 阶段 4 gate 默认从第 2 次失败起生效 |
| per-cause cap=2 太严,AI 还没真 fix 就被打断 | env `CHAT_REPAIR_HARD_CAP=3` 已存在,可调 | 提高到 3-4 |
| AI 找新方法绕作弊(改 case 内容降低 assert 强度) | 这是已知盲区,纯框架检测不到;留给"AI 评审 AI"或人工 review | 用户/调用方 AI 用 quality.warnings + log 判断 |

---

## 不做的事(避免范围爆炸)

- **不**实现 "params → 模板代码生成器"(deterministic codegen)。本 Plan 只做 "params + 校验 + 流程锁",不替 AI 写代码。后续 Step-Workflow-2 可考虑。
- **不**改 BaseModel / mock-router / chat-runner 主体生成循环。
- **不**改 tier 1/2/3 分类逻辑(Step-Loosen Phase 3 的事)。
- **不**重写 system-prompt 全文,只重构"开工流程"章节。

---

## 与 Step-Loosen 的关系

Step-Loosen 把 **验收门槛** 放宽了(smoke pass = done)。但放宽后留了两个坑:
1. AI 因为知道"smoke 过就行",可能写得更随便 → 准确率本应更高反而更低
2. 反正容易过,作弊更没成本

Step-Workflow-1 是**反向加强**:验收宽松依旧,但**生成过程**强制规范。两者的关系:

```
Step-Loosen:   终点宽松(冒烟过即可)
Step-Workflow: 过程严格(必须按步走,不许整覆盖,不许作弊)
合起来:        过程严格,终点宽松,异常透传给用户 → AI 没空间偷工减料
```

---

## 一句话总结

把"用提示词告诉 AI 该怎么走"升级成"用工具能力强制 AI 只能这么走" — 5 个 Task,2 个工作日,把 tm_reconcile 实测里观察到的所有结构性问题(漂移、整覆盖、作弊、无限重试)从源头锁死。
