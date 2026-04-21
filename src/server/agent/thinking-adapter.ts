/**
 * ThinkingAdapter — 统一适配层 (Push-based API)
 *
 * 将 AI 模型输出中的 <think>/<thought>/<reasoning> 标签
 * 拆分为 thinking 和 text 两种 chunk。
 *
 * 设计为同步 push-based API，方便与 fullStream 事件循环集成。
 */

// ==================== 类型定义 ====================

export type ThinkingChunk =
  | { type: 'thinking'; content: string }
  | { type: 'text'; content: string }
  | { type: 'thinking_complete' };

// ==================== 支持的标签 ====================

// Order matters for close-tag matching: when insideThinking, we check
// buffer.startsWith(activeCloseTag) which can false-positive across tag
// variants (</think> is a prefix of </thinking>). We store the *exact*
// close tag paired at open time, so that's safe.
const TAG_PAIRS = [
  { open: '<thinking>', close: '</thinking>' },
  { open: '<think>', close: '</think>' },
  { open: '<thought>', close: '</thought>' },
  { open: '<reasoning>', close: '</reasoning>' },
];

// ==================== ThinkingParser ====================

/**
 * 流式状态机，逐段 feed 文本，输出 ThinkingChunk[]。
 *
 * 使用方式:
 *   const parser = new ThinkingParser();
 *   for (const textDelta of stream) {
 *     const chunks = parser.feed(textDelta);
 *     // send chunks to client
 *   }
 *   const remaining = parser.flush();
 */
export class ThinkingParser {
  private insideThinking = false;
  private buffer = '';
  private activeCloseTag = '';

  /** 输入一段文本，返回解析出的 chunks */
  feed(text: string): ThinkingChunk[] {
    this.buffer += text;
    const chunks: ThinkingChunk[] = [];

    while (this.buffer.length > 0) {
      if (!this.insideThinking) {
        // === 外部：寻找开标签 ===
        const ltIdx = this.buffer.indexOf('<');

        if (ltIdx === -1) {
          if (this.buffer.length > 0) {
            chunks.push({ type: 'text', content: this.buffer });
            this.buffer = '';
          }
          break;
        }

        if (ltIdx > 0) {
          chunks.push({ type: 'text', content: this.buffer.slice(0, ltIdx) });
          this.buffer = this.buffer.slice(ltIdx);
        }

        const matched = this.matchOpenTag();
        if (matched === 'partial') {
          break; // 等更多数据
        } else if (matched) {
          this.insideThinking = true;
          this.activeCloseTag = matched.closeTag;
          this.buffer = this.buffer.slice(matched.openTag.length);
        } else {
          chunks.push({ type: 'text', content: '<' });
          this.buffer = this.buffer.slice(1);
        }
      } else {
        // === 内部：寻找关闭标签 ===
        const ltIdx = this.buffer.indexOf('<');

        if (ltIdx === -1) {
          if (this.buffer.length > 0) {
            chunks.push({ type: 'thinking', content: this.buffer });
            this.buffer = '';
          }
          break;
        }

        if (ltIdx > 0) {
          chunks.push({ type: 'thinking', content: this.buffer.slice(0, ltIdx) });
          this.buffer = this.buffer.slice(ltIdx);
        }

        if (this.buffer.toLowerCase().startsWith(this.activeCloseTag)) {
          this.insideThinking = false;
          this.buffer = this.buffer.slice(this.activeCloseTag.length);
          chunks.push({ type: 'thinking_complete' });
        } else if (
          this.activeCloseTag.toLowerCase().startsWith(this.buffer.toLowerCase()) &&
          this.buffer.length < this.activeCloseTag.length
        ) {
          break; // 可能是关闭标签前缀
        } else {
          chunks.push({ type: 'thinking', content: '<' });
          this.buffer = this.buffer.slice(1);
        }
      }
    }

    return chunks;
  }

  /** 流结束后调用，flush 剩余内容 */
  flush(): ThinkingChunk[] {
    const chunks: ThinkingChunk[] = [];
    if (this.buffer.length > 0) {
      if (this.insideThinking) {
        chunks.push({ type: 'thinking', content: this.buffer });
      } else {
        chunks.push({ type: 'text', content: this.buffer });
      }
      this.buffer = '';
    }
    // If stream ended while still inside a thinking tag, emit completion marker
    // regardless of whether any residual content remained in the buffer.
    if (this.insideThinking) {
      chunks.push({ type: 'thinking_complete' });
      this.insideThinking = false;
      this.activeCloseTag = '';
    }
    return chunks;
  }

  private matchOpenTag(): { openTag: string; closeTag: string } | 'partial' | null {
    const lower = this.buffer.toLowerCase();
    for (const pair of TAG_PAIRS) {
      if (lower.startsWith(pair.open)) {
        return { openTag: pair.open, closeTag: pair.close };
      }
      if (pair.open.startsWith(lower) && lower.length < pair.open.length) {
        return 'partial';
      }
    }
    return null;
  }
}
