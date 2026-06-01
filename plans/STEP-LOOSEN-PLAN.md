# Step-Loosen Plan — 从"AI 自由发挥 + 严格互验"转向"模板优先 + 容忍契约 + 快速修改"

## 背景

经多轮 Cursor + 真实 LLM 实测后,MCP create/update 链路的实际体验痛点:

1. **生成慢、准确率低**:单模块 3-15 min,期间不断 LLM round-trip + run_test 修复循环
2. **小改成本极高**:改一个字段名 / 加几条数据 / 改一个值,经常 8-10 min,且常常修着修着引出新问题
3. **AI 互验陷阱**:Cursor 端 AI 和 MCP 端 AI 对"什么算正确"标准不一致 → 一边觉得"完成",另一边觉得"细节不对" → 反复触发 update_module
4. **质量门槛过严**:`chat-runner.ts` 有 4 层 phantom-success guards(health / run_test failures>0 / controller-probe / watchdog),任一不过即 finalize('error');导致即使"接口可用",细节小问题也会让整体失败,触发回滚和重做
5. **系统提示词处处"硬规则=失败"**:[system-prompt.ts](src/server/agent/system-prompt.ts) 第 187-214 行连续 10 条"违反任一条=生成失败",AI 自由度被压到逼角,但 AI 仍偶尔违反 → 失败率不降反升

### 根本错配

MockForge 的核心场景(Mock API)90% 是**模板化**任务(CRUD、固定信封、字段从 spec 来),不是创造性任务。但当前架构对所有任务一视同仁地走"自由 AI 生成 + AI 互验 + AI 修复"循环。这是用作文的工具做填空题。

### 核心心智转变

| 维度 | 现在 | 目标 |
|------|------|------|
| 生成范式 | AI 从零写 5 文件 | 规则分类 → 模板/混合/AI 三档 |
| 修改范式 | 全部走 LLM 重生成 | 小改走 deterministic 直接 edit,大改才走 LLM |
| 质量门槛 | 全 pass 才算 done(细节失败=整体失败) | 冒烟通过即 done + 列出软差异让用户/调用方 AI 决定 |
| 验证主体 | AI 写测试 + AI 判结果 | 框架做 deterministic 冒烟,语义问题让真实调用暴露 |
| 提示词 | 20+ 条"硬规则=失败" | 显式优先级 + 必须/警告/建议三档 |

---

## 4 个阶段(按 ROI + 用户痛点优先级)

### Phase 1 — 快速修改通道(收益最立竿见影)
**Pain**: 改一个字段名 8-10 min。**Goal**: 80% 的"小改"在 < 5s 完成,完全不走 LLM。

### Phase 2 — 验收收窄 + 容忍契约(收益其次,工作量小)
**Pain**: 细节失败拖垮整体。**Goal**: "冒烟通过 + 列出差异"成为 done 的标准。

### Phase 3 — 模板优先生成(收益最大,工作量也大)
**Pain**: 纯 CRUD 也走全量 LLM。**Goal**: tier 1 几秒完成,tier 2 一次 LLM round-trip。

### Phase 4 — 提示词审查 + 停止条件(贯穿,作为前 3 阶段的统一标准)
**Pain**: 提示词混乱、AI 不知优先级。**Goal**: 显式优先级 + 硬上限 + 去重。

---

# Phase 1 — 快速修改通道

## 设计

新增 2 个**完全 deterministic** 的 MCP 工具,处理 80% 的小改动场景。它们不走 ChatRunner、不调 LLM、几秒返回。

| 工具 | 处理 | 不处理(降级到 update_module) |
|------|------|------|
| `patch_module_field` | 字段:rename / add / remove / change type / change constraint | 改字段背后的业务逻辑 |
| `patch_module_endpoint` | endpoint:rename path / change method / add/remove endpoint(纯 CRUD shape) | endpoint 内含自定义业务逻辑 |

`manage_data` 现有的 7 actions(包含 update/insert/delete/list)已经覆盖数据层修改,Phase 1 只需要在 guide 里加强引导。

## Tasks

### Task 1.1 — `patch_module_field` 工具

**位置**: `src/server/mcp/tools/patch-module-field.ts`(新)

**输入**:
```ts
{
  moduleName: string,
  entityName?: string,  // 默认 _meta.entities[0]
  op: 'rename' | 'add' | 'remove' | 'change_type' | 'change_constraint',
  field: string,         // 当前字段名
  newField?: string,     // op=rename 时必填
  type?: string,         // op=add / change_type 时
  constraint?: object,   // op=change_constraint:{ required, enum, min, max, pattern, unique, default }
}
```

**实施步骤**(全部 deterministic,无 LLM):

1. **快照** `generated/{userId}/{moduleName}/` 整目录到内存(回滚用)
2. **改 _meta.json**:解析 → 找到 `entities[?].fields[?]` → 按 op 修改 → 写回
3. **改 schema.sql**:用 SQLite ALTER TABLE
   - `rename` → `ALTER TABLE mock__{userId}_{table} RENAME COLUMN {field} TO {newField}`
   - `add` → `ALTER TABLE ... ADD COLUMN {field} {type}` + 写回 schema.sql 文本(append CREATE 语句的字段)
   - `remove` → `ALTER TABLE ... DROP COLUMN {field}`(SQLite 3.35+ 支持)
   - `change_type` / `change_constraint` → SQLite 不支持原地改,执行 "create new + copy + drop old + rename" 模式(better-sqlite3 直接执行 5-6 步 SQL,事务包裹)
4. **改 controller.ts**:
   - 简单情况:string replace 字段名(限定在 entity context 内,避免误伤同名变量)
   - 复杂情况(`change_type` 影响响应):仅 warn,不动 controller,提示用户走 update_module
5. **改 test.ts**:同 controller.ts string replace 模式
6. **改 api-doc.md**:同上
7. **跑** module health check + controller load probe(复用 [src/server/core/module-health.ts](src/server/core/module-health.ts) + [chat-runner.ts:1117 probeControllerLoadable](src/server/agent/chat-runner.ts#L1117))
8. **失败回滚**:任一步骤失败 → 还原快照 + 返 friendly error 引导用户走 `update_module`

**响应**:
```ts
{
  status: 'patched' | 'fallback',
  diff: ['rename field item.mail → item.email'],
  affectedFiles: ['_meta.json', 'schema.sql', 'controller.ts'],
  quality: { healthCheck: 'ok', controllerLoadable: true, smokeTested: 'skipped' },
  fallbackHint?: 'op=change_type with controller-side response shape change — call update_module'
}
```

### Task 1.2 — `patch_module_endpoint` 工具

**位置**: `src/server/mcp/tools/patch-module-endpoint.ts`(新)

**输入**:
```ts
{
  moduleName: string,
  op: 'rename_path' | 'change_method' | 'add' | 'remove',
  endpoint: { method?, path? },   // 定位现有 endpoint
  newPath?: string,
  newMethod?: string,
  type?: 'list' | 'detail' | 'create' | 'update' | 'delete',  // op=add 时
  controller?: string,  // op=add 时,handler 函数名
}
```

**实施**:
1. 改 _meta.json 的 `endpoints[]`
2. controller.ts 的 handler 函数 — `op=add` 时按 type 套用现成模板(复用 [src/server/agent/templates/samples.ts](src/server/agent/templates/samples.ts) 的现成 CRUD handler 模板,**不调 LLM**)
3. `op=remove` → 删除 handler 函数(简单)
4. 复杂 op(改 method 影响 body 解析、handler 内部业务逻辑) → fallback 到 update_module

### Task 1.3 — guide.ts 决策引导

[src/server/mcp/resources/guide.ts](src/server/mcp/resources/guide.ts) 新增章节:

```markdown
## 改动选哪个工具(决策树)

> 关键:用对工具能让"改一个字段"从 8 分钟降到 3 秒。

| 改动类型 | 工具 | 耗时 | 走 LLM 吗 |
|---------|------|------|----------|
| 改某条数据 / 加几条数据 / 删数据 | `manage_data` | <1s | 不 |
| 改字段名 / 加字段 / 删字段 / 改字段约束 | `patch_module_field` | <3s | 不 |
| 加/删/改 endpoint(纯 CRUD shape) | `patch_module_endpoint` | <3s | 不 |
| 改 endpoint 内业务逻辑 / 加多实体关联 / 改响应 shape | `update_module` | 2-10min | 走 |
| 整个模块重建 / 不存在的模块 | `create_module_from_spec` | 7-12min | 走 |

**直觉判断**:能写出 deterministic 改法的小改动 → 用 patch_*;需要 AI "理解业务" 才能改的 → 用 update_module。
```

### Task 1.4 — 工具 description 自引导

`update_module` 的 tool description 加一段:
> 对于纯字段/纯 endpoint 形态改动(无业务逻辑变化),**优先调 `patch_module_field` / `patch_module_endpoint`**(几秒完成,不走 AI)。本工具适用于需要 AI 理解业务的复杂改动(2-10 分钟)。

`manage_data` 的 description 已经有"NEVER use clear + bulk_generate as a substitute for update",保持。

## Phase 1 验收

- **PE1-01** real-LLM E2E:Cursor AI 收到 "请把 warehouse 模块的 item 实体中 mail 字段重命名为 email" → 预期调 `patch_module_field` → 全程 < 10s 完成 + module health 通过
- **PE1-02** real-LLM E2E:Cursor AI 收到 "给 warehouse 加一个 location 字段(string,可选)" → 预期调 `patch_module_field(op:add)` → < 10s 完成
- **PE1-03** unit:patch_module_field 全部 op 类型 + 快照回滚测试
- **PE1-04** unit:controller.ts string replace 不误伤同名变量(controller 里有 `const mail = req.body.mail` 时,只改 body.mail 不改局部变量名 — 实际可能需要简单的"右侧 = entity.field" 模式匹配,或者保守起见**只改 _meta.json + schema.sql,不动 controller**,让 controller 用结构化访问)
- **PE1-05** fallback:复杂 op 返友好 error 引导 update_module

## Phase 1 关键风险

1. **controller.ts 字段替换**:string replace 有误伤风险。**保守策略**:Phase 1 MVP 只动 _meta.json + schema.sql,controller.ts 字段引用维持 `req.body[fieldName]` 这种结构化访问(本来就是推荐写法);如果 controller 里硬编码了字段名,patch 后会"controller 调不到字段" → controller-load probe 仍能通过但运行时 500 → 由 Phase 2 的冒烟测试兜住,返 quality.smokeTested='failed' + 建议走 update_module
2. **SQLite 不能改有数据的列类型(部分情况)**:better-sqlite3 应支持 SQLite 3.35+ 的 DROP COLUMN;复杂 type change 走"建新表 + 复制 + 删旧" 模式,事务包裹保证原子性

---

# Phase 2 — 验收收窄 + 容忍契约

## 设计

现在 [chat-runner.ts:1081-1132](src/server/agent/chat-runner.ts#L1081) 的 4 层 guards 全部硬 finalize('error'):

| Guard | 失败时 | 当前 | 改后 |
|-------|--------|------|------|
| (0) module health | 5 文件齐 + meta 可解析 + 表存在 | error | **保留** error(这是真不可用) |
| (a) run_test failures > 0 | 任一 test case fail | error | **改 done + warning**(只要 smoke 过) |
| (b) controller load probe | controller import throw | error | **保留** error(运行时必 500) |
| (c) watchdog no-write | 声明意图但无 write | error | **保留** error(空跑) |

新增 (d):**冒烟测试**(deterministic,非 AI):服务起后,挑 1 个最简单的 endpoint(优先 GET list)真打一次,响应 2xx + 合法 JSON = smokePassed:true。

**关键**:smokePassed = true 即 done,即使部分 run_test case fail / 字段拼写有小差异。差异通过 `quality` 字段透出给调用方,让 user Agent 决定要不要继续修。

## Tasks

### Task 2.1 — chat-runner.ts guard 改造

**修改**: [src/server/agent/chat-runner.ts:1102-1111](src/server/agent/chat-runner.ts#L1102)

```diff
- // (a) run_test failures
  if (this.lastRunTestFailures > 0) {
-   const failMsg = `... 不允许声明完成。...`;
-   this.finalize('error', { message: failMsg });
-   return;
+   // 允许部分 case 失败,但记录到 quality
+   this.runTestSoftWarning = `run_test ${this.lastRunTestFailures}/${this.lastRunTestTotal} 失败,但模块基础结构 OK`;
  }
```

### Task 2.2 — 新增冒烟测试(deterministic)

**新文件**: `src/server/core/smoke-test.ts`

```ts
export async function runSmokeTest(userId: number, moduleName: string): Promise<{
  passed: boolean;
  endpoint: string;
  status: number;
  responseValid: boolean;
  error?: string;
}> {
  // 1. 读 _meta.json
  // 2. 挑第一个 GET 端点(list 优先,detail 备选,custom 跳过)
  // 3. 通过 mock-router 内部接口真实调用一次(本进程内 fetch loopback)
  // 4. 校验:status 2xx + 响应是合法 JSON
}
```

集成点:chat-runner.ts finalize 路径,在 module health check 后、controller-probe 前调用。

### Task 2.3 — quality 字段贯穿响应

**chat-runner.ts** finalize 时附带:
```ts
const quality = {
  smokeTested: smokeResult.passed,
  smokeEndpoint: smokeResult.endpoint,
  runTestCases: { passed: this.lastRunTestPassed, total: this.lastRunTestTotal },
  warnings: [...softWarnings],
};
```

**MCP 工具响应** ([update-module.ts](src/server/mcp/tools/update-module.ts) + [create-module-from-spec.ts](src/server/mcp/tools/create-module-from-spec.ts)) 的 `buildSuccessResponse` 都加 `quality` 字段,从 result.events 中聚合。

### Task 2.4 — 客户端容忍契约(guide.ts)

[guide.ts](src/server/mcp/resources/guide.ts) 加章节:

```markdown
## 通过标准(client AI 必读 — 决定要不要再调 update_module)

### 硬标准(必须满足,缺一即失败,需重试或换 model)
- `status: 'created'` / `status: 'updated'`
- `quality.smokeTested: true`(至少 1 个 endpoint 真实响应通过)
- `endpoints.length > 0`

### 软差异(允许,不要因此重新调 update_module)
- 字段名拼写/大小写/下划线风格差异
- 示例数据具体值不同(name 是 "Alice" 还是 "张三")
- 部分 run_test case 失败(由 `quality.runTestCases.passed < total` 透出)
- 可选字段缺失
- api-doc.md 部分内容简化

### 处理软差异的正确姿势
- 改字段名拼写 → 调 `patch_module_field(op:rename)`(秒级,不要调 update_module)
- 改示例数据 → 调 `manage_data(action:update)`(秒级)
- 缺可选字段 → 调 `patch_module_field(op:add)`(秒级)

**反模式**:收到 `status:'created' + smokeTested:true` 后,因为字段名是 `mail` 而你期望 `email` 就再调 update_module。这会让本来 3 秒能解决的问题变成 10 分钟。
```

### Task 2.5 — stopping criteria 硬上限

[chat-runner.ts](src/server/agent/chat-runner.ts) 已有 watchdog 的 `NUDGE_MAX=2`,[tool-registry.ts:37-48](src/server/agent/tool-registry.ts#L37) 有 per-session repair counter,但没有"每种 error type cap":

新增 `REPAIR_HARD_CAP_PER_CAUSE = 2`(env: `CHAT_REPAIR_HARD_CAP`),在 [tool-registry.ts](src/server/agent/tool-registry.ts) 的 `bumpRepairAttempt` 后检查:
- 同一 cause 在同 session 累计 > 2 次 → 注入 system message:"该问题已尝试修复 2 次仍失败,放弃本类型修复,声明完成留 warning"
- 让 AI 看到这个信号后就 stop 而非继续 loop

## Phase 2 验收

- **PE2-01** unit:smoke test 路由能挑对 endpoint + 真实响应
- **PE2-02** unit:guard 改造后,run_test 1/3 fail 但 smoke pass → finalize 'done' + quality.runTestCases:{ passed:2, total:3 }
- **PE2-03** real-LLM E2E:故意构造小 bug(test.ts 期望字段名为 'orderNum' 但 schema 是 'order_no')→ smoke 通过 → finalize done + warning,**不重做**
- **PE2-04** real-LLM E2E:同 session 反复修同 cause 2 次仍失败 → 第 3 次 AI 自己 stop(看到硬 cap message)
- **PE2-05** client AI 行为测试:fake Cursor agent 调 create → 收到 smokeTested:true + 字段名 mail/email 差异 → 期望它调 patch_module_field,**不调** update_module

---

# Phase 3 — 模板优先生成

## 设计

`create_module_from_spec` 入口加 **deterministic classifier**,把 spec 分三档:

| Tier | 特征 | 路径 | 耗时 |
|------|------|------|------|
| 1: **crud-pure** | OpenAPI 全是标准 CRUD + schema 简单(无 enum/pattern/cross-field/UNIQUE 业务字段) | 100% 模板生成,无 LLM | < 5s |
| 2: **crud-with-rules** | CRUD shape + 含字段约束/示例数据要求 | 模板生成骨架 + 1 次 LLM 填充 fields/constraints | 30-60s |
| 3: **full-ai** | 自然语言 / 含 custom endpoint / 多实体关联 / 业务规则 / unknown shape | 现状(ChatRunner 全量) | 3-15min |

**关键**:tier 1/2 输出后仍跑 module health + smoke test + controller probe — 模板不代表无 bug,仍要兜底。任一失败 → 降级到 tier 3。

## Tasks

### Task 3.1 — `classifySpec` 分类器

**新文件**: `src/server/mcp/lib/spec-classifier.ts`

```ts
export function classifySpec(spec: string, requestedModuleName?: string): {
  tier: 1 | 2 | 3;
  reason: string;
  parsedOpenapi?: any;
  detectedEntities?: Array<{ name: string; fields: Field[] }>;
  detectedEndpoints?: Array<{ method, path, type }>;
  detectedConstraints?: any[];
}
```

**判定规则**(deterministic):
- spec 不是 OpenAPI/YAML → tier 3
- OpenAPI 解析失败 → tier 3
- 含 custom path(非 `/items` `/items/:id` pattern)→ tier 3
- 多实体且有 cross-reference(_meta.entity.constraints 类)→ tier 3
- 所有 endpoint 都是标准 CRUD + schema 无 enum/pattern → tier 1
- CRUD + 含字段约束(enum/min/max/pattern)→ tier 2

### Task 3.2 — tier 1 模板生成器

**新文件**: `src/server/mcp/lib/generate-template.ts`

复用 [src/server/agent/templates/samples.ts](src/server/agent/templates/samples.ts) 的 `crud-basic` 模板作为基础,直接做字符串替换(entity name / table name / fields)→ 输出 5 个文件 → 调 `writeFiles()` 落盘。

**关键**:复用现有的 [src/server/agent/tools/write-files.ts](src/server/agent/tools/write-files.ts)(已有事务 + 回滚),不重写写盘逻辑。

### Task 3.3 — tier 2 模板 + AI 混合

模板生成骨架后,把"需要 AI 填的部分"打包成**单次 LLM call**(非 ChatRunner、非 streamText、不走 tool calling):

```ts
const filledMeta = await callLLMSingleShot({
  model,
  prompt: `Given this OpenAPI schema, fill in field constraints (enum/min/max/pattern) for these entities: ${entitiesJson}. Return JSON only.`,
  schema: zodSchema,  // generateObject mode
  timeout: 60_000,
});
```

用 `generateObject`(ai-sdk)而非 `streamText` + tools — 输出 schema 严格约束,无 tool 决策开销,1 次 round-trip 完成。

### Task 3.4 — create_module_from_spec 入口路由

修改 [src/server/mcp/tools/create-module-from-spec.ts](src/server/mcp/tools/create-module-from-spec.ts):

```diff
+ const classification = classifySpec(spec, moduleName);
+ if (classification.tier === 1) {
+   const result = await generateTemplate(user.userId, classification);
+   const health = computeModuleHealth(user.userId, result.moduleName);
+   const smoke = await runSmokeTest(user.userId, result.moduleName);
+   if (health.health === 'healthy' && smoke.passed) {
+     return buildSuccessResponse({ ...result, tier: 1, quality: { smokeTested: true } });
+   }
+   // fallback
+ }
+ if (classification.tier === 2) {
+   const result = await generateTemplateWithAI(user.userId, classification, provider);
+   // 同 tier 1 兜底
+ }
+ // tier 3 走现状
  return runWriteTool({ ... });
```

### Task 3.5 — fallback 路径

tier 1/2 失败时:
- **不**返 error(deterministic 路径出错不应让用户看到 deterministic bug)
- **静默** fallback 到 tier 3(走完整 ChatRunner)
- 日志记录:`[classifier] tier 1 fallback for module X: smoke failed at /items` 便于运营观察 fallback 率

## Phase 3 验收

- **PE3-01** unit:classifySpec 对 10+ 种 spec 形态分类正确
- **PE3-02** unit:tier 1 模板生成对 3 种典型 CRUD spec 全程 < 5s + module health 通过
- **PE3-03** real-LLM E2E:用真实 OpenAPI(纯 CRUD)调 create_module_from_spec → tier 1 → 完成 < 10s
- **PE3-04** real-LLM E2E:OpenAPI 含 enum 约束 → tier 2 → 完成 < 90s + enum 在 _meta.json 中体现
- **PE3-05** real-LLM E2E:自然语言 spec → tier 3 → 同现状(无回归)
- **PE3-06** fallback:tier 1 模板写盘后 controller probe 失败 → 静默降级 tier 3

## Phase 3 关键风险

1. **模板写死的字段不能满足用户 spec**:tier 1 模板假设所有 endpoint 都是标准 CRUD,但用户 OpenAPI 可能有微小变体(如 list 不分页) — classifier 要严格判定 "完全标准" 才进 tier 1,稍有偏差就 tier 2/3
2. **tier 2 的单次 LLM call 失败**:如果 LLM 返回的 JSON 不符合 schema → 降级 tier 3
3. **tier 1 模板要和现在的写盘后续流程兼容**:_meta.json 写盘会触发 sync 到 modules 表,schema.sql 会触发 SQLite exec — 复用 [writeFiles](src/server/agent/tools/write-files.ts) 即可,但要确认不依赖 ChatRunner 上下文

---

# Phase 4 — 提示词审查 + 停止条件

## 设计

不写新代码,**重构现有提示词**让 AI 优先级清晰。这是前 3 阶段的"统一标准",最后做(等前 3 阶段验证完想清楚)。

## Tasks

### Task 4.1 — system-prompt.ts 顶部加显式优先级

[system-prompt.ts](src/server/agent/system-prompt.ts) 在开场白后立刻加:

```markdown
## 执行优先级(前者满足前不做后者)

1. **可加载**:controller.ts 能成功 import(不抛 alias/syntax error)
2. **能响应**:至少 1 个 endpoint 调用返 2xx + 合法 JSON
3. **结构对**:字段集合与 spec 重合 ≥ 80%
4. **细节齐**:字段名风格、示例数据合理性、测试全 pass

**第 1-2 步没完成,绝对不做第 3-4 步的微调。**
**第 3 步完成且没明确指令,绝对不做第 4 步的反复优化。**
```

### Task 4.2 — 把"硬规则=失败"分三档

[system-prompt.ts:187-214](src/server/agent/system-prompt.ts#L187) 的 "契约硬规则" 段重构:

```markdown
## 必须满足(违反即失败,框架拒绝)
- 5 文件齐全
- controller.ts 能 import(@core/* alias)
- schema.sql 主键合规
- _meta.json entities 入口唯一

## 警告级(违反 → warning,不阻断完成)
- 字段名风格不一致
- run_test 部分 case 失败
- 业务唯一字段 generator 熵不足

## 建议(写在 default 段,不"必须"强调)
- 响应信封默认
- 时间格式默认
- 金额处理默认
```

### Task 4.3 — 工具 description 去重

[system-prompt.ts:66-67](src/server/agent/system-prompt.ts#L66) 写了 `write_files` vs `write_file` 的选择规则;[tool-registry.ts:193-200](src/server/agent/tool-registry.ts#L193) 的 tool description 也写了同样的指引。

**保留 tool description(更靠近 AI 决策点),从 system prompt 删**。同理 "数据修改铁律"(system-prompt.ts:155-157)和 manage_data 的 tool description(tool-registry.ts:246-257)重复 — **保留 tool description**。

### Task 4.4 — guide.ts 加客户端优先级

[guide.ts](src/server/mcp/resources/guide.ts) 加章节(对应 Task 4.1 的服务端优先级):

```markdown
## 调用 MockForge 工具的优先级(client AI 必读)

1. **改数据** → 用 manage_data(< 1s)
2. **改字段/endpoint shape**(纯结构) → 用 patch_module_field / patch_module_endpoint(< 5s)
3. **改业务逻辑** → 用 update_module(2-10min)
4. **新建模块** → 用 create_module_from_spec(几秒到 10min,看 tier)

**反模式(浪费时间)**:
- ✗ 收到 status:'created' + smokeTested:true 但字段名拼写差异 → 调 update_module(应该用 patch_*)
- ✗ 改一条数据 → 调 update_module(应该用 manage_data)
- ✗ 同一改动失败 2 次仍重试 → 看 quality.warnings 决定 stop / 换 model
```

### Task 4.5 — 停止条件硬上限实施

(已纳入 Task 2.5)

## Phase 4 验收

- **PE4-01** system-prompt 体积:重构后 ≤ 现在(~7.3KB)
- **PE4-02** real-LLM E2E:观察 AI 是否先满足 1-2 优先级再做 3-4 细节(用包含明显瑕疵的 spec 测,看 AI 是否反复优化字段名)
- **PE4-03** 重复指令扫描:`grep "写一次" "硬规则" "违反"` 在 system-prompt + tool-registry 不应有 > 1 处覆盖同一规则
- **PE4-04** guide.ts 的"反模式"段被 client AI 读到的迹象(real-LLM 实测时观察 Cursor 是否还误用 update_module 改字段名)

---

# 整体验收 — 端到端硬指标

| 场景 | 现状 | Phase 1 完成后 | 全部完成后 |
|------|------|---------------|------------|
| 改一个字段名(rename) | 8-10 min | < 5s | < 5s |
| 加一个字段 | 8-10 min | < 5s | < 5s |
| 改 5 条数据 | 5-8 min(走 update_module 误用) | < 3s(manage_data) | < 3s |
| 纯 CRUD OpenAPI → 新模块 | 7-12 min | 7-12 min | < 10s(tier 1) |
| 含 enum 约束 OpenAPI → 新模块 | 7-12 min | 7-12 min | < 90s(tier 2) |
| 复杂自然语言 spec → 新模块 | 7-12 min | 7-12 min | 7-12 min(同现状,不回归) |
| 改业务逻辑(update_module) | 5-10 min,反复 loop | 5-10 min,但不会因字段拼写小差异 loop | 5-10 min,且 stopping criteria 兜住 |
| 整体失败率(real-LLM E2E) | ~30% 需手动重试 | ~15% | ~5% |

# 不做的事(刻意排除,避免范围爆炸)

- 不引入新的 AI Agent / 不上 reasoning model 专用提示词
- 不重写 ChatRunner(它本身没问题,问题在于"所有改动都走它")
- 不动 mock-router / BaseModel / module-health 等运行时基础设施
- 不引入新依赖(TypeScript AST 解析在 Phase 1 故意用 string replace 保守起步)
- 不调整 MCP 工具总数门面(现 12 工具,Phase 1 加 2 → 14;不裁剪现有工具)
- 不动前端(Web UI 维持现状,所有改动都在 MCP + agent 层)

# 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| Phase 1 patch_* 误改 controller.ts | 保守起步:只改 _meta.json + schema.sql,controller 不动 | 工具开关 `MOCKFORGE_DISABLE_PATCH_TOOLS=1` |
| Phase 2 验收放松后,真 bug 被吞 | 保留 module health + controller probe 两层硬 guard | 环境变量 `CHAT_STRICT_VALIDATION=1` 恢复现状 |
| Phase 3 分类器误判,tier 1 写出错的模块 | 写盘后必跑 health + smoke,失败静默降级 tier 3 | 工具开关 `MOCKFORGE_DISABLE_TEMPLATE_TIER=1` |
| Phase 4 提示词改后,某些边界 case 行为退化 | 每个 Task 后跑 real-LLM E2E 验证 | git revert(纯 prompt 改动,易回滚) |

# 实施顺序

按 Phase 1 → 2 → 3 → 4 严格顺序。每个 Phase 内的 Task 可适当并行(如 Phase 1 的 1.1 和 1.2 独立)。

每个 Task 完成后:
1. 单元测试通过
2. real-LLM E2E 跑一次相关场景
3. git commit:`Step-Loosen-{phase}.{task}: <描述>`
4. 更新 CURSOR.md 当前位置

Phase 1 完成后**先停下来用一段时间**,真实场景验证小改动确实变快了再启 Phase 2。Phase 3 改动最大,如果 Phase 2 已带来明显改善,可考虑推迟或缩减 Phase 3。

# 一句话总结

把 MockForge 从"AI 一把梭 + AI 互验 + AI 修复" 重构为 **"规则分类 → 模板/混合/AI 三档生成 + deterministic 快速修改 + 冒烟通过即 done + 容忍契约暴露给调用方"**,把"小改动 8-10 分钟"降到秒级,把"AI 互验死循环"用显式优先级 + 硬上限掐断。
