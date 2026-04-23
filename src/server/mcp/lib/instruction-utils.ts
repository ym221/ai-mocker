/**
 * Helpers for constructing + inverting the user-content wrappers that MCP
 * write tools feed into ChatRunner, plus a normalization used when deciding
 * whether to emit an "instruction drift" warning on attach-on-resume.
 */

export function buildUpdateUserContent(moduleName: string, instruction: string): string {
  return (
    `修改已有模块："${moduleName}"。具体要求：\n${instruction}\n\n` +
    `请保持模块名不变，只改动必要的字段/端点/文件。`
  );
}

export function buildCreateUserContent(spec: string, moduleName?: string): string {
  const nameHint = moduleName ? `\n模块名必须是："${moduleName}"。` : '';
  return (
    `请根据以下 API 规范/需求，创建一个全新的 Mock API 模块。${nameHint}\n\n` +
    `规范内容：\n${spec}`
  );
}

/** Recover the `instruction` arg from an update-wrapper user content. Best effort. */
export function extractUpdateInstruction(userContent: string): string {
  if (!userContent) return '';
  const m = userContent.match(/具体要求：\n([\s\S]*?)\n\n请保持模块名不变/);
  if (m) return m[1].trim();
  // Fallback: strip the known prefix/suffix anchors we can find
  return userContent.trim();
}

/** Recover the `spec` arg from a create-wrapper user content. Best effort. */
export function extractCreateSpec(userContent: string): string {
  if (!userContent) return '';
  const m = userContent.match(/规范内容：\n([\s\S]*)$/);
  if (m) return m[1].trim();
  return userContent.trim();
}

/** Normalize an instruction for drift comparison: trim, collapse whitespace, case-fold. */
export function normalizeInstruction(s: string): string {
  return (s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

/** True when the two instruction strings differ after normalization. */
export function instructionsDiffer(a: string, b: string): boolean {
  return normalizeInstruction(a) !== normalizeInstruction(b);
}
