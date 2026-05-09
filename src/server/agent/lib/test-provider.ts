/**
 * Provider 连通性测试 —— 走真实 ai-sdk + buildModel + compat-fetch 链路,
 * 跑一个最小 chat + tool 调用,模拟 chat-runner 的关键能力组合。
 *
 * 测试覆盖:
 * - chat completions(streaming)协议是否正确
 * - tool schema 是否被严格接受(deepseek 类 schema 严格 API 会暴露 type:null bug)
 * - reasoning model 兼容(compat-fetch 的 reasoning state machine 自动起作用)
 * - 网络可达性 / API key 有效性
 *
 * 失败时返回机器可读 errorCode + 人类可读 hint。
 */
import { streamText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { buildModel } from './build-model.js';

export interface TestProviderInput {
  type: string;
  apiKey: string;
  baseUrl: string | null;
  modelName: string;
}

export interface TestProviderResult {
  ok: boolean;
  errorCode?: ProviderTestErrorCode;
  errorMessage?: string;
  hint?: string;
  latencyMs: number;
  gotText: boolean;
  gotToolCall: boolean;
}

export type ProviderTestErrorCode =
  | 'NO_API_KEY'
  | 'NO_MODEL'
  | 'API_KEY_INVALID'        // HTTP 401
  | 'BASE_URL_NOT_FOUND'     // HTTP 404
  | 'RATE_LIMITED'           // HTTP 429
  | 'SCHEMA_ERROR'           // ai-sdk schema 不被接受(deepseek type:null 等)
  | 'EMPTY_RESPONSE'         // 流结束但既无文本也无工具调用
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

const TIMEOUT_MS = 30_000;

export async function testProvider(input: TestProviderInput): Promise<TestProviderResult> {
  const start = Date.now();
  const result: TestProviderResult = { ok: false, latencyMs: 0, gotText: false, gotToolCall: false };

  if (!input.apiKey) {
    return { ...result, errorCode: 'NO_API_KEY', errorMessage: 'API Key not provided', hint: '请填 API Key', latencyMs: Date.now() - start };
  }
  if (!input.modelName) {
    return { ...result, errorCode: 'NO_MODEL', errorMessage: 'Model name not provided', hint: '请填默认模型', latencyMs: Date.now() - start };
  }

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort('timeout'), TIMEOUT_MS);

  try {
    const model = buildModel({
      type: input.type,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      modelName: input.modelName,
    });

    const stream = streamText({
      model,
      messages: [
        { role: 'user', content: 'Reply with the word OK and call the echo tool with phrase="hi". Brief reply only.' },
      ],
      tools: {
        echo: tool({
          description: 'Echo back a phrase',
          parameters: z.object({
            phrase: z.string().describe('Phrase to echo'),
          }),
          execute: async ({ phrase }) => ({ echoed: phrase }),
        }),
      } as any,
      stopWhen: stepCountIs(2),
      abortSignal: abortController.signal,
    });

    for await (const part of stream.fullStream) {
      const t = (part as any).type as string;
      if (t === 'text-delta' || t === 'text') result.gotText = true;
      if (t === 'tool-call') result.gotToolCall = true;
      if (t === 'error') {
        const errPart = part as any;
        throw errPart.error || new Error(errPart.message || 'stream error');
      }
    }

    clearTimeout(timeoutHandle);
    result.latencyMs = Date.now() - start;

    if (!result.gotText && !result.gotToolCall) {
      return {
        ...result,
        errorCode: 'EMPTY_RESPONSE',
        errorMessage: '流结束但既无文本也无工具调用',
        hint: '可能 reasoning model 在思考阶段就用尽 max_tokens;或 base_url 路径错(如缺 /v1)。配置可保存,但实际调用可能不可用',
      };
    }

    result.ok = true;
    return result;
  } catch (err: any) {
    clearTimeout(timeoutHandle);
    result.latencyMs = Date.now() - start;
    return classifyError(err, result);
  }
}

function classifyError(err: any, base: TestProviderResult): TestProviderResult {
  const msg = err?.message || String(err);
  const status = err?.statusCode || err?.status;
  const lower = msg.toLowerCase();

  if (status === 401 || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('invalid_api_key')) {
    return { ...base, errorCode: 'API_KEY_INVALID', errorMessage: msg.slice(0, 300), hint: 'API Key 无效或过期,检查后重填' };
  }
  if (status === 404 || lower.includes('not found') || lower.includes('404')) {
    return { ...base, errorCode: 'BASE_URL_NOT_FOUND', errorMessage: msg.slice(0, 300), hint: 'base_url 路径错;常见是缺 /v1 后缀' };
  }
  if (status === 429 || lower.includes('rate limit') || lower.includes('too many request')) {
    return { ...base, errorCode: 'RATE_LIMITED', errorMessage: msg.slice(0, 300), hint: '上游限流,稍后重试或换 provider' };
  }
  if (lower.includes('invalid schema') || lower.includes('schema must be') || lower.includes('invalid_request_error')) {
    return { ...base, errorCode: 'SCHEMA_ERROR', errorMessage: msg.slice(0, 300), hint: '工具 schema 格式问题;升级 ai-sdk 或换 model 试试' };
  }
  if (err?.name === 'AbortError' || lower.includes('aborted') || lower.includes('timeout')) {
    return { ...base, errorCode: 'TIMEOUT', errorMessage: `${TIMEOUT_MS / 1000}s 测试超时`, hint: '上游响应过慢;base_url 可能不可达,或代理未生效' };
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('etimedout') || lower.includes('econnreset')) {
    return { ...base, errorCode: 'NETWORK_ERROR', errorMessage: msg.slice(0, 300), hint: 'base_url 网络不可达;检查域名 / 防火墙 / 代理' };
  }
  return { ...base, errorCode: 'UNKNOWN', errorMessage: msg.slice(0, 500), hint: '未识别的错误,查后端日志看详细 stack' };
}
