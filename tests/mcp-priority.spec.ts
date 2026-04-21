/**
 * Step-MCP-3.6: 规范优先级 system-prompt 集成测试
 *
 * 断言 "prompt 生成正确性":规范决策流程/禁止动作/决策对账/冲突可见化等硬约束
 * 必须稳定出现在 system-prompt 里。LLM 行为本身不在这里测(那是 Task 3.7 手测)。
 *
 * 与 system-prompt.spec.ts 互补:后者侧重结构/分区,这里侧重优先级+冲突语义。
 */
import { test, expect } from '@playwright/test';
import { buildSystemPrompt } from '../src/server/agent/system-prompt';

const base = { userId: 1, moduleList: [] };

test.describe('priority rules system prompt', () => {
  test('P01 preset=null 时不含"项目预设"分区', () => {
    const prompt = buildSystemPrompt({ ...base, preset: null });
    expect(prompt).not.toContain('## 项目预设');
    // 但仍然有决策流程 + 默认层
    expect(prompt).toContain('规范决策流程');
    expect(prompt).toContain('## 最佳实践默认');
  });

  test('P02 preset 有 responseFormat/fieldNaming/pagination 时各项都正确序列化', () => {
    const prompt = buildSystemPrompt({
      ...base,
      preset: {
        content: JSON.stringify({
          responseFormat: { code: 0, data: null, msg: '' },
          fieldNaming: 'snake_case',
          pagination: { page: 'pageNum', size: 'limit' },
        }),
      },
    });
    expect(prompt).toMatch(/项目预设[\s\S]*响应信封[\s\S]*"code":0/);
    expect(prompt).toMatch(/项目预设[\s\S]*字段命名[\s\S]*snake_case/);
    expect(prompt).toMatch(/项目预设[\s\S]*分页参数[\s\S]*pageNum/);
  });

  test('P03 prompt 始终包含决策流程硬规则(Step 1 user → Step 2 preset → Step 3 default)', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('规范决策流程');
    // Step 1/2/3 顺序必须存在 + 依次是 user → preset → default
    const s1 = prompt.indexOf('Step 1');
    const s2 = prompt.indexOf('Step 2');
    const s3 = prompt.indexOf('Step 3');
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
    expect(prompt.slice(s1, s2)).toMatch(/用户本次/);
    expect(prompt.slice(s2, s3)).toMatch(/项目预设/);
    expect(prompt.slice(s3)).toMatch(/最佳实践默认/);
  });

  test('P04 prompt 始终包含禁止动作清单', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('禁止动作');
    // 这四条是决策完整性的保险
    expect(prompt).toContain('禁止折中');
    expect(prompt).toContain('禁止擅自补充');
    expect(prompt).toContain('禁止曲解用户');
    expect(prompt).toContain('禁止同项混合');
  });

  test('P05 prompt 包含决策对账要求(含字段表头和具体规范项)', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('决策对账');
    // 必须要求 AI 在 thinking 里填表,不能等 write_file 之后
    expect(prompt).toMatch(/write_file.*之前[\s\S]*对账/);
    // 表头
    expect(prompt).toContain('| 规范项 | 来源 | 值 |');
    // 核心规范项要全
    for (const item of ['响应信封', '字段命名', '分页参数', '状态码策略', '错误码体系']) {
      expect(prompt).toContain(item);
    }
  });

  test('P06 preset 内容结构化到独立分区,不与默认段混排', () => {
    const prompt = buildSystemPrompt({
      ...base,
      preset: {
        content: JSON.stringify({ fieldNaming: 'snake_case' }),
      },
    });
    const presetIdx = prompt.indexOf('## 项目预设');
    const defaultIdx = prompt.indexOf('## 最佳实践默认');
    expect(presetIdx).toBeGreaterThan(0);
    expect(defaultIdx).toBeGreaterThan(presetIdx);
    // 两段独立 — 不能有"请先按 preset,否则按 default"这种混杂描述
    const presetBlock = prompt.slice(presetIdx, defaultIdx);
    // preset 块不应该重复写默认值
    expect(presetBlock).not.toContain('snake_case（与数据库列名一致）'); // 默认段的文案
  });

  test('P07 冲突可见化要求必须在最终回复里体现(用户 override preset 时)', () => {
    const prompt = buildSystemPrompt({
      ...base,
      preset: { content: JSON.stringify({ fieldNaming: 'snake_case' }) },
    });
    expect(prompt).toContain('冲突可见化');
    expect(prompt).toMatch(/最终回复/);
    expect(prompt).toMatch(/已优先采用你的指令|已忽略 preset/);
  });
});
