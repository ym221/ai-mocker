/**
 * Watchdog decision logic for chat-runner's "done-but-empty" guard.
 *
 * Pure, side-effect-free — chat-runner consumes the returned action.
 * Extracted into its own module so it can be unit-tested without needing
 * to wire up streamText / AI providers.
 */

export interface WatchdogState {
  /** Value of the last set_module_intent call; undefined means no intent declared.
   *  Accepts both 'update' (MCP-originated) and 'edit' (Web UI set_module_intent tool) — both imply file-writing work. */
  moduleIntentOp?: 'create' | 'update' | 'edit' | 'none';
  /** Whether the current turn emitted a write_file OR write_files tool call. */
  hasWriteCall: boolean;
  /** Number of nudges already issued in this turn (0 on first check). */
  nudgesIssued: number;
  /** Hard upper bound for nudges; after this many we give up and emit error. */
  maxNudge: number;
}

export type WatchdogAction =
  | { kind: 'proceed' }                                     // all good, finalize('done')
  | { kind: 'nudge'; attempt: number; total: number }       // re-prompt the model
  | { kind: 'fail'; message: string };                      // finalize('error'), never silent-done

export function decideWatchdog(s: WatchdogState): WatchdogAction {
  const mustWrite =
    s.moduleIntentOp === 'create'
    || s.moduleIntentOp === 'update'
    || s.moduleIntentOp === 'edit';

  // Regular chat or declared none → no gate, proceed.
  if (!mustWrite) return { kind: 'proceed' };

  // Model actually wrote — all good.
  if (s.hasWriteCall) return { kind: 'proceed' };

  // Intent declared, no write yet — consider nudging.
  if (s.nudgesIssued < s.maxNudge) {
    return {
      kind: 'nudge',
      attempt: s.nudgesIssued + 1,
      total: s.maxNudge,
    };
  }

  // Exhausted all nudges. Never silently succeed.
  const totalAttempts = s.maxNudge + 1;
  return {
    kind: 'fail',
    message:
      `模型声明了 moduleIntent=${s.moduleIntentOp} 但连续 ${totalAttempts} 轮未调用任何 `
      + `write_file/write_files。建议：切换更强模型（Settings → Provider/Model）或简化 spec 后重试。`,
  };
}

/**
 * The synthetic user nudge message injected into coreMessages before re-running
 * streamText. Explicit, tool-oriented, with clear fallback path to write_file
 * in case write_files schema trips the model.
 */
export function buildNudgeMessage(
  operation: 'create' | 'update' | 'edit',
  moduleName: string
): string {
  return (
    `[系统提示：工具调用强制] 你已通过 set_module_intent 声明 moduleIntent=${operation} `
    + `模块="${moduleName}"，但本轮未调用任何 write_file 或 write_files。`
    + `现在必须立刻使用 write_files（优先，单次批写 5 文件）或多次 write_file 写入：`
    + `_meta.json、schema.sql、controller.ts、test.ts、api-doc.md —— `
    + `少一个就算失败。若 write_files 返回 "no files provided"，改用 write_file 按文件分别写入。`
    + `不要再只输出思考或说明文本 — 下一步必须是工具调用。`
  );
}
