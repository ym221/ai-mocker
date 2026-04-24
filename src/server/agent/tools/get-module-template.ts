import { getModuleTemplate, listTemplateKinds, type TemplateKind } from '../templates/samples.js';

/**
 * Agent tool: 按 kind 读取完整模块文件样例。
 * 用于把样例从 system-prompt 中移出,只在 AI 需要时按需拉取。
 */
export function fetchModuleTemplate(kind: string): { success: boolean; kind?: TemplateKind; content?: string; message?: string; availableKinds?: string[] } {
  const kinds = listTemplateKinds();
  if (!kinds.includes(kind as TemplateKind)) {
    return {
      success: false,
      message: `Unknown template kind "${kind}". Available: ${kinds.join(', ')}.`,
      availableKinds: kinds,
    };
  }
  return {
    success: true,
    kind: kind as TemplateKind,
    content: getModuleTemplate(kind as TemplateKind),
  };
}
