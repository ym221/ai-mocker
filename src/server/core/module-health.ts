/**
 * 模块健康度检查 — 解耦 session 运行状态与模块物理状态
 *
 * 一个模块被视为"健康"的条件：
 * 1. 必需文件齐全
 * 2. _meta.json 可解析且结构正确
 * 3. 对应的 SQLite 表已创建
 *
 * 即便 session 超时/失败，只要文件齐全 + 表存在 → 模块仍可用。
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';
import { sqlite } from './database.js';
import { mockContext } from './base-model.js';
import { getPrimaryEntity } from './meta-schema.js';

const GENERATED_DIR = resolve('generated');

const REQUIRED_FILES = ['_meta.json', 'schema.sql', 'controller.ts', 'test.ts', 'api-doc.md'];

export type ModuleHealth = 'healthy' | 'degraded' | 'missing';

export interface HealthReport {
  health: ModuleHealth;
  missing: string[];
  metaValid: boolean;
  hasTable: boolean;
  tableName: string | null;
  /** controller.ts 能否被 runtime 动态 import(true = 没 import 错误)。可选,只在 probeController() 走过才填。 */
  controllerLoadable?: boolean;
  /** controllerLoadable=false 时的错误信息(用来给 AI 看修复建议)。 */
  controllerLoadError?: string;
}

export function computeModuleHealth(userId: number, moduleName: string): HealthReport {
  const dir = join(GENERATED_DIR, String(userId), moduleName);
  const missing = REQUIRED_FILES.filter(f => !existsSync(join(dir, f)));

  let metaValid = false;
  let tableName: string | null = null;
  const metaPath = join(dir, '_meta.json');
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      const primary = getPrimaryEntity(meta);
      metaValid = typeof meta.name === 'string'
        && primary != null
        && typeof primary.tableName === 'string';
      if (metaValid && primary) {
        tableName = primary.tableName as string;
      }
    } catch { /* metaValid stays false */ }
  }

  let hasTable = false;
  if (tableName) {
    const bareName = tableName.replace(/^mock__/, '');
    const injected = `mock__${userId}_${bareName}`;
    const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(injected);
    hasTable = !!row;
  }

  let health: ModuleHealth;
  if (missing.length === 0 && metaValid && hasTable) {
    health = 'healthy';
  } else if (missing.length === REQUIRED_FILES.length && !metaValid && !hasTable) {
    health = 'missing';
  } else {
    health = 'degraded';
  }

  return { health, missing, metaValid, hasTable, tableName };
}

/**
 * 真实"加载 controller.ts"探针 — 比 computeModuleHealth 更严格,等同于 mock-router
 * 收到请求时实际 import 一次,捕获 alias 解析失败 / 语法错误 / 顶层 throw 等。
 *
 * 关键场景:production Docker 早期没复制 tsconfig.json,AI 生成的 controller.ts 用
 * `import from '@core/base-model.js'` alias 无法解析 → mock 请求 500 "Cannot find
 * module '/app/core/base-model.js'"。但 computeModuleHealth 只看文件存在不真实 import,
 * 漏报。这个 probe 在 chat-runner finalize 前调一次,真正确保模块"可访问"才放 done。
 *
 * 注:cache busting 用 ?probe=ts 让每次 import 走新模块,不污染缓存。
 */
export async function probeControllerLoadable(userId: number, moduleName: string): Promise<{ ok: boolean; error?: string }> {
  const controllerPath = join(GENERATED_DIR, String(userId), moduleName, 'controller.ts');
  if (!existsSync(controllerPath)) {
    return { ok: false, error: 'controller.ts not found' };
  }
  try {
    const url = pathToFileURL(controllerPath).href + `?probe=${Date.now()}`;
    // mockContext.run 让 controller.ts 内部 BaseModel 的 userId 上下文可用 — 不少 controller
    // 在 module top-level 就 new BaseModel('XXX').withMeta('...') ,withMeta 调用就读 mockContext
    await mockContext.run({ userId }, () => import(url));
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? (err.message || String(err)) : String(err);
    return { ok: false, error: msg };
  }
}
