/**
 * Snapshot + diff helpers for update_module.
 *
 * Extracted from update-module.ts so the diff logic can be unit-tested
 * directly (controller-bytes / test-name / constraint-id semantics are
 * easy to get wrong, and we want fast feedback when the heuristics drift).
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { readModuleMeta } from '../../core/openapi-export.js';
import { getEntities } from '../../core/meta-schema.js';

const GENERATED_DIR = resolve('generated');

export interface MetaSnapshot {
  entityNames: Set<string>;
  fieldsByEntity: Map<string, Set<string>>;
  endpoints: Set<string>;
  constraintIds: Set<string>;
  testNames: Set<string>;
  controllerErrorBranches: number;
  controllerBytes: number;
  apiDocLines: number;
}

function readFileSafe(userId: number, moduleName: string, name: string): string {
  const p = join(GENERATED_DIR, String(userId), moduleName, name);
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}

export function extractTestNames(src: string): Set<string> {
  const out = new Set<string>();
  // 匹配 test('...') / test("...") — 与 @core/test-runner.js 的 API 对齐
  const re = /\btest\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[2]);
  return out;
}

export function countErrorBranches(src: string): number {
  // 启发式: 统计能带来 4xx 响应的 return / throw 行
  const patterns = [
    /\breturn\s*\{[^}]*success\s*:\s*false/g,
    /\bstatusCode\s*:\s*[34]\d\d/g,
    /\bthrow\s+new\s+(?:Validation)?Error/g,
  ];
  let total = 0;
  for (const p of patterns) {
    const m = src.match(p);
    if (m) total += m.length;
  }
  return total;
}

export function constraintFingerprint(c: { id?: string; when: unknown; must: unknown }): string {
  if (c.id) return c.id;
  return `${JSON.stringify(c.when)}=>${JSON.stringify(c.must)}`;
}

export function snapshotMeta(userId: number, moduleName: string): MetaSnapshot {
  const meta = readModuleMeta(userId, moduleName);
  const entityNames = new Set<string>();
  const fieldsByEntity = new Map<string, Set<string>>();
  const constraintIds = new Set<string>();
  for (const ent of getEntities(meta)) {
    entityNames.add(ent.name);
    fieldsByEntity.set(ent.name, new Set((ent.fields || []).map((f) => f.name)));
    for (const c of ent.constraints || []) {
      constraintIds.add(constraintFingerprint(c));
    }
  }
  const endpoints = new Set((meta?.endpoints || []).map((ep) => `${String(ep.method || '').toUpperCase()} ${ep.path || ''}`));

  const testSrc = readFileSafe(userId, moduleName, 'test.ts');
  const controllerSrc = readFileSafe(userId, moduleName, 'controller.ts');
  const apiDoc = readFileSafe(userId, moduleName, 'api-doc.md');

  return {
    entityNames,
    fieldsByEntity,
    endpoints,
    constraintIds,
    testNames: extractTestNames(testSrc),
    controllerErrorBranches: countErrorBranches(controllerSrc),
    controllerBytes: controllerSrc.length,
    apiDocLines: apiDoc ? apiDoc.split('\n').length : 0,
  };
}

export interface RichDiff {
  lines: string[];
  warnings: string[];
  hasChange: boolean;
}

export function diffSnapshots(before: MetaSnapshot, after: MetaSnapshot): RichDiff {
  const lines: string[] = [];
  const warnings: string[] = [];

  // === structural ===
  for (const n of after.entityNames) if (!before.entityNames.has(n)) lines.push(`+entity ${n}`);
  for (const n of before.entityNames) if (!after.entityNames.has(n)) lines.push(`-entity ${n}`);

  for (const [name, afterFields] of after.fieldsByEntity) {
    const beforeFields = before.fieldsByEntity.get(name) || new Set();
    for (const f of afterFields) if (!beforeFields.has(f)) lines.push(`+field ${name}.${f}`);
    for (const f of beforeFields) if (!afterFields.has(f)) lines.push(`-field ${name}.${f}`);
  }

  for (const ep of after.endpoints) if (!before.endpoints.has(ep)) lines.push(`+endpoint ${ep}`);
  for (const ep of before.endpoints) if (!after.endpoints.has(ep)) lines.push(`-endpoint ${ep}`);

  // === constraints ===
  for (const c of after.constraintIds) if (!before.constraintIds.has(c)) lines.push(`+constraint ${c}`);
  for (const c of before.constraintIds) if (!after.constraintIds.has(c)) lines.push(`-constraint ${c}`);

  // === test cases ===
  for (const t of after.testNames) if (!before.testNames.has(t)) lines.push(`+test "${t}"`);
  for (const t of before.testNames) if (!after.testNames.has(t)) lines.push(`-test "${t}"`);

  // === controller / api-doc content drift (warnings, not bullet lines) ===
  if (after.controllerBytes !== before.controllerBytes || after.controllerErrorBranches !== before.controllerErrorBranches) {
    const branchDelta = after.controllerErrorBranches - before.controllerErrorBranches;
    const byteDelta = after.controllerBytes - before.controllerBytes;
    warnings.push(`controller.ts changed (bytes ${byteDelta >= 0 ? '+' : ''}${byteDelta}, error-branches ${branchDelta >= 0 ? '+' : ''}${branchDelta})`);
  }
  if (after.apiDocLines !== before.apiDocLines) {
    const d = after.apiDocLines - before.apiDocLines;
    warnings.push(`api-doc.md ${d >= 0 ? '+' : ''}${d} lines`);
  }

  // === silent no-op detection ===
  const hasChange = lines.length > 0 || warnings.length > 0;
  if (!hasChange) {
    warnings.push('AI claimed change but no structural or content delta detected — consider a more explicit instruction (which fields/files to touch).');
  }

  return { lines, warnings, hasChange };
}
