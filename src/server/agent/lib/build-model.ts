/**
 * 按 provider.type 构造 ai-sdk LanguageModel —— 让 chat-runner / agent-runner 一份代码同时支持
 * OpenAI 协议 + Anthropic 协议。未来若新增其他协议,只需在这里扩展。
 *
 * 当前覆盖的 provider.type 取值:
 * - 'anthropic'                 → @ai-sdk/anthropic(Claude 官方 + 第三方 anthropic 网关如 moyu.info)
 * - 'openai' | 'openai-compatible' | 'google' | 'custom' → @ai-sdk/openai(走 chat completions 兼容协议)
 *
 * Google 系(Gemini / Gemma)按 OpenAI-兼容端点接入(如 generativelanguage.googleapis.com/v1beta/openai/),
 * 因此也走 OpenAI 分支;若未来真要原生 Gemini API,再扩展 'google-native' 之类的分支。
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createCompatFetch } from '../compat-fetch.js';

export interface BuildModelInput {
  type: string;
  apiKey: string;
  baseUrl: string | null;
  modelName: string;
}

export function buildModel(input: BuildModelInput) {
  const { type, apiKey, baseUrl, modelName } = input;
  const fetchImpl = createCompatFetch(baseUrl || undefined);

  if (type === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey,
      baseURL: baseUrl || undefined,
      fetch: fetchImpl,
    });
    return anthropic(modelName);
  }

  // openai / openai-compatible / google / custom 全部走 OpenAI 协议
  const openai = createOpenAI({
    apiKey,
    baseURL: baseUrl || undefined,
    compatibility: 'compatible',
    fetch: fetchImpl,
  });
  return openai.chat(modelName);
}
