/**
 * patch_file — Step-Workflow-1 阶段 4 修复期专用工具,强制"只改不重写"。
 *
 * 思想:进入修复阶段(run_test 已调过)后,框架在 tool-registry 锁掉 write_file/
 * write_files 的整覆盖能力,AI 只能用 patch_file 做局部修改。每次 patch:
 *   - oldText 必须精确匹配文件中**唯一**一段(0 / ≥2 处都 reject)
 *   - newText/oldText 字符数比 ∈ [0.3, 3.0](超出视为"重写"被 reject)
 *   - 单次改动占比 ≤ 30% 文件总字符数(防止整文件偷换)
 *   - reason 必填,审计 + 让 AI 自己思考改的是什么
 *
 * SQL / _meta.json 的 side-effect 走 writeFile 同款路径(SQL re-exec,_meta sync)。
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { sqlite, db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { eq, and } from 'drizzle-orm';
import { validateMetaContract, formatContractErrors } from './meta-contract.js';
import { injectUserIdToTableNames } from '../../core/table-name-prefix.js';

const GENERATED_DIR = resolve('generated');

export interface PatchFileInput {
  path: string;
  oldText: string;
  newText: string;
  reason: string;
}

export interface PatchFileResult {
  success: boolean;
  message: string;
  diffStats?: {
    fileSize: number;
    oldLen: number;
    newLen: number;
    changeBytes: number;
    changeRatio: number;
  };
  error?: string;
}

// Per-instance config(env 可调,默认值见 Plan)
const MAX_CHANGE_RATIO = Math.min(0.95, Math.max(0.1, Number(process.env.MOCKFORGE_PATCH_MAX_RATIO ?? 0.30)));
const RATIO_LOWER = 0.3;
const RATIO_UPPER = 3.0;

function normalizeUserPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^(?:generated\/)+/, '');
}

function validatePath(userPath: string, userId: number): string {
  const normalized = normalizeUserPath(userPath);
  if (normalized.includes('..') || /^[/\\]/.test(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Invalid path "${userPath}": directory traversal / absolute paths forbidden`);
  }
  const fullPath = resolve(join(GENERATED_DIR, String(userId), normalized));
  const expectedPrefix = resolve(join(GENERATED_DIR, String(userId)));
  if (!fullPath.startsWith(expectedPrefix)) {
    throw new Error(`Invalid path "${userPath}": must be under generated/${userId}/`);
  }
  return fullPath;
}

export async function patchFile(userId: number, input: PatchFileInput): Promise<PatchFileResult> {
  const { path: userPath, oldText, newText, reason } = input;

  // ---- 1. 基础参数校验 ----
  if (!userPath || !oldText || newText == null || !reason) {
    return {
      success: false,
      message: 'patch_file 缺少必填参数。需要: { path, oldText, newText, reason }。reason 用于审计,必须说明改什么 + 为什么。',
      error: 'missing required arg',
    };
  }
  if (oldText.length === 0) {
    return {
      success: false,
      message: 'oldText 不能为空。如需向文件追加内容,先 read_file 拿到现有末尾片段作为 oldText,再用 newText = oldText + 新追加内容。',
      error: 'empty oldText',
    };
  }
  if (reason.trim().length < 5) {
    return {
      success: false,
      message: 'reason 太短(< 5 字符)。请说明改什么 + 为什么,例:"修复 BaseModel 不接受对象 orderBy,改为字符串"',
      error: 'reason too short',
    };
  }

  const normalizedPath = normalizeUserPath(userPath);
  let fullPath: string;
  try { fullPath = validatePath(userPath, userId); }
  catch (err) {
    return { success: false, message: (err as Error).message, error: 'invalid path' };
  }
  if (!existsSync(fullPath)) {
    return {
      success: false,
      message: `文件不存在: ${normalizedPath}。patch_file 用于修改已存在文件,新文件请用 write_file/write_files(若框架允许)。`,
      error: 'file not found',
    };
  }

  // ---- 2. 读 + 唯一匹配校验 ----
  let content: string;
  try { content = readFileSync(fullPath, 'utf-8'); }
  catch (err) {
    return { success: false, message: `读文件失败: ${(err as Error).message}`, error: 'read failed' };
  }

  const matchCount = content.split(oldText).length - 1;
  if (matchCount === 0) {
    return {
      success: false,
      message:
        `patch_file 没找到 oldText 在 ${normalizedPath} 中的匹配。\n`
        + `oldText 必须**精确**匹配文件中现有内容(包括空格/换行)。\n`
        + `建议先用 read_file 读出实际片段再传 patch_file,避免空格、缩进、引号差异。`,
      error: 'oldText not found',
    };
  }
  if (matchCount > 1) {
    return {
      success: false,
      message:
        `patch_file 在 ${normalizedPath} 找到 ${matchCount} 处匹配 oldText,无法确定要改哪一处。\n`
        + `请扩大 oldText 范围,加入足够上下文让它唯一定位(如包含上一行 / 下一行 / 函数名等)。`,
      error: `ambiguous match (${matchCount})`,
    };
  }

  // ---- 3. diff 大小校验 ----
  const oldLen = oldText.length;
  const newLen = newText.length;
  const fileSize = content.length;
  const changeBytes = Math.abs(newLen - oldLen) + Math.min(oldLen, newLen);  // upper bound on change
  const changeRatio = fileSize > 0 ? changeBytes / fileSize : 1.0;

  if (changeRatio > MAX_CHANGE_RATIO) {
    return {
      success: false,
      message:
        `patch_file 单次 diff 占比 ${(changeRatio * 100).toFixed(1)}% 超过上限 ${(MAX_CHANGE_RATIO * 100).toFixed(0)}%。\n`
        + `这种规模的改动接近"重写整文件",通常意味着思路根本变了 — 建议拆成多次小 patch,每次只动一处逻辑。\n`
        + `若坚持要大改,请说明清楚后让用户决定是否走 update_module 重新生成。`,
      diffStats: { fileSize, oldLen, newLen, changeBytes, changeRatio },
      error: 'change too large',
    };
  }

  // 只有当 oldText 非平凡(>20 字符)时才检查比例,免得替换 1 字符变 3 字符也被卡
  if (oldLen > 20 && newLen > 0) {
    const ratio = newLen / oldLen;
    if (ratio < RATIO_LOWER || ratio > RATIO_UPPER) {
      return {
        success: false,
        message:
          `patch_file 的 newText/oldText 字符比 ${ratio.toFixed(2)} 超出允许范围 [${RATIO_LOWER}, ${RATIO_UPPER}]。\n`
          + `这通常意味着新片段比旧片段相差过大,实际是"重写"而非"修改"。请拆成多次小 patch。`,
        diffStats: { fileSize, oldLen, newLen, changeBytes, changeRatio },
        error: 'ratio out of range',
      };
    }
  }

  // ---- 4. 应用 patch ----
  const newContent = content.replace(oldText, newText);

  // 4a. _meta.json 写盘前合约校验
  let writeContent = newContent;
  if (normalizedPath.endsWith('_meta.json')) {
    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.length < 2) {
      return { success: false, message: `_meta.json must be under a module dir, got "${normalizedPath}"`, error: 'bad path' };
    }
    const moduleName = segments[0];
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(newContent); }
    catch (e) {
      return {
        success: false,
        message: `patch 后的 _meta.json 不是合法 JSON: ${(e as Error).message}。请检查你的 newText 是否破坏了 JSON 结构。`,
        error: 'invalid json after patch',
      };
    }
    const check = validateMetaContract(userId, moduleName, parsed);
    if (!check.ok) {
      return {
        success: false,
        message: 'patch 后的 _meta.json 不符合契约:\n' + formatContractErrors(check.errors),
        error: 'meta contract failed',
      };
    }
    writeContent = JSON.stringify(check.normalizedMeta, null, 2);
  }

  // 4b. 写盘
  try { writeFileSync(fullPath, writeContent, 'utf-8'); }
  catch (err) {
    return { success: false, message: `写文件失败: ${(err as Error).message}`, error: 'write failed' };
  }

  // 4c. SQL re-exec(CREATE TABLE IF NOT EXISTS 是 no-op,INSERT OR IGNORE 不会重复)
  const sideEffects: string[] = [];
  if (normalizedPath.endsWith('.sql')) {
    try {
      const injected = injectUserIdToTableNames(writeContent, userId);
      sqlite.exec(injected);
      sideEffects.push('SQL re-executed');
    } catch (err) {
      // SQL 报错不还原文件(用户可能修了之后还要再 patch),只返告警
      sideEffects.push(`⚠️ SQL re-exec failed: ${(err as Error).message}`);
    }
  }

  // 4d. _meta.json sync 到 modules 表
  if (normalizedPath.endsWith('_meta.json')) {
    try {
      const segments = normalizedPath.split('/').filter(Boolean);
      const moduleName = segments[0];
      const meta = JSON.parse(writeContent) as Record<string, unknown>;
      const existing = db.select().from(modules)
        .where(and(eq(modules.name, moduleName), eq(modules.userId, userId)))
        .get();
      if (existing) {
        const preserveStatus = existing.status === 'creating' || existing.status === 'editing';
        const update: Record<string, unknown> = {
          displayName: (meta.displayName as string) || moduleName,
          description: (meta.description as string) || '',
          basePath: `/mock/${moduleName}`,
          updatedBy: userId,
          updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        };
        if (!preserveStatus) update.status = (meta.status as string) || 'active';
        db.update(modules).set(update as any).where(eq(modules.id, existing.id)).run();
        sideEffects.push('_meta synced to modules table');
      }
    } catch (err) {
      sideEffects.push(`⚠️ _meta sync failed: ${(err as Error).message}`);
    }
  }

  return {
    success: true,
    message:
      `已修改 ${normalizedPath}: ${oldLen} → ${newLen} 字符 (diff ${(changeRatio * 100).toFixed(1)}%). `
      + `reason: ${reason}.`
      + (sideEffects.length ? ' Side effects: ' + sideEffects.join('; ') : ''),
    diffStats: { fileSize, oldLen, newLen, changeBytes, changeRatio },
  };
}
