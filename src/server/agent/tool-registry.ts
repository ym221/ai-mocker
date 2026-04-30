import { z } from 'zod';
import { tool } from 'ai';
import { writeFile } from './tools/write-file.js';
import { writeFiles } from './tools/write-files.js';
import { readFile } from './tools/read-file.js';
import { runTest } from './tools/run-test.js';
import { manageData } from './tools/manage-data.js';
import { listModules } from './tools/list-modules.js';
import { deleteModule } from './tools/delete-module.js';
import { fetchModuleTemplate } from './tools/get-module-template.js';
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
  // run_test failure: result format = { success: bool, ... } or has failures
  if (toolName === 'run_test') {
    const failed = result.passed === false || result.failures > 0 || (Array.isArray(result.results) && result.results.some((r: any) => r?.passed === false));
    if (failed) {
      const snippet = JSON.stringify(result).slice(0, 500);
      return { cause: 'run_test_failed', targetFiles: ['test.ts', 'controller.ts'], snippet };
    }
  }
  return null;
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
        + '两次后仍空会终止并报错。',
      parameters: z.object({
        moduleName: z.string().describe('Module name (英文，与文件目录一致)'),
        operation: z.enum(['create', 'edit']).describe('create = 新建模块; edit = 修改已有模块'),
      }),
      execute: async ({ moduleName, operation }) => {
        if (!runner) {
          return { success: true, message: 'No runner context', moduleName, operation };
        }
        const result = runner.applyModuleIntent(userId, { moduleName, operation });
        return { success: true, ...result };
      },
    }),
    write_file: tool({
      description:
        'Write ONE file to generated/{userId}/. Use this when you cannot emit nested array schemas (small models) or when you want to write files one at a time for better control. '
        + 'SQL files auto-execute; _meta.json auto-syncs to modules table. For efficient multi-file writes (5-6 files at once), prefer `write_files` — but if you struggle with its nested schema, fall back to calling `write_file` once per file.',
      parameters: z.object({
        path: z.string().describe('File path relative to generated/{userId}/, e.g., "order/_meta.json"'),
        content: z.string().describe('Full file content'),
      }),
      execute: async ({ path, content }) =>
        instrument('write_file', { path, contentBytes: content?.length ?? 0 }, () =>
          serialize(() => writeFile(userId, path, content)),
        ),
    }),

    write_files: tool({
      description:
        'PREFERRED when your model reliably emits nested array schemas (Claude/GPT-4/large Gemini). '
        + 'Writes multiple files atomically in ONE call — up to 5-6× faster than looping `write_file`. '
        + 'SQL files auto-execute; _meta.json auto-syncs to modules table. If any side-effect fails, the whole batch rolls back on both filesystem and DB. '
        + 'If you attempt this and get "no files provided" errors, switch to `write_file` (single-file) instead.',
      parameters: z.object({
        files: z.array(z.object({
          path: z.string().describe('File path relative to generated/{userId}/, e.g., "order/_meta.json"'),
          content: z.string().describe('File content'),
        })).min(1).describe('Array of { path, content }. Keep ordering meaningful: schema.sql should come before _meta.json.'),
      }),
      execute: async ({ files }) =>
        instrument(
          'write_files',
          { fileCount: files?.length ?? 0, paths: (files ?? []).slice(0, 8).map((f) => f.path) },
          () => serialize(() => writeFiles(userId, { files })),
        ),
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

    run_test: tool({
      description: 'Execute test.ts for a module. Clears test data first, then runs all test cases.',
      parameters: z.object({
        moduleName: z.string().describe('Module name to test'),
      }),
      execute: async ({ moduleName }) =>
        instrument('run_test', { moduleName }, () => serialize(() => runTest(userId, moduleName))),
    }),

    manage_data: tool({
      description: 'Manage mock data: insert, bulk_generate, delete, or clear records.',
      parameters: z.object({
        action: z.enum(['insert', 'bulk_generate', 'delete', 'clear']).describe('Action to perform'),
        moduleName: z.string().describe('Module name'),
        data: z.record(z.unknown()).optional().describe('Record data (for insert)'),
        count: z.number().optional().describe('Number of records to generate (for bulk_generate)'),
        id: z.number().optional().describe('Record ID (for delete)'),
        entityName: z.string().optional().describe('Entity name (defaults to first entity in _meta.json)'),
      }),
      execute: async ({ action, moduleName, data, count, id, entityName }) =>
        instrument('manage_data', { action, moduleName }, () =>
          serialize(() => manageData(userId, action, moduleName, data, { count, id, entityName })),
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
      description: 'Delete a module completely: drop tables, delete files, remove from database.',
      parameters: z.object({
        moduleName: z.string().describe('Module name to delete'),
      }),
      execute: async ({ moduleName }) => serialize(() => deleteModule(userId, moduleName)),
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
