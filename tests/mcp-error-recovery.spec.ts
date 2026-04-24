/**
 * Task M2.3 — error recovery_steps unit tests.
 *
 * Verify that each error code produces machine-actionable recovery steps so
 * AI clients can choose a remediation without parsing English `hint`.
 */
import { test, expect } from '@playwright/test';
import { mcpError, MCP_ERROR_CODES } from '../src/server/mcp/lib/error-codes';

test.describe('Task M2.3 — error-codes recovery_steps', () => {
  test('ER01 MODULE_NOT_FOUND suggests list_modules + create_module_from_spec', () => {
    const r = mcpError({
      code: MCP_ERROR_CODES.MODULE_NOT_FOUND,
      message: 'Module "foo" not found.',
      hint: 'Try list_modules',
      moduleName: 'foo',
    });
    const sc = r.structuredContent as any;
    expect(sc.code).toBe('MOCKFORGE_MODULE_NOT_FOUND');
    expect(sc.recovery_steps.length).toBeGreaterThanOrEqual(2);
    const tools = sc.recovery_steps.map((s: any) => s.tool);
    expect(tools).toContain('list_modules');
    expect(tools).toContain('create_module_from_spec');
  });

  test('ER02 ALREADY_PROCESSING with existingSessionId suggests resume + get_session_status + replace', () => {
    const r = mcpError({
      code: MCP_ERROR_CODES.ALREADY_PROCESSING,
      message: 'Module "foo" is already being processed.',
      hint: 'Retry with resume',
      moduleName: 'foo',
      existingSessionId: 'sess-123',
    });
    const sc = r.structuredContent as any;
    expect(sc.recovery_steps.length).toBeGreaterThanOrEqual(3);
    const tools = sc.recovery_steps.map((s: any) => s.tool);
    expect(tools).toContain('update_module');
    expect(tools).toContain('get_session_status');
    // resume (default) + replace options both present
    const replaceStep = sc.recovery_steps.find((s: any) => s.args?.onConflict === 'replace');
    expect(replaceStep).toBeTruthy();
  });

  test('ER03 BUSY with runningSessions suggests cancel_session per running one', () => {
    const r = mcpError({
      code: MCP_ERROR_CODES.BUSY,
      message: 'Concurrency limit reached',
      hint: 'wait',
      runningSessions: [
        { sessionId: 's1', moduleName: 'mod-a', elapsedSec: 30 },
        { sessionId: 's2', moduleName: 'mod-b', elapsedSec: 50 },
      ],
    });
    const sc = r.structuredContent as any;
    const cancelSteps = sc.recovery_steps.filter((s: any) => s.tool === 'cancel_session');
    expect(cancelSteps.length).toBe(2);
    expect(cancelSteps.map((s: any) => s.args.sessionId)).toEqual(['s1', 's2']);
  });

  test('ER04 WAIT_TIMEOUT with sessionId suggests get_session_status + cancel_session', () => {
    const r = mcpError({
      code: MCP_ERROR_CODES.WAIT_TIMEOUT,
      message: 'timeout',
      hint: 'poll',
      sessionId: 'sess-abc',
    });
    const sc = r.structuredContent as any;
    const tools = sc.recovery_steps.map((s: any) => s.tool);
    expect(tools).toContain('get_session_status');
    expect(tools).toContain('cancel_session');
  });

  test('ER05 PROVIDER_NOT_CONFIGURED suggests settings action', () => {
    const r = mcpError({
      code: MCP_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      message: 'no provider',
      hint: 'configure',
    });
    const sc = r.structuredContent as any;
    const actions = sc.recovery_steps.map((s: any) => s.action);
    expect(actions).toContain('open-settings');
  });

  test('ER06 text 前缀含 [CODE] 便于 AI 扫描', () => {
    const r = mcpError({
      code: MCP_ERROR_CODES.MODULE_NOT_FOUND,
      message: 'Module "foo" missing.',
      hint: 'test',
    });
    expect(r.content[0].text).toContain('[MOCKFORGE_MODULE_NOT_FOUND]');
    expect(r.content[0].text).toContain('Module "foo" missing.');
  });

  test('ER07 调用方可显式传 recovery_steps 覆盖默认', () => {
    const r = mcpError({
      code: MCP_ERROR_CODES.INTERNAL_ERROR,
      message: 'oops',
      hint: 'custom',
      recovery_steps: [{ action: 'retry', description: '稍后再试' }],
    });
    const sc = r.structuredContent as any;
    expect(sc.recovery_steps).toEqual([{ action: 'retry', description: '稍后再试' }]);
  });
});
