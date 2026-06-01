/**
 * patch_module_field — deterministic 字段级修改,无 LLM,秒级返回。
 *
 * 支持的操作:
 *   - rename:           _meta + schema.sql + ALTER COLUMN + controller/test 单词边界替换
 *   - add:              _meta + schema.sql + ALTER ADD COLUMN(controller 不动 — 新字段无引用)
 *   - remove:           _meta + schema.sql + ALTER DROP COLUMN + controller/test 单词边界替换
 *   - change_constraint: 只动 _meta.json field 约束(enum/min/max/pattern/required/unique/default)
 *
 * 不支持(直接 fallback 提示走 update_module):
 *   - change_type:       SQLite 不能原地改类型,且 controller 响应可能受影响
 *
 * 失败回滚:任一步失败 → 恢复 4 个文件快照 + DB 事务回滚。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { sqlite } from '../../core/database.js';
import { getMcpUser } from '../context.js';
import { computeModuleHealth } from '../../core/module-health.js';
import { MCP_ERROR_CODES, mcpError } from '../lib/error-codes.js';
import { validateMetaContract } from '../../agent/tools/meta-contract.js';
import { getEntities, type MetaField } from '../../core/meta-schema.js';

const GENERATED_DIR = resolve('generated');
const REQUIRED_FILES = ['_meta.json', 'schema.sql', 'controller.ts', 'test.ts'];

type Op = 'rename' | 'add' | 'remove' | 'change_constraint' | 'change_type';

interface FieldConstraint {
  required?: boolean;
  enum?: Array<string | number>;
  min?: number;
  max?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  unique?: boolean;
  default?: unknown;
  description?: string;
}

// ============================================================================
// Snapshot / restore
// ============================================================================

interface Snapshot {
  files: Map<string, string | null>;  // path → content (null = didn't exist before)
}

function snapshotFiles(dir: string): Snapshot {
  const files = new Map<string, string | null>();
  for (const f of REQUIRED_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) {
      try { files.set(p, readFileSync(p, 'utf-8')); } catch { files.set(p, null); }
    } else {
      files.set(p, null);
    }
  }
  return { files };
}

function restoreSnapshot(snap: Snapshot): void {
  for (const [p, content] of snap.files) {
    if (content == null) continue;  // didn't exist; skip
    try { writeFileSync(p, content, 'utf-8'); } catch { /* best effort */ }
  }
}

// ============================================================================
// schema.sql text mutation
// ============================================================================

/**
 * In-place modify schema.sql text for a given table's column list.
 * Returns updated SQL text or throws if the table can't be located.
 */
function mutateSchemaSqlText(
  sqlText: string,
  bareTableName: string,
  mutation: (cols: string[]) => string[],
): string {
  // Match CREATE TABLE <table> ( ... )
  // Use a tolerant regex: bareTableName may appear with or without backticks,
  // possibly prefixed with mock__ if AI pre-injected.
  const candidates = [bareTableName, `mock__${bareTableName}`, bareTableName.replace(/^mock__/, '')];
  for (const cand of candidates) {
    const re = new RegExp(
      `(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\`?${cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?\\s*\\()([\\s\\S]*?)(\\)\\s*;?)`,
      'i',
    );
    const m = sqlText.match(re);
    if (!m) continue;
    const [whole, head, body, tail] = m;
    // Split body into column / constraint lines respecting paren depth
    const lines: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        lines.push(body.slice(start, i));
        start = i + 1;
      }
    }
    lines.push(body.slice(start));
    const mutated = mutation(lines);
    const newBody = mutated.join(',');
    return sqlText.replace(whole, head + newBody + tail);
  }
  throw new Error(`Could not locate CREATE TABLE for "${bareTableName}" in schema.sql`);
}

function getColName(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(trimmed)) return null;
  const m = trimmed.match(/^`?([A-Za-z0-9_]+)`?\s+/);
  return m ? m[1] : null;
}

// ============================================================================
// controller.ts / test.ts word-boundary identifier replace
// ============================================================================

function replaceIdentifier(text: string, oldName: string, newName: string): string {
  // Word-boundary match: catches `body.mail`, `item.mail`, `'mail'`, `"mail"`,
  // bare `mail` as identifier; avoids partial matches like `email`.
  const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  return text.replace(re, newName);
}

function removeIdentifierLines(text: string, fieldName: string): string {
  // Best-effort: remove any line that contains the field as a property access
  // (e.g. `delete body.mail;`, `assert.equal(item.mail, ...)`). Too aggressive
  // for safety net; we only warn instead.
  return text;  // intentional no-op for MVP — only emit warning
}

// ============================================================================
// Tool registration
// ============================================================================

export function registerPatchModuleFieldTool(server: McpServer): void {
  server.registerTool(
    'patch_module_field',
    {
      title: 'Patch a Field (Deterministic, No LLM)',
      description:
        'Rename / add / remove / re-constrain a single field of a module. '
        + 'Runs in <5s, no AI generation, no test run. Use this for field-level '
        + 'tweaks instead of update_module to save time. For business-logic changes '
        + 'that need controller-side code edits, use update_module instead.\n'
        + 'Operations:\n'
        + '  • rename:           change field name across _meta.json + schema.sql + controller/test\n'
        + '  • add:              add a new field (type defaults to string)\n'
        + '  • remove:           drop the field from _meta.json + schema; warns if controller still references it\n'
        + '  • change_constraint: tweak field constraint (enum/min/max/pattern/required/unique/default) in _meta.json\n'
        + 'For type changes call update_module — SQLite cannot reliably alter column types in place.',
      inputSchema: {
        moduleName: z.string(),
        op: z.enum(['rename', 'add', 'remove', 'change_constraint', 'change_type']),
        field: z.string().describe('Existing field name (for rename/remove/change_*) or new field name (for add)'),
        newField: z.string().optional().describe('Required for op=rename'),
        type: z.string().optional().describe('Required for op=add (e.g. "string"/"integer"/"text"/"boolean")'),
        constraint: z.record(z.string(), z.unknown()).optional()
          .describe('For op=add or change_constraint: { required, enum, min, max, pattern, minLength, maxLength, unique, default }'),
        entityName: z.string().optional().describe('Defaults to the first entity in _meta.json'),
      },
    },
    async ({ moduleName, op, field, newField, type, constraint, entityName }) => {
      const user = getMcpUser();
      const userId = user.userId;
      const dir = join(GENERATED_DIR, String(userId), moduleName);

      // ---- 1. Existence ----
      if (!existsSync(dir)) {
        return mcpError({
          code: MCP_ERROR_CODES.MODULE_NOT_FOUND,
          message: `Module "${moduleName}" not found.`,
          hint: 'Call list_modules to see available modules.',
          moduleName,
        });
      }

      // ---- 2. change_type fallback ----
      if (op === 'change_type') {
        return mcpError({
          code: MCP_ERROR_CODES.INVALID_INPUT,
          message: `op="change_type" is not supported by patch_module_field — SQLite cannot reliably alter column types in place, and the controller's response shape may also need updating.`,
          hint: 'Call update_module with instruction like "change field X type from string to integer" — AI will handle the migration safely.',
          recovery_steps: [{
            tool: 'update_module',
            args: { moduleName, instruction: `change field ${field} type to ${type ?? '<new-type>'}` },
            description: 'Let AI handle the type migration',
          }],
        });
      }

      // ---- 3. Load _meta.json ----
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

      const entities = getEntities(meta);
      if (entities.length === 0) {
        return mcpError({
          code: MCP_ERROR_CODES.VALIDATION_FAILED,
          message: `Module "${moduleName}" has no entities in _meta.json.`,
          hint: 'Module is malformed. Recreate with create_module_from_spec.',
          moduleName,
        });
      }

      // Pick target entity
      let targetEntityIdx: number;
      if (entityName) {
        targetEntityIdx = entities.findIndex(e => e.name === entityName);
        if (targetEntityIdx < 0) {
          return mcpError({
            code: MCP_ERROR_CODES.INVALID_INPUT,
            message: `Entity "${entityName}" not found in module. Available: ${entities.map(e => e.name).join(', ')}`,
            hint: 'Pass an existing entity name or omit to default to the first.',
            moduleName,
          });
        }
      } else {
        targetEntityIdx = 0;
      }
      const targetEntity = entities[targetEntityIdx];
      const tableName = (targetEntity.tableName as string) || `mock__${targetEntity.name}`;
      const fields: MetaField[] = targetEntity.fields ?? [];
      const fieldIdx = fields.findIndex(f => f.name === field);

      // ---- 4. Per-op precondition ----
      switch (op) {
        case 'rename':
          if (!newField) return mcpError({ code: MCP_ERROR_CODES.INVALID_INPUT, message: 'op=rename requires newField.', hint: 'Pass newField in args.' });
          if (fieldIdx < 0) return mcpError({ code: MCP_ERROR_CODES.INVALID_INPUT, message: `Field "${field}" not found in entity "${targetEntity.name}".`, hint: `Available: ${fields.map(f => f.name).join(', ')}`, moduleName });
          if (fields.some(f => f.name === newField)) return mcpError({ code: MCP_ERROR_CODES.INVALID_INPUT, message: `Field "${newField}" already exists.`, hint: 'Pick a different name.', moduleName });
          break;
        case 'add':
          if (fieldIdx >= 0) return mcpError({ code: MCP_ERROR_CODES.INVALID_INPUT, message: `Field "${field}" already exists.`, hint: 'Use change_constraint to modify it.', moduleName });
          break;
        case 'remove':
        case 'change_constraint':
          if (fieldIdx < 0) return mcpError({ code: MCP_ERROR_CODES.INVALID_INPUT, message: `Field "${field}" not found in entity "${targetEntity.name}".`, hint: `Available: ${fields.map(f => f.name).join(', ')}`, moduleName });
          break;
      }

      // ---- 5. Snapshot ----
      const snapshot = snapshotFiles(dir);

      // Inside-transaction work
      const warnings: string[] = [];
      let affectedFiles: string[] = [];
      const newMeta = JSON.parse(JSON.stringify(meta));  // deep clone
      const newEntities = getEntities(newMeta);
      const newTargetEntity = newEntities[targetEntityIdx];
      const newFields: MetaField[] = newTargetEntity.fields ?? (newTargetEntity.fields = []);

      // ---- 6. Apply op to meta ----
      switch (op) {
        case 'rename':
          newFields[fieldIdx] = { ...newFields[fieldIdx], name: newField! };
          break;
        case 'add': {
          const fldType = type ?? 'string';
          const newF: MetaField = { name: field, type: fldType, ...(constraint as FieldConstraint ?? {}) };
          newFields.push(newF);
          break;
        }
        case 'remove':
          newFields.splice(fieldIdx, 1);
          break;
        case 'change_constraint': {
          if (!constraint) {
            return mcpError({ code: MCP_ERROR_CODES.INVALID_INPUT, message: 'op=change_constraint requires constraint object.', hint: 'Pass constraint: { enum, min, max, required, ... }.' });
          }
          // Merge constraint into field, allowing null to clear
          const existing = newFields[fieldIdx];
          const merged: MetaField = { ...existing };
          for (const [k, v] of Object.entries(constraint)) {
            if (v === null) delete (merged as any)[k];
            else (merged as any)[k] = v;
          }
          newFields[fieldIdx] = merged;
          break;
        }
      }

      // newMeta may have entities or legacy entity layout — getEntities returns
      // a synthesized list. We need to write modifications BACK to the right
      // place in newMeta. If newMeta.entities exists, the modified entity is
      // already in it (by ref). If only legacy newMeta.entity exists,
      // getEntities prepends it — write back manually.
      if (!Array.isArray(newMeta.entities) || newMeta.entities.length === 0) {
        if (targetEntityIdx === 0 && newMeta.entity) {
          newMeta.entity = newTargetEntity;
        }
      } else {
        newMeta.entities[targetEntityIdx] = newTargetEntity;
      }

      // ---- 7. Validate new meta ----
      const check = validateMetaContract(userId, moduleName, newMeta);
      if (!check.ok) {
        return mcpError({
          code: MCP_ERROR_CODES.VALIDATION_FAILED,
          message: `_meta.json contract validation failed after patch: ${check.errors.map(e => e.message).join('; ')}`,
          hint: 'Check field name / constraint format.',
          moduleName,
        });
      }
      const normalizedMeta = check.normalizedMeta;
      const newMetaText = JSON.stringify(normalizedMeta, null, 2);

      // ---- 8. Mutate schema.sql text ----
      const schemaPath = join(dir, 'schema.sql');
      let schemaText = '';
      if (existsSync(schemaPath)) {
        schemaText = readFileSync(schemaPath, 'utf-8');
      }
      let newSchemaText = schemaText;
      try {
        if (op === 'rename') {
          newSchemaText = mutateSchemaSqlText(schemaText, tableName, (lines) => {
            return lines.map(line => {
              const col = getColName(line);
              if (col === field) {
                // Replace just the column name token, preserve def + whitespace.
                // line shape: "  field_name TYPE ..." or backticked variants.
                return line.replace(new RegExp(`(^\\s*\`?)${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\`?\\s+)`), `$1${newField}$2`);
              }
              return line;
            });
          });
        } else if (op === 'add') {
          const fldType = (type ?? 'string').toUpperCase();
          // Map to SQLite-friendly type
          const sqlType =
            fldType === 'INTEGER' || fldType === 'INT' ? 'INTEGER'
            : fldType === 'NUMBER' || fldType === 'DECIMAL' || fldType === 'FLOAT' ? 'REAL'
            : fldType === 'BOOLEAN' ? 'INTEGER'
            : 'TEXT';
          const nullableSuffix = (constraint && (constraint as any).required) ? ' NOT NULL' : '';
          const defaultClause = (constraint && (constraint as any).default !== undefined)
            ? ` DEFAULT ${typeof (constraint as any).default === 'string' ? `'${(constraint as any).default}'` : (constraint as any).default}`
            : '';
          const newLine = `\n  ${field} ${sqlType}${nullableSuffix}${defaultClause}`;
          newSchemaText = mutateSchemaSqlText(schemaText, tableName, (lines) => {
            return [...lines, newLine];
          });
        } else if (op === 'remove') {
          newSchemaText = mutateSchemaSqlText(schemaText, tableName, (lines) => {
            return lines.filter(line => getColName(line) !== field);
          });
        } else if (op === 'change_constraint') {
          // SQL-level constraints (like UNIQUE) — if `unique` changed, we'd need
          // ALTER table to add/drop unique index. For MVP, only sync _meta.json
          // changes and warn if user changed `unique` so they know SQL didn't
          // pick it up.
          if (constraint && 'unique' in constraint) {
            warnings.push('change_constraint with `unique` field only updates _meta.json — to enforce at DB level, recreate the module or run a custom CREATE UNIQUE INDEX.');
          }
        }
      } catch (err) {
        return mcpError({
          code: MCP_ERROR_CODES.INTERNAL_ERROR,
          message: `Failed to mutate schema.sql text: ${(err as Error).message}`,
          hint: 'schema.sql may be malformed. Use update_module to regenerate.',
          moduleName,
        });
      }

      // ---- 9. controller.ts / test.ts identifier replace for rename ----
      const controllerPath = join(dir, 'controller.ts');
      const testPath = join(dir, 'test.ts');
      let newControllerText: string | null = null;
      let newTestText: string | null = null;

      if (op === 'rename') {
        if (existsSync(controllerPath)) {
          const controllerText = readFileSync(controllerPath, 'utf-8');
          newControllerText = replaceIdentifier(controllerText, field, newField!);
          if (newControllerText !== controllerText) affectedFiles.push('controller.ts');
        }
        if (existsSync(testPath)) {
          const testText = readFileSync(testPath, 'utf-8');
          newTestText = replaceIdentifier(testText, field, newField!);
          if (newTestText !== testText) affectedFiles.push('test.ts');
        }
      } else if (op === 'remove') {
        // For remove, only warn — don't auto-modify controller (risk of leaving
        // dangling references but cleaner than silently breaking destructuring).
        if (existsSync(controllerPath)) {
          const ct = readFileSync(controllerPath, 'utf-8');
          if (new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(ct)) {
            warnings.push(`controller.ts still references "${field}" after removal. The endpoint may behave unexpectedly until you call update_module to clean up.`);
          }
        }
      }

      // ---- 10. Apply DB ALTER + write files inside transaction ----
      try {
        const injectedTable = `mock__${userId}_${tableName.replace(/^mock__/, '')}`;
        sqlite.exec('BEGIN');
        try {
          if (op === 'rename') {
            sqlite.exec(`ALTER TABLE \`${injectedTable}\` RENAME COLUMN \`${field}\` TO \`${newField}\``);
          } else if (op === 'add') {
            const fldType = (type ?? 'string').toUpperCase();
            const sqlType =
              fldType === 'INTEGER' || fldType === 'INT' ? 'INTEGER'
              : fldType === 'NUMBER' || fldType === 'DECIMAL' || fldType === 'FLOAT' ? 'REAL'
              : fldType === 'BOOLEAN' ? 'INTEGER'
              : 'TEXT';
            // Default: avoid NOT NULL on add (existing rows can't satisfy without default)
            const defaultClause = (constraint && (constraint as any).default !== undefined)
              ? ` DEFAULT ${typeof (constraint as any).default === 'string' ? `'${(constraint as any).default}'` : (constraint as any).default}`
              : '';
            sqlite.exec(`ALTER TABLE \`${injectedTable}\` ADD COLUMN \`${field}\` ${sqlType}${defaultClause}`);
          } else if (op === 'remove') {
            // SQLite 3.35+ supports DROP COLUMN
            sqlite.exec(`ALTER TABLE \`${injectedTable}\` DROP COLUMN \`${field}\``);
          }
          // change_constraint: no DB schema change (constraints are app-layer via _meta.json)

          // Write all files
          writeFileSync(metaPath, newMetaText, 'utf-8');
          affectedFiles.push('_meta.json');
          if (newSchemaText !== schemaText) {
            writeFileSync(schemaPath, newSchemaText, 'utf-8');
            affectedFiles.push('schema.sql');
          }
          if (newControllerText != null) writeFileSync(controllerPath, newControllerText, 'utf-8');
          if (newTestText != null) writeFileSync(testPath, newTestText, 'utf-8');

          sqlite.exec('COMMIT');
        } catch (err) {
          try { sqlite.exec('ROLLBACK'); } catch { /* ignore */ }
          throw err;
        }
      } catch (err) {
        restoreSnapshot(snapshot);
        return mcpError({
          code: MCP_ERROR_CODES.INTERNAL_ERROR,
          message: `patch_module_field failed: ${(err as Error).message}. Snapshot restored.`,
          hint: 'For complex changes, call update_module instead.',
          recovery_steps: [{
            tool: 'update_module',
            args: { moduleName, instruction: `${op} field ${field}${newField ? ` to ${newField}` : ''}` },
            description: 'Have AI handle this change end-to-end',
          }],
          moduleName,
        });
      }

      // ---- 11. Re-check health ----
      const health = computeModuleHealth(userId, moduleName);

      const diffLine =
        op === 'rename' ? `rename ${targetEntity.name}.${field} → ${newField}`
        : op === 'add' ? `+ ${targetEntity.name}.${field} (${type ?? 'string'})`
        : op === 'remove' ? `- ${targetEntity.name}.${field}`
        : `change_constraint ${targetEntity.name}.${field}`;

      // Dedupe affectedFiles
      affectedFiles = [...new Set(affectedFiles)];

      return {
        content: [{
          type: 'text',
          text: `Patched "${moduleName}": ${diffLine}. Files: ${affectedFiles.join(', ')}.${warnings.length ? `\nWarnings:\n  - ${warnings.join('\n  - ')}` : ''}`,
        }],
        structuredContent: {
          moduleName,
          status: 'patched',
          op,
          diff: [diffLine],
          affectedFiles,
          warnings,
          quality: {
            healthCheck: health.health,
            controllerLoadable: undefined,  // skipped for speed; user can call inspect_module
            smokeTested: 'skipped',
          },
        },
      };
    },
  );
}
