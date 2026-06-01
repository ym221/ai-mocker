/**
 * patch_module_endpoint — deterministic endpoint 级修改,无 LLM,秒级返回。
 *
 * 支持(MVP):
 *   - rename_path:    改 _meta.endpoints[i].path(controller 不动 — handler 按 `controller` 字段绑定,与 path 无关)
 *   - change_method:  改 _meta.endpoints[i].method
 *
 * 不支持(fallback 到 update_module):
 *   - add:    需要写新的 handler 函数 + path/type/method 一致,涉及代码生成
 *   - remove: 需要从 controller.ts 删除对应 handler,涉及代码删除
 *
 * 失败回滚:任一步失败 → 恢复 _meta.json 快照。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { getMcpUser } from '../context.js';
import { computeModuleHealth } from '../../core/module-health.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';
import { validateMetaContract } from '../../agent/tools/meta-contract.js';

const GENERATED_DIR = resolve('generated');

export function registerPatchModuleEndpointTool(server: McpServer): void {
  server.registerTool(
    'patch_module_endpoint',
    {
      title: 'Patch an Endpoint (Deterministic, No LLM)',
      description:
        'Rename path / change method of an existing endpoint in <5s, no AI. '
        + 'For add/remove endpoint or changing the handler\'s logic, call update_module instead.\n'
        + 'Operations:\n'
        + '  • rename_path:   change endpoints[i].path\n'
        + '  • change_method: change endpoints[i].method\n'
        + 'Both keep the existing handler (controller.ts) intact — only the routing manifest changes.',
      inputSchema: {
        moduleName: z.string(),
        op: z.enum(['rename_path', 'change_method', 'add', 'remove']),
        method: z.string().describe('Current method (used to locate the endpoint)'),
        path: z.string().describe('Current path (used to locate the endpoint)'),
        newPath: z.string().optional().describe('Required for op=rename_path'),
        newMethod: z.string().optional().describe('Required for op=change_method'),
      },
    },
    async ({ moduleName, op, method, path, newPath, newMethod }) => {
      const user = getMcpUser();
      const userId = user.userId;
      const dir = join(GENERATED_DIR, String(userId), moduleName);

      if (!existsSync(dir)) {
        return mcpError({
          code: MCP_ERROR_CODES.MODULE_NOT_FOUND,
          message: `Module "${moduleName}" not found.`,
          hint: 'Call list_modules to see available modules.',
          moduleName,
        });
      }

      // MVP fallbacks
      if (op === 'add' || op === 'remove') {
        return mcpError({
          code: MCP_ERROR_CODES.INVALID_INPUT,
          message: `op="${op}" requires controller-side handler ${op === 'add' ? 'generation' : 'removal'}, which patch_module_endpoint does not perform.`,
          hint: 'Use update_module — AI will write/remove the handler safely.',
          recovery_steps: [{
            tool: 'update_module',
            args: {
              moduleName,
              instruction: op === 'add'
                ? `add a new endpoint ${method?.toUpperCase()} ${path} (handler should ${path.includes(':') ? 'fetch by id' : 'list rows'})`
                : `remove endpoint ${method?.toUpperCase()} ${path} and its handler`,
            },
            description: `Have AI handle endpoint ${op}`,
          }],
        });
      }

      // ---- Load _meta.json ----
      const metaPath = join(dir, '_meta.json');
      let metaText: string;
      let meta: any;
      try {
        metaText = readFileSync(metaPath, 'utf-8');
        meta = JSON.parse(metaText);
      } catch (err) {
        return mcpError({
          code: MCP_ERROR_CODES.VALIDATION_FAILED,
          message: `Cannot parse _meta.json: ${(err as Error).message}`,
          hint: 'The module may be corrupted. Call inspect_module to investigate.',
          moduleName,
        });
      }

      const endpoints = Array.isArray(meta.endpoints) ? meta.endpoints : [];
      const idx = endpoints.findIndex((e: any) =>
        (e.method ?? '').toLowerCase() === method.toLowerCase()
        && e.path === path
      );
      if (idx < 0) {
        const available = endpoints.map((e: any) => `${(e.method ?? '?').toUpperCase()} ${e.path}`).join(', ');
        return mcpError({
          code: MCP_ERROR_CODES.INVALID_INPUT,
          message: `Endpoint "${method.toUpperCase()} ${path}" not found in module "${moduleName}".`,
          hint: `Available endpoints: ${available || '(none)'}`,
          moduleName,
        });
      }

      // ---- Validate op-specific args ----
      if (op === 'rename_path' && !newPath) {
        return mcpError({ code: MCP_ERROR_CODES.INVALID_INPUT, message: 'op=rename_path requires newPath.', hint: 'Pass newPath in args.' });
      }
      if (op === 'change_method' && !newMethod) {
        return mcpError({ code: MCP_ERROR_CODES.INVALID_INPUT, message: 'op=change_method requires newMethod.', hint: 'Pass newMethod in args.' });
      }

      // ---- Apply ----
      const snapshot = metaText;
      const newMeta = JSON.parse(JSON.stringify(meta));
      if (op === 'rename_path') {
        newMeta.endpoints[idx].path = newPath;
      } else if (op === 'change_method') {
        newMeta.endpoints[idx].method = newMethod!.toUpperCase();
      }

      // Validate
      const check = validateMetaContract(userId, moduleName, newMeta);
      if (!check.ok) {
        return mcpError({
          code: MCP_ERROR_CODES.VALIDATION_FAILED,
          message: `_meta.json contract validation failed: ${check.errors.map(e => e.message).join('; ')}`,
          hint: 'Check that the new path starts with "/" and does not include /mock/ or module-name prefix.',
          moduleName,
        });
      }

      try {
        writeFileSync(metaPath, JSON.stringify(check.normalizedMeta, null, 2), 'utf-8');
      } catch (err) {
        try { writeFileSync(metaPath, snapshot, 'utf-8'); } catch { /* ignore */ }
        return mcpError({
          code: MCP_ERROR_CODES.INTERNAL_ERROR,
          message: `Failed to write _meta.json: ${(err as Error).message}`,
          hint: 'Filesystem error. Snapshot restored.',
          moduleName,
        });
      }

      const health = computeModuleHealth(userId, moduleName);
      const diffLine = op === 'rename_path'
        ? `${method.toUpperCase()} ${path} → ${method.toUpperCase()} ${newPath}`
        : `${method.toUpperCase()} ${path} → ${newMethod!.toUpperCase()} ${path}`;

      return {
        content: [{
          type: 'text',
          text: `Patched endpoint in "${moduleName}": ${diffLine}.`,
        }],
        structuredContent: {
          moduleName,
          status: 'patched',
          op,
          diff: [diffLine],
          affectedFiles: ['_meta.json'],
          quality: {
            healthCheck: health.health,
            smokeTested: 'skipped',
          },
        },
      };
    },
  );
}
