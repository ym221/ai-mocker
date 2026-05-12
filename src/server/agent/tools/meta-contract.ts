/**
 * _meta.json 写盘前的硬契约校验。
 *
 * 上游(AI 生成时)经常违反两条铁律,导致访问 mock 端点必 404:
 *   1. `basePath` 自作主张设成业务前缀(如 "/mock/reconcile"),与 moduleName 不一致
 *      → mockBaseUrl 拼出来骗人,mock-router 仍按 moduleName 路由 → 永远找不到
 *   2. `endpoints[].path` 把 OpenAPI 原始 path(含 /<basePath>/前缀)整段抄进来
 *      → mock-router 剥掉 /<moduleName>/ 后剩下的 subPath 跟 endpoint.path 永不匹配
 *
 * 这两个错过去靠 system-prompt 文字提醒,弱模型还是会犯。改成写盘前强校验:违反
 * 直接 reject 给 AI 看清晰的修复建议,绝不让坏模块落盘。
 *
 * 同时校验"全局名字唯一" — 接受按 (name, currentUserId) 已存在的修改,但拒绝
 * 创建一个跟其他 user 同名的新模块(application-level UNIQUE)。
 */
import { db } from '../../core/database.js';
import { modules } from '../../core/schema.js';
import { eq, and, ne } from 'drizzle-orm';

export interface MetaContractError {
  field: string;       // 哪个字段违反,如 "basePath" / "endpoints[2].path"
  message: string;     // 给 AI 看的修复建议(中文)
}

export interface MetaContractCheck {
  ok: boolean;
  errors: MetaContractError[];
  /** 校验通过后,框架建议的"规范化" meta —— 调用方应回写到磁盘,确保读出来一致。 */
  normalizedMeta?: Record<string, unknown>;
}

/**
 * 校验 _meta.json 是否符合 URL 公式 + 名字唯一。
 *
 * @param userId  当前调用方(AI 创建模块的 user) — 用来做"全局唯一性"判断时排除自己
 * @param moduleName  从文件路径 `<moduleName>/_meta.json` 推导出来的 name(权威来源)
 * @param meta  解析后的 _meta.json 对象
 */
export function validateMetaContract(
  userId: number,
  moduleName: string,
  meta: Record<string, unknown>,
): MetaContractCheck {
  const errors: MetaContractError[] = [];

  // ---- 1. basePath: 不写最好(框架自动设);写了必须等于 /mock/<moduleName> ----
  const expectedBasePath = `/mock/${moduleName}`;
  if (meta.basePath !== undefined && meta.basePath !== null && meta.basePath !== '') {
    if (typeof meta.basePath !== 'string' || meta.basePath !== expectedBasePath) {
      errors.push({
        field: 'basePath',
        message:
          `basePath 必须等于 "${expectedBasePath}",当前是 "${meta.basePath}"。`
          + ' 推荐做法:直接删掉 basePath 字段,框架会自动按 moduleName 算。'
          + ' 框架路由公式:<MCP origin>/mock/<moduleName><endpoint.path>。',
      });
    }
  }

  // ---- 2. endpoints[].path: 必须 / 开头,不能带 /mock/ 或 /<moduleName>/ 前缀 ----
  const endpoints = Array.isArray(meta.endpoints) ? (meta.endpoints as Array<Record<string, unknown>>) : [];
  if (endpoints.length === 0) {
    errors.push({
      field: 'endpoints',
      message: '_meta.json 没有 endpoints 数组(或为空)。每个模块至少要定义 1 个 endpoint。',
    });
  }
  endpoints.forEach((ep, idx) => {
    const path = ep.path;
    if (typeof path !== 'string' || !path) {
      errors.push({
        field: `endpoints[${idx}].path`,
        message: `endpoints[${idx}].path 缺失或不是字符串。每个 endpoint 必须有 path 字段(模块内子路径)。`,
      });
      return;
    }
    if (!path.startsWith('/')) {
      errors.push({
        field: `endpoints[${idx}].path`,
        message:
          `endpoints[${idx}].path = "${path}" 必须以 / 开头。例:"/list" / "/search" / "/:id"`,
      });
    }
    if (path.startsWith('/mock/') || path.startsWith('/mock')) {
      errors.push({
        field: `endpoints[${idx}].path`,
        message:
          `endpoints[${idx}].path = "${path}" 错误地包含了 /mock/ 前缀。`
          + ' 框架会自动加 /mock/<moduleName>/,你只需要写**模块内**的子路径。'
          + ` 比如把 "${path}" 改成 "${path.replace(/^\/mock(?:\/[^/]+)?/, '') || '/'}"。`,
      });
    } else if (path.startsWith(`/${moduleName}/`) || path === `/${moduleName}`) {
      errors.push({
        field: `endpoints[${idx}].path`,
        message:
          `endpoints[${idx}].path = "${path}" 错误地包含了模块名 "${moduleName}" 前缀。`
          + ' endpoint.path 是模块内**子路径**,不要重复模块名。'
          + ` 把 "${path}" 改成 "${path.replace(new RegExp(`^/${moduleName}`), '') || '/'}"。`,
      });
    }
  });

  // ---- 3. 全局名字唯一:其他 user 不能有同名模块 ----
  // 接受 (name, userId) 已存在的修改(update 路径);拒绝 (name, otherUserId) 冲突。
  const conflicts = db.select().from(modules)
    .where(and(eq(modules.name, moduleName), ne(modules.userId, userId)))
    .all();
  if (conflicts.length > 0) {
    const owners = conflicts.map(c => `user_id=${c.userId}`).join(', ');
    errors.push({
      field: 'moduleName',
      message:
        `模块名 "${moduleName}" 已被其他用户占用(${owners})。模块名要求全局唯一。`
        + ' 建议改名:加业务前缀(如 "team_' + moduleName + '" / "acme_' + moduleName + '"),'
        + ' 然后把 _meta.json 文件路径里的目录名同步改成新名字。',
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // ---- 规范化 meta:auto-fix basePath + name(让磁盘上的内容自洽) ----
  const normalized: Record<string, unknown> = { ...meta };
  normalized.name = moduleName;
  normalized.basePath = expectedBasePath;
  return { ok: true, errors: [], normalizedMeta: normalized };
}

/**
 * 把 MetaContractCheck.errors 拼成一段给 AI 读的 message。
 */
export function formatContractErrors(errors: MetaContractError[]): string {
  if (errors.length === 0) return '';
  const lines = errors.map((e, i) => `${i + 1}. [${e.field}] ${e.message}`);
  return `_meta.json 不符合框架契约,本次写盘被拒绝:\n${lines.join('\n')}\n\n请按上述提示修正 _meta.json 后重新调用 write_files / write_file。`;
}
