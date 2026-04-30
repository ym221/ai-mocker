import { test, expect } from '@playwright/test';
import { ThinkingParser } from '../src/server/agent/thinking-adapter';

/**
 * Pure unit tests — no browser, no backend. Uses Playwright's runner only.
 * Guards against the regression where `<thinking>` was not in TAG_PAIRS and the
 * closing `</thinking>` leaked fragments (e.g. `</tho`) into text output.
 */

function runFeed(parser: ThinkingParser, ...parts: string[]) {
  const all: { type: string; content?: string }[] = [];
  for (const p of parts) {
    for (const c of parser.feed(p)) {
      all.push({ type: c.type, content: (c as any).content });
    }
  }
  for (const c of parser.flush()) {
    all.push({ type: c.type, content: (c as any).content });
  }
  return all;
}

function concat(chunks: { type: string; content?: string }[], type: string) {
  return chunks.filter(c => c.type === type).map(c => c.content || '').join('');
}

test.describe('ThinkingParser', () => {
  test('P01 <thinking> 标签单次 feed', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, '<thinking>abc</thinking>hello');
    expect(concat(chunks, 'thinking')).toBe('abc');
    expect(concat(chunks, 'text')).toBe('hello');
  });

  test('P02 <think> 标签（短版）', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, '<think>xy</think>z');
    expect(concat(chunks, 'thinking')).toBe('xy');
    expect(concat(chunks, 'text')).toBe('z');
  });

  test('P03 <thinking> 分片 feed：开标签中间切', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, '<thi', 'nking>abc</thi', 'nking>z');
    expect(concat(chunks, 'thinking')).toBe('abc');
    expect(concat(chunks, 'text')).toBe('z');
  });

  test('P04 <thinking> 分片 feed：闭标签中间切（回归 "</thi" 泄漏）', () => {
    // '</thinking>' 长 11，在中间切：'</thi' (5) + 'nking>' (6)
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, '<thinking>abc</thi', 'nking>y');
    expect(concat(chunks, 'thinking')).toBe('abc');
    expect(concat(chunks, 'text')).toBe('y');
    // 最关键：text 里绝不能出现 '</thi' 等半闭合片段
    const textOut = concat(chunks, 'text');
    expect(textOut).not.toMatch(/<\/th/);
  });

  test('P05 非思考标签不误吞：<code>x</code>', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, '<code>x</code>');
    expect(concat(chunks, 'text')).toBe('<code>x</code>');
    expect(concat(chunks, 'thinking')).toBe('');
  });

  test('P06 裸 < 不死循环：a<b', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, 'a<b');
    expect(concat(chunks, 'text')).toBe('a<b');
  });

  test('P07 </thinking> 不会误判为 </think>（前缀陷阱）', () => {
    // activeCloseTag 来自 open 匹配，必须对应：opened with <thinking> → close </thinking>
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, '<thinking>inner</thinking>after');
    expect(concat(chunks, 'thinking')).toBe('inner');
    expect(concat(chunks, 'text')).toBe('after');
    // ensure 'ing>' didn't leak as text
    expect(concat(chunks, 'text')).not.toContain('ing>');
  });

  test('P08 流结束时闭标签未到达 → 剩余作为 thinking + 自动补 complete', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, '<thinking>unfinished');
    expect(concat(chunks, 'thinking')).toBe('unfinished');
    const hasComplete = chunks.some(c => c.type === 'thinking_complete');
    expect(hasComplete).toBe(true);
  });

  test('P09 <thought> 标签 + 混合片段', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, 'pre<thought>think</thought>post');
    expect(concat(chunks, 'thinking')).toBe('think');
    expect(concat(chunks, 'text')).toBe('prepost');
  });

  test('P10 超小分片（每 2 字符）压测', () => {
    const src = '<thinking>hello</thinking>world';
    const parser = new ThinkingParser();
    const pieces: string[] = [];
    for (let i = 0; i < src.length; i += 2) pieces.push(src.slice(i, i + 2));
    const chunks = runFeed(parser, ...pieces);
    expect(concat(chunks, 'thinking')).toBe('hello');
    expect(concat(chunks, 'text')).toBe('world');
  });

  // ===== Orphan close tag handling (Step-Observability-1.2 fix) =====
  // gemma 偶尔会发出不平衡的 `</thought>` 等闭合标签 (没有对应开标签)。
  // parser 必须静默吃掉,否则前面的 `<` 会泄漏到正文 (用户截图所见 bug)。

  test('P11 孤儿 </thought> 完整出现 → 静默吃掉,正文不含 <', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, 'before</thought>after');
    expect(concat(chunks, 'text')).toBe('beforeafter');
  });

  test('P12 多个孤儿 </thought> 连串 → 全部吃掉', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, '</thought></thought></thought>real');
    expect(concat(chunks, 'text')).toBe('real');
  });

  test('P13 孤儿闭标签所有 4 种 close 都识别', () => {
    for (const close of ['</thinking>', '</think>', '</thought>', '</reasoning>']) {
      const parser = new ThinkingParser();
      const chunks = runFeed(parser, `pre${close}post`);
      expect(concat(chunks, 'text')).toBe('prepost');
    }
  });

  test('P14 孤儿 close 跨 chunk 切片 → 仍正确合并 (回归"<泄漏")', () => {
    // 正是用户截图的精确场景: chunk 边界切在 `<` 后面
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, 'before<', '/thought>after');
    expect(concat(chunks, 'text')).toBe('beforeafter');
  });

  test('P15 真不平衡 (only `<` 后跟非标签字符) 仍按文本输出 — 不破坏现有语义', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, 'a < b');
    expect(concat(chunks, 'text')).toBe('a < b');
  });

  test('P16 重现用户截图: `</thought></thought></thought></thought></thought><` 全静默', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, '</thought></thought></thought></thought></thought><');
    // 5 个孤儿 close 全吃掉, 末尾的 `<` 是不完整 (可能是下一个 close 的前缀)
    // → 留 buffer; flush 时按 text 出 (这是合理的:流真的结束了)
    const flushed = parser.flush();
    const allText = concat([...chunks, ...flushed], 'text');
    // 最后一个 `<` 在 flush 时按 text 出,符合预期 (流没继续 → 不再判定是 close 前缀)
    expect(allText).toBe('<');
    // 关键: 5 个 </thought> 都被静默吃了
    expect(allText).not.toContain('thought');
  });

  // ===== Orphan OPEN tag (gemma 漏发 `<`,只发 `tagname>...content...</tagname>`) =====

  test('P17 漏发 `<` 的开标签: `thought>X</thought>Y` → X 算 thinking, Y 算 text', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, 'thought>The data has been generated.</thought>已为模块批量生成 100 条数据');
    expect(concat(chunks, 'thinking')).toBe('The data has been generated.');
    expect(concat(chunks, 'text')).toBe('已为模块批量生成 100 条数据');
    expect(chunks.some(c => c.type === 'thinking_complete')).toBe(true);
  });

  test('P18 漏发 `<` 的开标签 + 前面有正常 text: `prefix.thought>X</thought>after`', () => {
    const parser = new ThinkingParser();
    const chunks = runFeed(parser, 'real reply.thought>secret thinking</thought>more reply');
    expect(concat(chunks, 'thinking')).toBe('secret thinking');
    expect(concat(chunks, 'text')).toBe('real reply.more reply');
  });

  test('P19 4 种 tag 漏发 `<` 全部能被识别', () => {
    for (const tag of ['thinking', 'think', 'thought', 'reasoning']) {
      const parser = new ThinkingParser();
      const chunks = runFeed(parser, `${tag}>X</${tag}>Y`);
      expect(concat(chunks, 'thinking')).toBe('X');
      expect(concat(chunks, 'text')).toBe('Y');
    }
  });

  test('P20 漏发 `<` + 跨 chunk: gemma 流式分片仍能正确归类', () => {
    const parser = new ThinkingParser();
    // 拆成两段, `</tag>` 在第二段才到
    const chunks = runFeed(parser, 'thought>The data has been', ' generated.</thought>已为模块');
    expect(concat(chunks, 'thinking')).toBe('The data has been generated.');
    expect(concat(chunks, 'text')).toBe('已为模块');
  });

  test('P21 真重现用户场景 — 完整 gemma 输出', () => {
    const parser = new ThinkingParser();
    const real = 'thought>The data has been successfully generated. I should now inform the user.</thought>已为仓储管理模块批量生成 100 条模拟数据。';
    const chunks = runFeed(parser, real);
    // 关键: text 不应包含 "thought>" 泄漏
    const text = concat(chunks, 'text');
    expect(text).not.toContain('thought>');
    expect(text).toBe('已为仓储管理模块批量生成 100 条模拟数据。');
    expect(concat(chunks, 'thinking')).toBe('The data has been successfully generated. I should now inform the user.');
  });
});
