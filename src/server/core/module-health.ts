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
import { sqlite } from './database.js';
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
