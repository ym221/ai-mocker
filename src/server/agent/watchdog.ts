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
  // Any non-empty moduleIntentOp indicates the AI declared module work — even
  // if the operation arg was missing/null (some weak models drop it). Treat
  // any declared intent except 'none' as obligating a file write.
  const mustWrite =
    s.moduleIntentOp != null && s.moduleIntentOp !== 'none' &&
    String(s.moduleIntentOp).length > 0;

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
    `[系统强制 — 第二次提醒,这是最后机会] 你已声明 moduleIntent=${operation} 模块="${moduleName}",`
    + `但**反复在调用 set_module_intent / get_module_template / list_modules / read_file 等准备工作**,没有调用 write_files/write_file 真正落盘。\n`
    + `下一步**唯一允许的工具**是 \`write_files\`(单次批写 5 文件) 或 \`write_file\`(按文件分别写)。\n`
    + `**禁止再调** set_module_intent / get_module_template / list_modules / read_file / inspect_module 等任何"准备类"工具 — 你已经准备过了。\n`
    + `必须立即用你已有的上下文(spec + 之前拿过的模板)直接组装 5 个文件:`
    + `_meta.json、schema.sql、controller.ts、test.ts、api-doc.md。\n`
    + `若 write_files 返 "no files provided",**立即改用 write_file 按单文件依次写入**,不要重试 write_files。\n`
    + `不允许只输出文本说明 — 下一个 part 必须是工具调用,且工具名必须是 write_files 或 write_file。`
  );
}
