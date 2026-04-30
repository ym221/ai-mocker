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

  // 推迟发送的 "text" 内容 — 在非 thinking 状态下,所有非 `<` 字符先进 pendingText,
  // 等遇到下一个 `<` 再决定语义:
  //   - 孤儿 close tag 检测到时,把 pendingText 末尾的 `tagname>...` 归类为 thinking
  //     (修复 gemma 偶尔漏掉 `<` 只发 `thought>X</thought>` 的场景)
  //   - 真 open tag → flush pendingText 为 text,进入 thinking
  //   - 普通 `<` 字符 → 追加到 pendingText 继续等
  // 上限 10KB 避免无 `<` 长文本时无限累积。
  private pendingText = '';
  private static readonly PENDING_FLUSH_BYTES = 10_000;

  /** Flush pendingText as text into chunks (helper). */
  private flushPendingAsText(chunks: ThinkingChunk[]): void {
    if (this.pendingText.length > 0) {
      chunks.push({ type: 'text', content: this.pendingText });
      this.pendingText = '';
    }
  }

  /** 输入一段文本，返回解析出的 chunks */
  feed(text: string): ThinkingChunk[] {
    this.buffer += text;
    const chunks: ThinkingChunk[] = [];

    while (this.buffer.length > 0) {
      if (!this.insideThinking) {
        // === 外部：寻找开标签 ===
        const ltIdx = this.buffer.indexOf('<');

        if (ltIdx === -1) {
          // No `<` left in buffer — push remaining text into pendingText
          if (this.buffer.length > 0) {
            this.pendingText += this.buffer;
            this.buffer = '';
            // Bound pendingText growth: emit early if too big (no orphan close coming)
            if (this.pendingText.length > ThinkingParser.PENDING_FLUSH_BYTES) {
              this.flushPendingAsText(chunks);
            }
          }
          break;
        }

        if (ltIdx > 0) {
          this.pendingText += this.buffer.slice(0, ltIdx);
          this.buffer = this.buffer.slice(ltIdx);
        }

        // 1) 优先匹配孤儿 close tag (e.g. gemma 不平衡输出 `</thought>` 不带开标签)
        //    这种情况静默吃掉,不流到正文。否则会泄漏 `<` 字符给用户(buffer
        //    chunk 边界刚好截在 `<` 后面时尤其明显)。
        const orphanClose = this.matchOrphanCloseTag();
        if (orphanClose === 'partial') break;
        if (orphanClose) {
          // 回溯: 看 pendingText 末尾是否有 `tagname>` 开头(开标签缺 `<` 的情况)
          // 若有 → 把 `tagname>` 之后到 close 之前的部分归类为 thinking,前面的部分仍是 text。
          const tagName = orphanClose.slice(2, -1).toLowerCase(); // e.g. "thought"
          const orphanOpenPrefix = tagName + '>';
          const lowerPending = this.pendingText.toLowerCase();
          const prefixIdx = lowerPending.lastIndexOf(orphanOpenPrefix);
          if (prefixIdx !== -1) {
            // pendingText 里有 `tagname>` — 视为漏了 `<` 的开标签
            if (prefixIdx > 0) {
              chunks.push({ type: 'text', content: this.pendingText.slice(0, prefixIdx) });
            }
            const thinkingContent = this.pendingText.slice(prefixIdx + orphanOpenPrefix.length);
            if (thinkingContent.length > 0) {
              chunks.push({ type: 'thinking', content: thinkingContent });
            }
            chunks.push({ type: 'thinking_complete' });
            this.pendingText = '';
          } else {
            // 没有匹配的孤儿 open 前缀 → 正常输出 pendingText,close 静默吃掉
            this.flushPendingAsText(chunks);
          }
          this.buffer = this.buffer.slice(orphanClose.length);
          continue;
        }

        const matched = this.matchOpenTag();
        if (matched === 'partial') {
          break; // 等更多数据
        } else if (matched) {
          // 真 open tag — 先 flush 任何 pendingText 为 text,再进入 thinking
          this.flushPendingAsText(chunks);
          this.insideThinking = true;
          this.activeCloseTag = matched.closeTag;
          this.buffer = this.buffer.slice(matched.openTag.length);
        } else {
          // 既不是 tag 也不是孤儿 close — 把 `<` 视为普通文本,追加进 pendingText
          this.pendingText += '<';
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
    // pendingText 没等到下一个 `<` 解析,视为普通文本
    this.flushPendingAsText(chunks);
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

  /**
   * 检测孤儿 close tag (gemma 等模型有时会发出 `</thought>` 等闭合标签
   * 而没有对应的开标签)。返回完整的 close tag 字符串(让调用方 slice 掉),
   * 或 'partial' 表示当前 buffer 可能是某个 close tag 的前缀,需等更多数据。
   *
   * 静默吃掉 — 不输出 chunk。如果不处理,那个 `<` 会作为 text 泄漏到正文。
   */
  private matchOrphanCloseTag(): string | 'partial' | null {
    const lower = this.buffer.toLowerCase();
    if (!lower.startsWith('</')) return null;
    for (const pair of TAG_PAIRS) {
      if (lower.startsWith(pair.close)) return pair.close;
    }
    // 可能是某个 close tag 的前缀 (e.g. `</tho` → 等更多数据)
    for (const pair of TAG_PAIRS) {
      if (pair.close.startsWith(lower) && lower.length < pair.close.length) {
        return 'partial';
      }
    }
    return null;
  }
}
