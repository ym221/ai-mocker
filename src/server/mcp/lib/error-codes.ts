/**
 * Unified MCP error codes (Step-MCP-5).
 *
 * Every MCP tool error response should include one of these as `code` plus a
 * short AI-actionable `hint` so the caller can reason about the right next
 * action without re-reading the guide.
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

export interface McpErrorPayload {
  code: McpErrorCode;
  message: string;
  hint: string;
  [extra: string]: unknown;
}

/** Build an MCP tool error response with unified shape. */
export function mcpError(payload: McpErrorPayload) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: payload.message }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}
