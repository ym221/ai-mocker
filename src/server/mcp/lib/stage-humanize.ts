/**
 * Humanize internal stage labels for progress events so UI and MCP clients
 * show friendly text instead of `tool:write_files` / `thinking`.
 *
 * Two outputs per stage:
 *   - description: natural-language phrase (Chinese) for chat UI + MCP `hint`
 *   - expectedRemainingSec: crude heuristic ceiling for "probably wraps up in
 *     about N seconds" — used by still-running responses to nudge the AI's
 *     retry cadence. Always a range upper-bound, never guaranteed.
 */

export interface StageInfo {
  /** Internal mechanical label, e.g. "tool:write_files" or "thinking". */
  stage: string;
  /** Friendly Chinese description for users / AI hint. */
  description: string;
  /** Rough "should finish within" ceiling in seconds. 0 = already done. */
  expectedRemainingSec: number;
  /** Actionable next-step suggestion for the caller (AI-facing). */
  suggestedNextAction: string;
}

/** Maps tool names to humanized Chinese phrases. */
const TOOL_LABEL: Record<string, string> = {
  write_file: '正在写入模块文件',
  write_files: '正在批量写入模块文件',
  read_file: '正在读取模块文件',
  run_test: '正在运行模块测试',
  manage_data: '正在管理模块数据',
  list_modules: '正在查询模块列表',
  delete_module: '正在删除模块',
  get_module_template: '正在读取模块模板',
  set_module_intent: '正在声明模块意图',
};

function humanizeTool(toolName: string | undefined): string {
  if (!toolName) return '正在使用工具';
  return TOOL_LABEL[toolName] ?? `正在使用工具 ${toolName}`;
}

/**
 * Honest "remaining time" phrase for still-running responses.
 *
 * The per-stage `expectedRemainingSec` is a static guess; once a run has clearly
 * blown past one full wait window it's misleading to keep promising "~30s" (the
 * earlier behavior, which printed the same tiny ETA at 180s, 360s, 720s...).
 * Past ~one window, drop the fake ETA and set correct expectations: complex
 * modules legitimately take several generate+self-test rounds.
 */
export function formatEtaPhrase(elapsedSec: number | undefined, info: StageInfo): string {
  const e = elapsedSec ?? 0;
  if (e >= 240) {
    return `已持续 ${e}s — 复杂模块需多轮生成+自测,属正常,继续等待即可`;
  }
  return `预计再 ~${info.expectedRemainingSec}s 可完成`;
}

export function humanizeStage(rawStage: string | undefined | null): StageInfo {
  const s = rawStage ?? 'starting';

  if (s === 'starting' || s === 'user') {
    return {
      stage: 'starting',
      description: '正在准备',
      expectedRemainingSec: 120,
      suggestedNextAction: 'Call again with the same arguments in ~15s to resume.',
    };
  }
  if (s === 'thinking') {
    return {
      stage: 'thinking',
      description: '正在思考规划',
      expectedRemainingSec: 90,
      suggestedNextAction: 'Model is reasoning; call again in ~20s to resume.',
    };
  }
  if (s === 'writing') {
    return {
      stage: 'writing',
      description: '正在生成回复',
      expectedRemainingSec: 30,
      suggestedNextAction: 'Almost done; call again in ~10s to pick up the final result.',
    };
  }
  if (s.startsWith('tool:')) {
    const toolName = s.slice('tool:'.length);
    return {
      stage: s,
      description: humanizeTool(toolName),
      expectedRemainingSec: toolName === 'run_test' ? 45 : 30,
      suggestedNextAction: 'Tool in progress; call again in ~10-15s to resume.',
    };
  }
  if (s.startsWith('tool_result:')) {
    return {
      stage: s,
      description: '工具执行完成,准备下一步',
      expectedRemainingSec: 20,
      suggestedNextAction: 'Model is choosing next step; call again in ~10s.',
    };
  }
  if (s.startsWith('module_update')) {
    return {
      stage: s,
      description: '正在生成模块卡片',
      expectedRemainingSec: 5,
      suggestedNextAction: 'Almost done; call again immediately to fetch the final result.',
    };
  }
  if (s === 'done') {
    return {
      stage: 'done',
      description: '已完成',
      expectedRemainingSec: 0,
      suggestedNextAction: 'Finished — the next call will either attach to a fresh session or inspect the module.',
    };
  }
  if (s === 'error' || s === 'paused' || s === 'aborted') {
    return {
      stage: s,
      description: s === 'error' ? '已出错' : s === 'paused' ? '已暂停' : '已中止',
      expectedRemainingSec: 0,
      suggestedNextAction: 'Inspect the session via get_session_status, or retry with onConflict="replace".',
    };
  }
  return {
    stage: s,
    description: `正在处理(${s})`,
    expectedRemainingSec: 30,
    suggestedNextAction: 'Call again in ~10-15s to resume.',
  };
}
