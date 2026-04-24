/**
 * Unified MCP error codes (Step-MCP-5 + Step-Perf-1.7).
 *
 * Every MCP tool error response carries:
 *   - code        : machine-identifiable string (MOCKFORGE_*)
 *   - message     : human-readable one-liner
 *   - hint        : one-sentence AI-actionable next step (free-form)
 *   - recovery_steps (NEW, Step-Perf-1.7) : structured tool-call suggestions
 *                   so the AI can pick a remediation without parsing English.
 *                   Each step is either { tool, args } or { action, description }.
 */

export const MCP_ERROR_CODES = {
  BUSY:                    'MOCKFORGE_BUSY',
  ALREADY_PROCESSING:      'MOCKFORGE_ALREADY_PROCESSING',
  MODULE_NOT_FOUND:        'MOCKFORGE_MODULE_NOT_FOUND',
  SESSION_NOT_FOUND:       'MOCKFORGE_SESSION_NOT_FOUND',
  VALIDATION_FAILED:       'MOCKFORGE_VALIDATION_FAILED',
  PROVIDER_NOT_CONFIGURED: 'MOCKFORGE_NO_PROVIDER',
  WAIT_TIMEOUT:            'MOCKFORGE_WAIT_TIMEOUT',
  INVALID_INPUT:           'MOCKFORGE_INVALID_INPUT',
  INTERNAL_ERROR:          'MOCKFORGE_INTERNAL_ERROR',
} as const;

export type McpErrorCode = typeof MCP_ERROR_CODES[keyof typeof MCP_ERROR_CODES];

export interface RecoveryStep {
  /** Machine-actionable MCP tool to call. Mutually exclusive with `action`. */
  tool?: string;
  /** Args to pass to the tool. Placeholder strings (e.g. "<sessionId>") OK. */
  args?: Record<string, unknown>;
  /** Non-tool action like "go to Settings → Providers". */
  action?: string;
  /** Human-readable description shown to the user / AI. */
  description: string;
}

export interface McpErrorPayload {
  code: McpErrorCode;
  message: string;
  hint: string;
  /** Structured recovery suggestions. Auto-populated if not provided. */
  recovery_steps?: RecoveryStep[];
  [extra: string]: unknown;
}

/**
 * Default recovery steps per error code. A caller can pass `recovery_steps`
 * explicitly to override. The context `extra` object may be used to fill in
 * sessionId / moduleName placeholders.
 */
function defaultRecoverySteps(code: McpErrorCode, extra: Record<string, unknown>): RecoveryStep[] {
  const moduleName = extra.moduleName as string | undefined;
  const sessionId = extra.sessionId as string | undefined;
  const existingSessionId = extra.existingSessionId as string | undefined;
  const runningSessions = extra.runningSessions as Array<{ sessionId: string; moduleName?: string }> | undefined;

  switch (code) {
    case MCP_ERROR_CODES.MODULE_NOT_FOUND:
      return [
        { tool: 'list_modules', description: 'List all modules you have access to' },
        ...(moduleName ? [{
          tool: 'create_module_from_spec',
          args: { moduleName, spec: '<your-spec>' },
          description: `Create "${moduleName}" from a new spec`,
        }] : []),
      ];
    case MCP_ERROR_CODES.SESSION_NOT_FOUND:
      return [
        ...(moduleName ? [{
          tool: 'inspect_module',
          args: { moduleName, view: 'health' },
          description: 'Check whether the module is still there',
        }] : []),
        { tool: 'list_modules', description: 'List modules to rediscover sessionIds' },
      ];
    case MCP_ERROR_CODES.ALREADY_PROCESSING:
      return [
        ...(moduleName ? [
          {
            tool: 'update_module',
            args: { moduleName, instruction: '<same-as-before>' },
            description: 'Re-send the same call to attach (default onConflict="resume")',
          },
          ...(existingSessionId ? [{
            tool: 'get_session_status',
            args: { sessionId: existingSessionId },
            description: 'Peek at the in-flight session without blocking',
          }] : []),
          {
            tool: 'update_module',
            args: { moduleName, instruction: '<new>', onConflict: 'replace' },
            description: 'Cancel the in-flight one and start fresh',
          },
        ] : []),
      ];
    case MCP_ERROR_CODES.BUSY: {
      const steps: RecoveryStep[] = [];
      if (runningSessions && runningSessions.length > 0) {
        for (const s of runningSessions.slice(0, 3)) {
          steps.push({
            tool: 'cancel_session',
            args: { sessionId: s.sessionId },
            description: `Abort running session ${s.moduleName ? `for "${s.moduleName}"` : s.sessionId}`,
          });
        }
      }
      steps.push({ action: 'wait', description: 'Wait ~30-60s and retry — running sessions usually complete quickly' });
      return steps;
    }
    case MCP_ERROR_CODES.PROVIDER_NOT_CONFIGURED:
      return [
        { action: 'open-settings', description: 'Open MockForge Web UI → Settings → Providers → add an active provider' },
        { action: 'pass-provider', description: 'Pass a provider id explicitly via the `provider` arg when calling write tools' },
      ];
    case MCP_ERROR_CODES.VALIDATION_FAILED:
      return [
        ...(moduleName ? [{
          tool: 'inspect_module',
          args: { moduleName, view: 'openapi' },
          description: 'Fetch the module contract to align your payload',
        }] : []),
      ];
    case MCP_ERROR_CODES.WAIT_TIMEOUT:
      return [
        ...(sessionId ? [
          { tool: 'get_session_status', args: { sessionId }, description: 'Non-blocking snapshot of the session' },
          { tool: 'cancel_session', args: { sessionId }, description: 'Give up and start fresh' },
        ] : []),
      ];
    case MCP_ERROR_CODES.INVALID_INPUT:
      return [
        { action: 'read-guide', description: 'Re-read mockforge://guide for the correct tool signatures' },
      ];
    default:
      return [];
  }
}

/** Build an MCP tool error response with unified shape. */
export function mcpError(payload: McpErrorPayload) {
  const { code, message, hint, recovery_steps, ...extra } = payload;
  const steps = recovery_steps ?? defaultRecoverySteps(code, extra as Record<string, unknown>);
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
    structuredContent: {
      code, message, hint,
      recovery_steps: steps,
      ...extra,
    } as Record<string, unknown>,
  };
}
