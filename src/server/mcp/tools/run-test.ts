import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runTest } from '../../agent/tools/run-test.js';
import { getMcpUserId } from '../context.js';

export function registerRunTestTool(server: McpServer): void {
  server.registerTool(
    'run_test',
    {
      title: 'Run Module Tests',
      description:
        'Execute the module\'s test.ts (full CRUD regression). Clears test residual data first, then runs every test. Returns passed/total and failure details. Use after update_module to verify the change didn\'t break the module.',
      inputSchema: {
        moduleName: z.string(),
      },
    },
    async ({ moduleName }) => {
      const userId = getMcpUserId();
      try {
        const result = await runTest(userId, moduleName);
        const ok = result.passed === result.total;
        const summary = `${moduleName}: ${result.passed}/${result.total} passed`
          + (result.failures.length
            ? '\nFailures:\n' + result.failures.map((f) => `  - ${f.name}: ${f.error}`).join('\n')
            : '');
        return {
          isError: !ok,
          content: [{ type: 'text', text: summary }],
          structuredContent: {
            moduleName,
            passed: result.passed,
            total: result.total,
            failures: result.failures,
            allPassed: ok,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `run_test failed: ${msg}` }],
        };
      }
    }
  );
}
