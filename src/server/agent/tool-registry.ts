import { z } from 'zod';
import { tool } from 'ai';

/** LLM 常把复合参数(array/object)整个 JSON.stringify 后传过来 — 在 zod 校验前
 *  先 JSON.parse,失败回退原值让 zod 给出正常报错。 */
function parseIfStringified<T>(val: unknown): T | unknown {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { /* not JSON, pass through */ }
  }
  return val;
}

/** AI 调 set_module_intent 后,写 path 经常省模块名前缀(写 "_meta.json" 而不是
 *  "tm_reconcile/_meta.json")。框架按当前 session 的 moduleIntent.moduleName
 *  自动补上,把"AI 心智模型"和"框架要求"对齐。 */
function autoPrefixModulePath(path: string, moduleName: string | null | undefined): string {
  if (!moduleName) return path;
  const cleaned = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  // 已经在某个模块目录下(含 /)或带 generated/ 前缀 → 不动
  if (cleaned.includes('/') || cleaned.startsWith('generated')) return path;
  return `${moduleName}/${cleaned}`;
}
import { writeFile } from './tools/write-file.js';
import { writeFiles } from './tools/write-files.js';
import { readFile } from './tools/read-file.js';
import { runTest } from './tools/run-test.js';
import { manageData } from './tools/manage-data.js';
import { listModules } from './tools/list-modules.js';
import { deleteModule } from './tools/delete-module.js';
import { fetchModuleTemplate } from './tools/get-module-template.js';
import { emitParams, paramsSchema } from './tools/emit-params.js';
import { patchFile } from './tools/patch-file.js';
import { runSerialized } from './lib/session-mutex.js';
import { emitToolTiming, emitRepair, type RepairCause } from '../core/observability.js';
import type { ChatRunner } from './chat-runner.js';

// Per-session repair attempt counter. Keyed by sessionId+cause.
// Cleared lazily — entries grow only with active sessions.
const repairAttempts = new Map<string, Map<string, number>>();

function bumpRepairAttempt(sessionId: string, cause: string): number {
  let bucket = repairAttempts.get(sessionId);
  if (!bucket) {
    bucket = new Map();
    repairAttempts.set(sessionId, bucket);
  }
  const next = (bucket.get(cause) ?? 0) + 1;
  bucket.set(cause, next);
  return next;
}

// Step-Loosen Phase 2.5:per-cause hard cap.
// 超过这个数,observability emit 一条 'repair_cap_reached' 事件,
// 让 AI 在下次思考时看到 system 提示自己 stop 修同类问题(由 chat-runner 注入)。
const REPAIR_HARD_CAP_PER_CAUSE = Math.max(1, Number(process.env.CHAT_REPAIR_HARD_CAP ?? 2));
export function getRepairAttempts(sessionId: string, cause: string): number {
  return repairAttempts.get(sessionId)?.get(cause) ?? 0;
}
export function isRepairCapReached(sessionId: string, cause: string): boolean {
  return getRepairAttempts(sessionId, cause) >= REPAIR_HARD_CAP_PER_CAUSE;
}

/** Map a tool failure result to a repair cause. Returns null if not a "repair needed" failure. */
function classifyFailure(toolName: string, result: any): { cause: RepairCause; targetFiles: string[]; snippet: string } | null {
  if (!result || typeof result !== 'object') return null;
  // write_files / write_file failure
  if (result.success === false) {
    const msg = String(result.message || result.error || '');
    const lower = msg.toLowerCase();
    let cause: RepairCause = 'write_failed';
    if (lower.includes('sql execution failed') || lower.includes('sqlite')) cause = 'sql_exec_failed';
    else if (lower.includes('_meta.json') && (lower.includes('invalid') || lower.includes('parse'))) cause = 'meta_parse_error';
    const targetFiles: string[] = [];
    if (Array.isArray(result.perFile)) {
      for (const pf of result.perFile) {
        if (pf && typeof pf.path === 'string') targetFiles.push(pf.path);
      }
    }
    return { cause, targetFiles, snippet: msg };
  }
  // run_test result shape: { passed: number, total: number, failures: [{name, error}] }
  // failures 是数组,用 .length 判断;同时兼容 passed<total / results[].passed 形状。
  if (toolName === 'run_test') {
    const failuresCount = Array.isArray(result.failures)
      ? result.failures.length
      : (typeof result.failures === 'number' ? result.failures : 0);
    const failed = failuresCount > 0
      || (typeof result.passed === 'number' && typeof result.total === 'number' && result.passed < result.total)
      || result.passed === false
      || (Array.isArray(result.results) && result.results.some((r: any) => r?.passed === false));
    if (failed) {
      const snippet = JSON.stringify(result).slice(0, 500);
      return { cause: 'run_test_failed', targetFiles: ['test.ts', 'controller.ts'], snippet };
    }
  }
  return null;
}

/**
 * Subset of the tool surface for watchdog nudge rounds.
 *
 * When `restrictedToWrite=true`, only writing primitives are exposed —
 * removing the "preparation" tools (set_module_intent / get_module_template /
 * list_modules / inspect_module) that some weak models loop on instead of
 * actually writing files. read_file stays in case the model needs to peek
 * at something it wrote partially. delete_module / run_test / manage_data
 * still belong to the workflow tail, kept available.
 */
const NUDGE_TOOL_ALLOWLIST = new Set([
  'emit_params',   // Step-Workflow-1:nudge 时如果还没 emit_params,允许补
  'write_file',
  'write_files',
  'patch_file',
  'read_file',
  'run_test',
  'manage_data',
  // 注意:**不要**加 delete_module — 弱模型把 delete_module 当"重启路径"调,
  // 会删掉之前已经写入(含种子)的表,然后再新写 schema 漏字段 → INSERTs 错位,
  // 最终模块"被自己删空"。要求 AI 在错误状态下也只能修不能删。
]);

export function buildToolsForNudge(userId: number, runner?: ChatRunner) {
  const all = buildTools(userId, runner);
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (NUDGE_TOOL_ALLOWLIST.has(k)) filtered[k] = v;
  }
  return filtered as ReturnType<typeof buildTools>;
}

/**
 * Step-Workflow-1:per-cause repair cap 触发后用的只读工具集,只允许 AI 输出
 * 文字总结/读取自己之前写过的文件。彻底禁止再写 / 再测,强制让 AI 收尾。
 */
const READ_ONLY_TOOL_ALLOWLIST = new Set([
  'read_file',
  'list_modules',
]);

export function buildToolsForReadOnly(userId: number, runner?: ChatRunner) {
  const all = buildTools(userId, runner);
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (READ_ONLY_TOOL_ALLOWLIST.has(k)) filtered[k] = v;
  }
  return filtered as ReturnType<typeof buildTools>;
}

/**
 * Step-Workflow-1 gate:write_files / write_file / run_test 等改写类工具
 * 必须在 emit_params 之后才能调用。返 null = 通过,返对象 = reject 结果。
 */
function paramsGate(runner: ChatRunner | undefined, toolName: string) {
  if (!runner) return null;  // 单测/无 runner 上下文豁免
  if (runner.hasParams()) return null;
  return {
    success: false,
    error:
      `[阶段错误] 调用 ${toolName} 之前必须先调用 emit_params 输出本模块的结构化参数。\n`
      + `框架按强制工作流执行:set_module_intent → emit_params → write_files → run_test → patch_file(修复)。\n`
      + `请先调 emit_params({ moduleName, fieldNaming, envelope, entities, endpoints, ... }),框架校验通过后才能继续。`,
  };
}

export function buildTools(userId: number, runner?: ChatRunner) {
  const sessionId = runner?.sessionId;

  /** Serialize write-side tool bodies per-session. Reads stay parallel. */
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    if (!runner) return fn();
    return runSerialized(runner.sessionId, fn);
  };

  /**
   * Wrap a tool body with observability emit.
   * Records tool_timing + repair_triggered (if the result indicates failure that
   * the LLM will need to repair). Failures inside the wrapper are silenced so
   * observability never breaks a tool call.
   */
  const instrument = async <T>(toolName: string, argSummary: Record<string, unknown> | undefined, fn: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    let res: T;
    try {
      res = await fn();
    } catch (err) {
      if (sessionId) {
        try { emitToolTiming(sessionId, toolName, startedAt, 'error: ' + String((err as Error)?.message || err).slice(0, 100), argSummary); } catch { /* silent */ }
      }
      throw err;
    }
    if (sessionId) {
      try {
        const summary = (res && typeof res === 'object' && (res as any).success === false) ? 'error' : 'ok';
        emitToolTiming(sessionId, toolName, startedAt, summary, argSummary);
        const failure = classifyFailure(toolName, res);
        if (failure) {
          const attempt = bumpRepairAttempt(sessionId, failure.cause);
          emitRepair(sessionId, failure.cause, attempt, failure.snippet, failure.targetFiles);
        }
      } catch { /* silent */ }
    }
    return res;
  };

  return {
    set_module_intent: tool({
      description:
        '【必须在开始生成前调用】声明本次要创建或修改的模块。**重要**：此工具只声明意图，'
        + '不代表已完成。调用本工具后你必须紧接着调用 write_files（优先）或多次 write_file '
        + '把 5 个必需文件（_meta.json / schema.sql / controller.ts / test.ts / api-doc.md）'
        + '落盘。不允许只声明意图就结束回复——框架会检测空产出并自动注入提示强制重试，'
        + '两次后仍空会终止并报错。\n\n'
        + 'moduleName 优先从用户消息里提取(如"模块名: xxx" / "create xxx module");'
        + '用户没明示就**你自己想一个**snake_case 英文名(基于业务关键词,如"订单管理"→ "order"、'
        + '"直签酒店财务"→ "hotel_finance")。**不要传空字符串**。',
      parameters: z.object({
        moduleName: z.string().optional().describe('Module name (英文 snake_case)。可省略 — 框架会从用户消息推断;推断失败会报错让你重试时显式提供'),
        operation: z.enum(['create', 'edit']).optional().describe('create = 新建模块; edit = 修改已有模块。可省略 — 框架按模块是否存在自动判断'),
      }),
      execute: async ({ moduleName, operation }) => {
        if (!runner) {
          return { success: true, message: 'No runner context', moduleName, operation };
        }
        // moduleName 为空时从 user content 兜底提取(claude / gpt-4 等强模型实测有时会传 args={},
        // zod schema 强制 required 会让 tool_result 永不返回 → runner 卡死;改 optional + 推断更稳)。
        let effectiveName = (typeof moduleName === 'string' && moduleName.trim()) ? moduleName.trim() : '';
        if (!effectiveName) {
          const userContent = runner.getCurrentUserContent() || '';
          // 匹配 "模块名必须是: \"xxx\"" / "moduleName: xxx" / "模块名:xxx" 等常见格式
          const patterns = [
            /模块名(?:必须是|是|:)?\s*[":：]?\s*["'`]?([a-zA-Z][a-zA-Z0-9_]+)["'`]?/,
            /moduleName\s*[:=]\s*["'`]?([a-zA-Z][a-zA-Z0-9_]+)["'`]?/i,
            /create\s+(?:an?\s+)?([a-z][a-z0-9_]+)\s+module/i,
          ];
          for (const pat of patterns) {
            const m = userContent.match(pat);
            if (m && m[1]) { effectiveName = m[1]; break; }
          }
        }
        if (!effectiveName) {
          // 给 AI 看的清晰错误,避免卡死;ai-sdk 会把 throw 转 tool_result error 让 AI 重试
          throw new Error(
            'set_module_intent 调用缺少 moduleName。用户消息里没提供模块名,你必须自己想一个 snake_case 英文名'
            + '(基于业务关键词推断,如 "订单管理" → "order"、"hotel_finance" 等),然后**重新调用本工具时传 moduleName**。',
          );
        }
        const result = runner.applyModuleIntent(userId, { moduleName: effectiveName, operation });
        return { success: true, ...result };
      },
    }),
    emit_params: tool({
      description:
        '【强制工作流第 2 步】set_module_intent 之后,你必须先调用本工具,把本次模块的"结构化参数"emit 出来。\n'
        + '框架收到后会:(a) zod schema 强校验;(b) 跨字段一致性校验(端点 entity 是否在 entities 里等);(c) 存到 session 内存,作为后续 write_* / run_test 的前置条件。\n'
        + '不调用 emit_params 就直接 write_files,框架会 reject。\n\n'
        + '你应该一次性把 spec 里所有信息都抽出来:\n'
        + '  - fieldNaming:snake_case / camelCase / PascalCase(看 spec 用什么风格)\n'
        + '  - envelope.default:默认响应信封(successFlag/dataField 字段名,如 { Success, Data, Message } 还是 { success, data, message })\n'
        + '  - envelope.exceptions:某些端点用不同信封时列出(如 spec 说 "API-007 用 IsSuccess")\n'
        + '  - entities:所有实体 + 主键 + 字段 + seedCount(种子数,spec 提了就填)\n'
        + '  - endpoints:每个端点的 method/path/type/entity + customLogic(纯 CRUD 留空,非 CRUD 用一句话描述业务逻辑)\n'
        + '  - pagination(可选):分页字段名 + 位置(flat 顶层 vs nested 包在 paginationInfo 里)',
      parameters: paramsSchema,
      execute: async (input) => {
        const result = emitParams(input);
        if (!result.success) return result;
        if (runner) runner.setParams(result.params);
        return result;
      },
    }),
    write_file: tool({
      description:
        'Write ONE file to generated/{userId}/. Use this when you cannot emit nested array schemas (small models) or when you want to write files one at a time for better control. '
        + 'SQL files auto-execute; _meta.json auto-syncs to modules table. For efficient multi-file writes (5-6 files at once), prefer `write_files` — but if you struggle with its nested schema, fall back to calling `write_file` once per file. '
        + '`content` accepts string OR object/array (will be auto-JSON.stringify-ed) — emit native JSON for _meta.json if more natural.\n\n'
        + '**禁用条件**:进入修复阶段(run_test 已调过)后,本工具被锁定。修 bug 必须用 patch_file 局部修改。',
      parameters: z.object({
        path: z.string().describe('File path relative to generated/{userId}/, e.g., "order/_meta.json"'),
        // content 接受 string | object | array:LLM 写 _meta.json 时经常自然 emit object,
        // 强制 string 会让 zod 在 LLM 第一次调用必失败 1 次。框架在这里 normalize 一次性吸收。
        content: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
          .describe('File content. Plain string OR JSON object/array (auto-stringified).'),
      }),
      execute: async ({ path, content }) => {
        const gateRes = paramsGate(runner, 'write_file');
        if (gateRes) return gateRes;
        // Step-Workflow-1:进入修复阶段(run_test 已跑过)后,write_file 整覆盖被锁
        if (runner?.isInRepairPhase()) {
          return {
            success: false,
            error:
              '[阶段错误] 模块已进入修复阶段(run_test 已调用过)。**禁止用 write_file 整覆盖修复**,必须用 patch_file 做局部修改。\n'
              + '调用格式:patch_file({ path, oldText: <要替换的精确片段>, newText: <新片段>, reason: <说明改什么/为什么> })\n'
              + '单次 patch 上限:diff size ≤ 文件总字符数 30%,newText/oldText 比 ∈ [0.3, 3.0]。',
          };
        }
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        const finalPath = autoPrefixModulePath(path, runner?.getModuleName());
        const result = await instrument('write_file', { path: finalPath, contentBytes: text.length }, () =>
          serialize(() => writeFile(userId, finalPath, text)),
        );
        if (runner) runner.markFirstWriteDone();
        return result;
      },
    }),

    write_files: tool({
      description:
        'PREFERRED when your model reliably emits nested array schemas (Claude/GPT-4/large Gemini). '
        + 'Writes multiple files atomically in ONE call — up to 5-6× faster than looping `write_file`. '
        + 'SQL files auto-execute; _meta.json auto-syncs to modules table. If any side-effect fails, the whole batch rolls back on both filesystem and DB. '
        + 'If you attempt this and get "no files provided" errors, switch to `write_file` (single-file) instead. '
        + 'Each file\'s `content` accepts string OR object/array (auto-stringified). '
        + '`files` itself also accepts stringified JSON (framework auto-parses).',
      parameters: z.object({
        files: z.preprocess(
          parseIfStringified,
          z.array(z.object({
            path: z.string().describe('File path relative to generated/{userId}/, e.g., "order/_meta.json"'),
            content: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
              .describe('File content. String OR JSON object/array (auto-stringified).'),
          })).min(1),
        ).describe('Array of { path, content }. Schema.sql should come before _meta.json. Accepts either a real array or a stringified JSON array.'),
      }),
      execute: async ({ files }) => {
        const gateRes = paramsGate(runner, 'write_files');
        if (gateRes) return gateRes;
        if (runner?.isInRepairPhase()) {
          return {
            success: false,
            error:
              '[阶段错误] 模块已进入修复阶段(run_test 已调用过)。**禁止用 write_files 整覆盖修复**,必须用 patch_file 做局部修改。\n'
              + 'patch_file({ path, oldText, newText, reason }) — 单次 diff ≤ 30% 文件,newText/oldText 比 ∈ [0.3, 3.0]。',
          };
        }
        const moduleName = runner?.getModuleName();
        const normalized = (files ?? []).map((f) => ({
          path: autoPrefixModulePath(f.path, moduleName),
          content: typeof f.content === 'string' ? f.content : JSON.stringify(f.content, null, 2),
        }));
        const result = await instrument(
          'write_files',
          { fileCount: normalized.length, paths: normalized.slice(0, 8).map((f) => f.path) },
          () => serialize(() => writeFiles(userId, { files: normalized })),
        );
        if (runner) runner.markFirstWriteDone();
        return result;
      },
    }),

    read_file: tool({
      description: 'Read a file from generated/{userId}/ directory.',
      parameters: z.object({
        path: z.string().describe('File path relative to the module directory, e.g., "order/controller.ts"'),
      }),
      execute: async ({ path }) => {
        return readFile(userId, path);
      },
    }),

    patch_file: tool({
      description:
        '【修复阶段专用】对已存在文件做精确局部修改。强制"只改不重写":\n'
        + '  - oldText 必须精确匹配文件中**唯一**一段(0/2+ 处都 reject)\n'
        + '  - newText/oldText 字符数比 ∈ [0.3, 3.0],单次 diff ≤ 30% 文件总字符\n'
        + '  - reason 必填,说明改什么 + 为什么\n'
        + '修 SQL 时框架会重新 exec(CREATE IF NOT EXISTS + INSERT OR IGNORE 是幂等的);修 _meta.json 会重新合约校验 + 同步到 modules 表。\n'
        + '若 patch 超过比例上限,意味着思路根本变了 — 拆成多次小 patch,每次只动一处。',
      parameters: z.object({
        path: z.string().describe('文件路径(同 write_file 规则,如 "order/controller.ts")'),
        oldText: z.string().describe('要替换的精确片段(包括空格/换行)。必须在文件中唯一出现 1 次'),
        newText: z.string().describe('替换后的新片段'),
        reason: z.string().describe('修改原因,≥ 5 字符。例:"修复 BaseModel 不接受对象 orderBy 改为字符串"'),
      }),
      execute: async ({ path, oldText, newText, reason }) => {
        const gateRes = paramsGate(runner, 'patch_file');
        if (gateRes) return gateRes;
        const finalPath = autoPrefixModulePath(path, runner?.getModuleName());
        return instrument('patch_file', { path: finalPath, oldLen: oldText.length, newLen: newText.length, reason: reason.slice(0, 60) }, () =>
          serialize(() => patchFile(userId, { path: finalPath, oldText, newText, reason })),
        );
      },
    }),

    run_test: tool({
      description: 'Execute test.ts for a module. Clears test data first, then runs all test cases.',
      parameters: z.object({
        moduleName: z.string().describe('Module name to test'),
      }),
      execute: async ({ moduleName }) => {
        const gateRes = paramsGate(runner, 'run_test');
        if (gateRes) return gateRes;
        if (runner) runner.bumpRunTestCalls();
        return instrument('run_test', { moduleName }, () => serialize(() => runTest(userId, moduleName)));
      },
    }),

    manage_data: tool({
      description:
        'Read or modify mock records of a module. Actions:\n'
        + '  • list — paginated read; pass page/pageSize/where to filter; returns { list, total }. ALWAYS list first to find the record id before update/delete.\n'
        + '  • insert — create one record; pass data (object).\n'
        + '  • update — patch ONE record by id; pass id + data (only the fields you want to change).\n'
        + '  • delete — remove ONE record by id.\n'
        + '  • batch_delete — remove many records by ids array.\n'
        + '  • clear — wipe ALL records of the entity. **Only use when user explicitly asks to clear all data.**\n'
        + '  • bulk_generate — seed N random records via faker.\n'
        + '\n'
        + 'CRITICAL: If user asks to modify the Nth record / a specific record, the correct flow is\n'
        + '  list({ page:1, pageSize:N }) → pick id → update({ id, data: { field: newValue } }).\n'
        + 'NEVER use clear + bulk_generate + insert as a substitute for update — it destroys other rows.',
      parameters: z.object({
        action: z.enum(['list', 'insert', 'update', 'delete', 'batch_delete', 'clear', 'bulk_generate']).describe('Operation to perform'),
        moduleName: z.string().describe('Module name'),
        data: z.preprocess(parseIfStringified, z.record(z.string(), z.unknown()).optional())
          .describe('Record data (for insert / update — partial fields ok for update). Accepts object or stringified JSON object.'),
        id: z.number().optional().describe('Record id (for update / delete)'),
        ids: z.preprocess(parseIfStringified, z.array(z.number()).optional())
          .describe('Record ids (for batch_delete). Accepts array or stringified JSON array.'),
        count: z.number().optional().describe('Number of records to generate (for bulk_generate)'),
        page: z.number().optional().describe('Page number, 1-based (for list)'),
        pageSize: z.number().optional().describe('Records per page (for list, default 20)'),
        where: z.preprocess(parseIfStringified, z.record(z.string(), z.unknown()).optional())
          .describe('Filter conditions (for list, e.g. { status: "active" }). Accepts object or stringified JSON object.'),
        entityName: z.string().optional().describe('Entity name (defaults to first entity in _meta.json)'),
      }),
      execute: async ({ action, moduleName, data, count, id, ids, page, pageSize, where, entityName }) =>
        instrument('manage_data', { action, moduleName }, () =>
          serialize(() => manageData(userId, action, moduleName, data, { count, id, ids, page, pageSize, where, entityName })),
        ),
    }),

    list_modules: tool({
      description: 'List all modules owned by the current user.',
      parameters: z.object({}),
      execute: async () => {
        return listModules(userId);
      },
    }),

    delete_module: tool({
      description:
        'Delete a module completely: drop tables, delete files, remove from database. '
        + '**Refuses** to delete the module that the current session is creating/editing — '
        + 'using delete_module as an "undo" shortcut is destructive (it drops seed tables) '
        + 'and will leave the new files inconsistent. If you need to fix a bad generation, '
        + 'use write_files/write_file to overwrite or run_test to validate fixes.',
      parameters: z.object({
        moduleName: z.string().describe('Module name to delete'),
      }),
      execute: async ({ moduleName }) => {
        // Guard:不允许 AI 在生成/修改自己正在做的模块时调 delete_module。
        // 弱模型偶尔把 delete_module 当"撤销重来"用,会删掉已经写入的种子数据
        // 表,然后再写新 schema 漏字段 → INSERTs 错位,模块"被自己删空"。
        if (runner && runner.getModuleName() === moduleName) {
          return {
            success: false,
            error:
              `Refused: delete_module is blocked for "${moduleName}" because the current session is actively creating/editing it. `
              + 'Calling delete_module here is destructive — it drops any seed data tables your earlier schema.sql wrote, '
              + 'and the rewrite-from-scratch cycle frequently lands in an inconsistent state. '
              + 'Instead: use write_files/write_file to overwrite the problematic files (controller/test/etc.), then re-run run_test.',
          };
        }
        return serialize(() => deleteModule(userId, moduleName));
      },
    }),

    get_module_template: tool({
      description: 'Fetch a complete file-by-file module sample when you need a reference for generating a new module. Kinds: "crud-basic" (minimal 5-file todo sample) or "with-constraints" (shows _meta.json field + cross-field constraints). Call this only if the user asks something you are unsure how to structure.',
      parameters: z.object({
        kind: z.enum(['crud-basic', 'with-constraints']).describe('Template flavor'),
      }),
      execute: async ({ kind }) => {
        return fetchModuleTemplate(kind);
      },
    }),
  };
}
