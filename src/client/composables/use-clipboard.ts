/**
 * 跨 secure-context 安全的"复制到剪贴板"。
 *
 * 背景:`navigator.clipboard.writeText` 只在 secure context(HTTPS 或 localhost)
 * 下可用。用户把 MockForge 部署到 `http://<内网 IP>:<port>` 这类纯 HTTP 地址时,
 * 主路径直接抛 "NotAllowedError" / "The Clipboard API has been blocked because of
 * a permissions policy applied to the current document." 等错,前端 toast 显示
 * "复制失败",用户被迫手选地址栏。
 *
 * 解决:fallback 用 legacy `document.execCommand('copy')` —— 在 HTTP 下也工作,
 * 几乎所有浏览器都支持(虽然标准已 deprecate 但仍未真正下线)。
 *
 * 使用:
 *   import { copyToClipboard } from '@/composables/use-clipboard';
 *   await copyToClipboard(someUrl);  // throws on hard failure
 */

export async function copyToClipboard(text: string): Promise<void> {
  // 1. 优先用现代 Clipboard API(HTTPS / localhost 下走这条)
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 落到 legacy fallback;不抛出
    }
  }

  // 2. Legacy fallback:execCommand('copy') 在纯 HTTP 下仍可工作
  if (typeof document === 'undefined') {
    throw new Error('copyToClipboard not available in this environment');
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // 防止滚动跳动 + 防止 iOS 弹键盘
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.padding = '0';
  textarea.style.border = 'none';
  textarea.style.outline = 'none';
  textarea.style.boxShadow = 'none';
  textarea.style.background = 'transparent';
  textarea.setAttribute('readonly', '');
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    // iOS 兼容
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand("copy") returned false');
  } finally {
    document.body.removeChild(textarea);
  }
}
