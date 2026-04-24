import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, sqlite } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { computeModuleHealth } from '../../core/module-health.js';
import { readModuleMeta, summarizeEndpoints } from '../../core/openapi-export.js';
import { getEntities } from '../../core/meta-schema.js';
import { getMcpUserId } from '../context.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';

interface AccessLogRow {
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  created_at: string;
}

export function registerGenerateHandoffReportTool(server: McpServer): void {
  server.registerTool(
    'generate_handoff_report',
    {
      title: 'Generate Mock Handoff Report',
      description:
        'Produce a Markdown handoff report for a Mock module: summarizes the contract, module health, recent access log, and any design issues uncovered during development. Give this to the backend team so they know exactly what to implement and where the contract drifted.',
      inputSchema: {
        moduleName: z.string(),
      },
    },
    async ({ moduleName }) => {
      const userId = getMcpUserId();

      const mod = db.select().from(modules)
        .where(and(eq(modules.userId, userId), eq(modules.name, moduleName)))
        .get();
      if (!mod) {
        return mcpError({
          code: MCP_ERROR_CODES.MODULE_NOT_FOUND,
          message: `Module '${moduleName}' not found.`,
          hint: 'Call list_modules to see available modules.',
          moduleName,
        });
      }

      const meta = readModuleMeta(userId, moduleName);
      const health = computeModuleHealth(userId, moduleName);
      const endpoints = summarizeEndpoints(userId, moduleName);

      // 最近 50 条访问日志
      const logs = sqlite.prepare(
        `SELECT method, path, status_code, duration_ms, created_at
           FROM mock_requests
           WHERE user_id = ? AND module_name = ?
           ORDER BY id DESC
           LIMIT 50`
      ).all(userId, moduleName) as AccessLogRow[];

      // 按 status 聚合
      const statusAgg = new Map<number, number>();
      for (const l of logs) statusAgg.set(l.status_code, (statusAgg.get(l.status_code) || 0) + 1);

      // 按 method+path 聚合
      const byEndpoint = new Map<string, { count: number; total: number; sum: number }>();
      for (const l of logs) {
        const k = `${l.method} ${l.path}`;
        const e = byEndpoint.get(k) || { count: 0, total: 0, sum: 0 };
        e.count += 1; e.sum += l.duration_ms;
        byEndpoint.set(k, e);
      }

      // 错误日志（4xx/5xx）
      const errorLogs = logs.filter((l) => l.status_code >= 400);

      const lines: string[] = [];
      lines.push(`# ${mod.displayName || moduleName} Mock 交接报告`);
      lines.push('');
      lines.push(`> 用户: ${userId} · 模块: ${moduleName} · 生成时间: ${new Date().toISOString()}`);
      lines.push('');

      // 契约概要
      lines.push('## 契约概要');
      lines.push('');
      lines.push(`- **Base Path**: \`${mod.basePath}\``);
      lines.push(`- **状态**: ${mod.status}`);
      if (mod.description) lines.push(`- **描述**: ${mod.description}`);
      lines.push('');

      lines.push('### 端点清单');
      if (endpoints.length === 0) {
        lines.push('_（无端点）_');
      } else {
        for (const ep of endpoints) lines.push(`- \`${ep}\``);
      }
      lines.push('');

      // 实体
      const allEntities = getEntities(meta);
      if (allEntities.length) {
        lines.push('### 实体与字段');
        for (const ent of allEntities) {
          lines.push(`**${ent.name}**:`);
          lines.push('| 字段 | 类型 | 必填 |');
          lines.push('|------|------|------|');
          for (const f of ent.fields || []) {
            lines.push(`| ${f.name} | ${f.type || 'string'} | ${f.required ? '是' : '否'} |`);
          }
          lines.push('');
        }
      }

      // 健康度
      lines.push('## 模块健康状态');
      lines.push('');
      lines.push(`- **health**: \`${health.health}\``);
      lines.push(`- **表**: ${health.tableName || 'n/a'} — ${health.hasTable ? '存在' : '缺失'}`);
      if (health.missing.length) lines.push(`- **缺失文件**: ${health.missing.join(', ')}`);
      lines.push('');

      // 访问日志摘要
      lines.push('## 访问日志摘要（最近 50 次）');
      lines.push('');
      if (logs.length === 0) {
        lines.push('_暂无访问记录。业务代码尚未调用过此 Mock。_');
      } else {
        lines.push(`共 **${logs.length}** 条请求，状态码分布：`);
        const statusList = Array.from(statusAgg.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([s, c]) => `${s}×${c}`)
          .join(', ');
        lines.push(`\`${statusList}\``);
        lines.push('');

        lines.push('| 端点 | 次数 | 平均耗时 (ms) |');
        lines.push('|------|------|--------------|');
        for (const [ep, stat] of byEndpoint) {
          lines.push(`| ${ep} | ${stat.count} | ${(stat.sum / stat.count).toFixed(1)} |`);
        }
        lines.push('');
      }

      // 异常
      if (errorLogs.length) {
        lines.push('### 错误请求（4xx/5xx）');
        lines.push('| 方法 | 路径 | 状态 | 时间 |');
        lines.push('|------|------|------|------|');
        for (const l of errorLogs.slice(0, 20)) {
          lines.push(`| ${l.method} | ${l.path} | ${l.status_code} | ${l.created_at} |`);
        }
        lines.push('');
      }

      // 后端交接建议
      lines.push('## 后端交接建议');
      lines.push('');
      lines.push('- 实现上述端点，响应结构遵循 `{ success, message, data }` 信封（已在 Mock 中验证）。');
      lines.push('- 列表端点按 `{ list, total, page, pageSize }` 结构返回；删除返回 `data: null`。');
      lines.push('- 所有实体默认带 `id` / `created_at` / `updated_at` 三个字段。');
      if (errorLogs.length) {
        lines.push('- **⚠ 注意**: 业务代码在测试期间产生了 4xx/5xx 请求，请核对请求体是否符合实体字段契约。');
      }
      lines.push('');

      lines.push('---');
      lines.push('_由 MockForge MCP 工具 `generate_handoff_report` 自动生成。_');

      const markdown = lines.join('\n');

      return {
        content: [{ type: 'text', text: markdown }],
        structuredContent: {
          moduleName,
          markdown,
          stats: {
            totalRequests: logs.length,
            errorCount: errorLogs.length,
            endpointCount: endpoints.length,
            health: health.health,
          },
        },
      };
    }
  );
}
