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
 * 修复单个 SSE data JSON 中不兼容的字段
 */
function patchChunkData(raw: string): string {
  try {
    const obj = JSON.parse(raw);

    if (obj.object !== 'chat.completion.chunk' || !Array.isArray(obj.choices)) {
      return raw;
    }

    let patched = false;

    for (const choice of obj.choices) {
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

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // 按行处理
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 最后一行可能不完整

      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          const data = line.slice(6);
          const fixed = patchChunkData(data);
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
          const fixed = patchChunkData(data);
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
