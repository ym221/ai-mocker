/**
 * 兼容性 fetch 包装器
 *
 * 某些 OpenAI 兼容 API（如内部部署的 Gemma、通义千问等）返回的
 * SSE 流格式与 OpenAI 标准有细微差异，导致 AI SDK 的 Zod 验证失败。
 *
 * 常见差异：
 * - tool_calls 中缺少 `index` 字段
 * - choices 中缺少 `finish_reason` 字段
 * - 完整 tool call 参数在单个 chunk 中发送（非增量）
 *
 * 本包装器拦截 SSE 流，在数据到达 AI SDK 之前修复这些格式问题。
 */

/**
 * 修复 zod→JSON-Schema 转换出来根 type 字段缺失或为 nullable 数组的问题。
 * 严格的 OpenAI 兼容 API(如 DeepSeek)会拒绝 `type: null` 或 `type: ["object","null"]`,
 * 必须是单值 'object'。宽松的(gemma)能接受。这里递归 normalize 所有 schema 节点。
 */
function fixSchemaTypesRecursively(schema: any): void {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === null || schema.type === undefined) {
    // 根级别没标 type 时,根据是否有 properties 判定;否则跳过(无法推断)
    if (schema.properties) schema.type = 'object';
  } else if (Array.isArray(schema.type)) {
    const t = schema.type.find((x: any) => typeof x === 'string' && x !== 'null');
    schema.type = t || 'object';
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const k in schema.properties) fixSchemaTypesRecursively(schema.properties[k]);
  }
  if (schema.items) fixSchemaTypesRecursively(schema.items);
  if (Array.isArray(schema.anyOf)) for (const s of schema.anyOf) fixSchemaTypesRecursively(s);
  if (Array.isArray(schema.oneOf)) for (const s of schema.oneOf) fixSchemaTypesRecursively(s);
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) fixSchemaTypesRecursively(s);
}

/**
 * 修复 chat-completion / messages 请求体里的 tools schema 兼容性问题
 * - OpenAI 协议:tools[].function.parameters
 * - Anthropic 协议:tools[].input_schema
 */
function patchRequestBody(body: any): boolean {
  if (!body || !Array.isArray(body.tools)) return false;
  let patched = false;
  for (const t of body.tools) {
    // OpenAI tool schema
    if (t?.function?.parameters) {
      const before = JSON.stringify(t.function.parameters);
      fixSchemaTypesRecursively(t.function.parameters);
      if (JSON.stringify(t.function.parameters) !== before) patched = true;
    }
    // Anthropic tool schema
    if (t?.input_schema) {
      const before = JSON.stringify(t.input_schema);
      fixSchemaTypesRecursively(t.input_schema);
      if (JSON.stringify(t.input_schema) !== before) patched = true;
    }
  }
  return patched;
}

/**
 * 每个 choice 的 reasoning 流式状态(reasoning model 兼容用)
 * - active: 当前是否在 reasoning 阶段(收到过 reasoning_content,还没开始正常 content)
 * - opened: 是否已经在 content 流里插过 `<thinking>` 开标签
 */
type ReasoningState = { active: boolean; opened: boolean };

/**
 * 修复单个 SSE data JSON 中不兼容的字段
 *
 * @param reasoningState 跨 chunk 维护的 per-choice reasoning 状态(由调用方管理生命周期)
 */
function patchChunkData(raw: string, reasoningState: Map<number, ReasoningState>): string {
  try {
    const obj = JSON.parse(raw);

    if (obj.object !== 'chat.completion.chunk' || !Array.isArray(obj.choices)) {
      return raw;
    }

    let patched = false;

    for (const choice of obj.choices) {
      const idx = typeof choice.index === 'number' ? choice.index : 0;
      let state = reasoningState.get(idx);
      if (!state) {
        state = { active: false, opened: false };
        reasoningState.set(idx, state);
      }

      // 补 finish_reason: null
      if (!('finish_reason' in choice)) {
        choice.finish_reason = null;
        patched = true;
      }

      // 修复 tool_calls
      const toolCalls = choice.delta?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (let i = 0; i < toolCalls.length; i++) {
          // 补 index 字段
          if (!('index' in toolCalls[i])) {
            toolCalls[i].index = i;
            patched = true;
          }
        }
      }

      // ===== reasoning_content 合并:把 deepseek-v4-pro 等 reasoning model 的 =====
      // ===== `delta.reasoning_content` 流转换成包在 <thinking></thinking> 里的 =====
      // ===== `delta.content`,让标准 ai-sdk OpenAI provider 能正常读出来 =====
      const delta = choice.delta;
      if (delta) {
        const reasoningPart = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
        const contentPartRaw = delta.content;
        const contentPart = typeof contentPartRaw === 'string' ? contentPartRaw : '';

        if (reasoningPart.length > 0) {
          // reasoning chunk 流入
          let injected = '';
          if (!state.opened) {
            injected = '<thinking>';
            state.opened = true;
          }
          state.active = true;
          delta.content = contentPart + injected + reasoningPart;
          delete delta.reasoning_content;
          patched = true;
        } else if (contentPart.length > 0 && state.active) {
          // 实际正文开始 → 闭合 thinking 标签
          delta.content = '</thinking>' + contentPart;
          state.active = false;
          patched = true;
        } else if (delta.reasoning_content !== undefined) {
          // reasoning_content 是 null/空,只是个无意义字段,删了避免 ai-sdk 警告
          delete delta.reasoning_content;
          patched = true;
        }

        // finish_reason 时若仍在 reasoning 阶段(reasoning 用尽 max_tokens 没到正文),补闭合
        if (choice.finish_reason && state.active) {
          delta.content = (typeof delta.content === 'string' ? delta.content : '') + '</thinking>';
          state.active = false;
          patched = true;
        }
      }
    }

    return patched ? JSON.stringify(obj) : raw;
  } catch {
    return raw;
  }
}

/**
 * 创建一个 TransformStream，逐行修复 SSE 数据
 */
function createPatchTransform(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  // Per-stream reasoning 状态(跨 chunk 共享),每个 stream(每次请求)新建一个 Map
  const reasoningState = new Map<number, ReasoningState>();

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // 按行处理
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 最后一行可能不完整

      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          const data = line.slice(6);
          const fixed = patchChunkData(data, reasoningState);
          controller.enqueue(encoder.encode('data: ' + fixed + '\n'));
        } else {
          controller.enqueue(encoder.encode(line + '\n'));
        }
      }
    },
    flush(controller) {
      if (buffer) {
        if (buffer.startsWith('data: ') && buffer !== 'data: [DONE]') {
          const data = buffer.slice(6);
          const fixed = patchChunkData(data, reasoningState);
          controller.enqueue(encoder.encode('data: ' + fixed + '\n'));
        } else {
          controller.enqueue(encoder.encode(buffer + '\n'));
        }
      }
    },
  });
}

/**
 * 包装原始 fetch，对 SSE 流做格式修复
 *
 * @param baseUrl AI API base URL，用于判断是否需要绕过代理
 */
export function createCompatFetch(baseUrl?: string): typeof globalThis.fetch {
  // 懒加载 undici，避免在浏览器环境报错
  let directDispatcher: any = null;

  async function getDirectDispatcher() {
    if (directDispatcher !== null) return directDispatcher;
    try {
      const undici = await import('undici');
      // 创建一个直连 Agent，不走全局代理
      directDispatcher = new undici.Agent({
        connect: { timeout: 60_000 },
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 600_000,
      });
    } catch {
      directDispatcher = false;
    }
    return directDispatcher;
  }

  /** 判断 URL 是否需要绕过全局代理（中国境内域名） */
  function shouldBypassProxy(url: string): boolean {
    const bypassDomains = [
      'volces.com',      // 火山引擎/豆包
      'aliyuncs.com',    // 阿里云
      'bigmodel.cn',     // 智谱
      'deepseek.com',    // DeepSeek
      'moonshot.cn',     // Kimi
      'dashscope',       // 通义千问
      'baichuan-ai.com',
      'zhipuai.cn',
      '.cn/',
      'localhost',
      '127.0.0.1',
    ];
    return bypassDomains.some(d => url.includes(d));
  }

  return async function compatFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);

    // 中国境内的 API 不走代理
    let finalInit = init;
    if (baseUrl && shouldBypassProxy(baseUrl) || (url && shouldBypassProxy(url))) {
      const dispatcher = await getDirectDispatcher();
      if (dispatcher) {
        finalInit = { ...init, dispatcher } as any;
      }
    }

    // 修 tool schema 的 type:null / type:["object","null"](DeepSeek 等严格 API 兼容)
    if (finalInit?.body && typeof finalInit.body === 'string') {
      try {
        const parsed = JSON.parse(finalInit.body);
        if (patchRequestBody(parsed)) {
          finalInit = { ...finalInit, body: JSON.stringify(parsed) };
        }
      } catch { /* body 不是 JSON,跳过 */ }
    }

    const response = await fetch(input, finalInit);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      return response;
    }

    const patchStream = createPatchTransform();
    const patchedBody = response.body.pipeThrough(patchStream);

    return new Response(patchedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
