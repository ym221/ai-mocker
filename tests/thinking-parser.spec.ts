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
});
