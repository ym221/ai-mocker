import { z } from 'zod';
import { tool } from 'ai';
import { writeFile } from './tools/write-file.js';
import { readFile } from './tools/read-file.js';
import { runTest } from './tools/run-test.js';
import { manageData } from './tools/manage-data.js';
import { listModules } from './tools/list-modules.js';
import { deleteModule } from './tools/delete-module.js';

export function buildTools(userId: number) {
  return {
    write_file: tool({
      description: 'Write a file to generated/{userId}/ directory. SQL files are auto-executed. _meta.json auto-syncs to modules table.',
      parameters: z.object({
        path: z.string().describe('File path relative to the module directory, e.g., "order/_meta.json"'),
        content: z.string().describe('File content'),
      }),
      execute: async ({ path, content }) => {
        return writeFile(userId, path, content);
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

    run_test: tool({
      description: 'Execute test.ts for a module. Clears test data first, then runs all test cases.',
      parameters: z.object({
        moduleName: z.string().describe('Module name to test'),
      }),
      execute: async ({ moduleName }) => {
        return runTest(userId, moduleName);
      },
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
      execute: async ({ action, moduleName, data, count, id, entityName }) => {
        return manageData(userId, action, moduleName, data, { count, id, entityName });
      },
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
      execute: async ({ moduleName }) => {
        return deleteModule(userId, moduleName);
      },
    }),
  };
}
