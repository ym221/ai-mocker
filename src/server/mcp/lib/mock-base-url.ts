/**
 * 构造 mockBaseUrl —— AI Agent 用来访问某个 Mock 模块端点的完整 URL。
 *
 * 此前 list_modules / create_module_from_spec 各自写一份硬编码 `localhost:3000`,
 * Docker 端口映射(容器内 PORT=3000,宿主机 HOST_PORT=9020)下 AI 拿到的 URL
 * 完全不可达,把这个 URL 写进业务代码后部署一定挂。
 *
 * 三级回退(高到低):
 *   1. env MCP_PUBLIC_URL  — 部署侧明确告知,例 "http://mock.team.local" 或
 *      "https://mockforge.example.com"。优先级最高,绝不被覆盖
 *   2. requestOrigin       — 从 X-Forwarded-* 或 Host header 推断的 AI Agent
 *      实际连进来的 URL origin,反向代理/Docker 端口映射下自动适配
 *   3. fallback            — `http://localhost:<PORT>`,仅在前两者都没有时使用
 *
 * 返 source 标记便于 AI 在结果里看到来源 —— 若是 'fallback' 且部署在远程,
 * 自己就能识别"管理员漏配了 MCP_PUBLIC_URL / 反代漏加 X-Forwarded-*"。
 */
export type MockBaseUrlSource = 'env-public-url' | 'request-origin' | 'fallback-localhost';

export interface BuildMockBaseUrlOptions {
  /** module 的 basePath,通常是 "/mock/<name>";为空则按 moduleName 兜底 */
  basePath?: string | null;
  moduleName: string;
  /** 从 mcpUserContext 取的请求 origin(如 "http://39.108.114.224:9020")。可空 */
  requestOrigin?: string;
}

export interface MockBaseUrlResult {
  /** 完整 URL,直接给 AI 用 */
  url: string;
  /** origin only(host+port+scheme),不含路径 — 让 AI 能区分 origin 与 path */
  origin: string;
  /** 来源,便于 AI 与日志识别问题 */
  source: MockBaseUrlSource;
}

function normalizeBasePath(basePath: string | null | undefined, moduleName: string): string {
  let path = basePath || `/mock/${moduleName}`;
  if (!path.startsWith('/')) path = '/' + path;
  if (!path.startsWith('/mock')) {
    // 兼容老数据 basePath 仅存 "/<name>" 的情况
    path = '/mock' + path;
  }
  return path;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

export function buildMockBaseUrl(opts: BuildMockBaseUrlOptions): MockBaseUrlResult {
  const path = normalizeBasePath(opts.basePath, opts.moduleName);

  // 1. env override (deployment-explicit, highest priority)
  const envUrl = process.env.MCP_PUBLIC_URL?.trim();
  if (envUrl) {
    const origin = stripTrailingSlash(envUrl);
    return { url: origin + path, origin, source: 'env-public-url' };
  }

  // 2. request origin inferred from headers
  if (opts.requestOrigin) {
    const origin = stripTrailingSlash(opts.requestOrigin);
    return { url: origin + path, origin, source: 'request-origin' };
  }

  // 3. fallback — localhost:PORT (legacy behaviour; container-internal port)
  const port = process.env.PORT || '3000';
  const origin = `http://localhost:${port}`;
  return { url: origin + path, origin, source: 'fallback-localhost' };
}

/**
 * 从 fastify request 推断 AI Agent 看到的 MCP origin。
 * 优先级:X-Forwarded-Proto + X-Forwarded-Host(:Port) > Host header > 无法推断返 undefined
 *
 * 处理:
 *  - X-Forwarded-Host 可能含多个值(reverse proxy 链),取第一个
 *  - X-Forwarded-Port 缺失时按 Proto 推默认(443 https / 80 http);若 host 已含 ":port" 则不重复加
 *  - 反代未加 X-Forwarded-* 时 fall back 到 Host(浏览器/curl 直连 MCP 的场景)
 */
export function inferRequestOrigin(headers: Record<string, string | string[] | undefined>): string | undefined {
  const pick = (k: string): string | undefined => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    if (!v) return undefined;
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === 'string' ? s.split(',')[0].trim() : undefined;
  };

  const xfProto = pick('x-forwarded-proto');
  const xfHost = pick('x-forwarded-host');
  const xfPort = pick('x-forwarded-port');

  if (xfHost) {
    const proto = (xfProto || 'http').toLowerCase();
    const hostHasPort = xfHost.includes(':') && !xfHost.startsWith('[');  // skip IPv6 lookalike heuristic
    if (hostHasPort || !xfPort) {
      return `${proto}://${xfHost}`;
    }
    const defaultPort = proto === 'https' ? '443' : '80';
    if (xfPort === defaultPort) return `${proto}://${xfHost}`;
    return `${proto}://${xfHost}:${xfPort}`;
  }

  const host = pick('host');
  if (host) {
    // 不知道 scheme 时假定 http(MockForge 默认无 TLS)。
    // 若你前面挂了 HTTPS 反代,确保配 X-Forwarded-Proto 让 mockBaseUrl 用 https。
    const proto = (xfProto || 'http').toLowerCase();
    return `${proto}://${host}`;
  }

  return undefined;
}
