/**
 * SQL 表名 userId 前缀注入工具 — 让 AI 在 schema.sql / controller raw SQL 里用
 * bare `mock__Xxx` 表名,框架在写盘/运行时自动改写成 `mock__{userId}_Xxx`。
 *
 * 负向先行断言 `(?!\d+_)` 跳过已经带数字前缀的 `mock__1_xxx`,防止双重注入。
 * 表名首字符要求字母,排除把 `mock__123_x` 也当业务表识别。
 */
export function injectUserIdToTableNames(sql: string, userId: number): string {
  return sql
    .replace(/`mock__(?!\d+_)([a-zA-Z][a-zA-Z0-9_]*)`/g, `\`mock__${userId}_$1\``)
    .replace(/(?<![`\w])mock__(?!\d+_)([a-zA-Z][a-zA-Z0-9_]*)(?![`\w])/g, `mock__${userId}_$1`);
}
