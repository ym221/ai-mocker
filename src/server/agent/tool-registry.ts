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
import type { ChatRunner } from './chat-runner.js';

export function buildTools(userId: number, runner?: ChatRunner) {
  /** Serialize write-side tool bodies per-session. Reads stay parallel. */
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    if (!runner) return fn();
    return runSerialized(runner.sessionId, fn);
  };

  return {
    set_module_intent: tool({
      description: '【必须在开始生成前调用】声明本次要创建或修改的模块。后端会对照数据库纠偏并更新模块状态。',
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
      execute: async ({ path, content }) => serialize(() => writeFile(userId, path, content)),
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
      execute: async ({ files }) => serialize(() => writeFiles(userId, { files })),
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
      execute: async ({ moduleName }) => serialize(() => runTest(userId, moduleName)),
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
        serialize(() => manageData(userId, action, moduleName, data, { count, id, entityName })),
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
