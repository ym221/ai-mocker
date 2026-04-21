/**
 * system-prompt 结构性测试 — pure unit, 无需后端。
 *
 * 验证 Task 3.2 的核心设计:
 *  - 分层呈现(用户/预设/默认)
 *  - 决策流程硬规则
 *  - 决策对账要求
 *  - 默认最佳实践包含状态码说明
 */
import { test, expect } from '@playwright/test';
import { buildSystemPrompt } from '../src/server/agent/system-prompt';

const emptyParams = {
  userId: 1,
  moduleList: [],
};

test.describe('system-prompt structure', () => {
  test('SP01 preset 有值时正确分区呈现', () => {
    const prompt = buildSystemPrompt({
      ...emptyParams,
      preset: {
        content: JSON.stringify({
          responseFormat: { code: 0, data: null, msg: '' },
          fieldNaming: 'snake_case',
          pagination: { page: 'pageNum', size: 'limit' },
        }),
      },
    });
    expect(prompt).toContain('## 项目预设');
    expect(prompt).toContain('仅当用户本次未指定对应项时生效');
    expect(prompt).toContain('响应信封');
    expect(prompt).toContain('snake_case');
    expect(prompt).toContain('pageNum');
  });

  test('SP02 preset 为 null 时不含"项目预设"小节', () => {
    const prompt = buildSystemPrompt({
      ...emptyParams,
      preset: null,
    });
    expect(prompt).not.toContain('## 项目预设');
    expect(prompt).toContain('## 最佳实践默认');
  });

  test('SP03 prompt 始终包含决策流程 + 禁止动作 + 决策对账', () => {
    const prompt = buildSystemPrompt(emptyParams);
    expect(prompt).toContain('规范决策流程');
    expect(prompt).toContain('Step 1');
    expect(prompt).toContain('Step 2');
    expect(prompt).toContain('Step 3');
    expect(prompt).toContain('禁止动作');
    expect(prompt).toContain('禁止折中');
    expect(prompt).toContain('禁止擅自补充');
    expect(prompt).toContain('决策对账');
    expect(prompt).toContain('| 规范项 | 来源 | 值 |');
    expect(prompt).toContain('冲突可见化');
  });

  test('SP04 默认最佳实践段包含 HTTP 状态码语义说明', () => {
    const prompt = buildSystemPrompt(emptyParams);
    expect(prompt).toContain('## 最佳实践默认');
    expect(prompt).toContain('200');
    expect(prompt).toContain('404');
    expect(prompt).toContain('500');
    // 关键语义：业务校验失败默认 200
    expect(prompt).toContain('业务校验失败');
    expect(prompt).toContain('success:false');
    // 包含 controller 响应写法片段(mock-router v2 协议)
    expect(prompt).toContain('statusCode');
    expect(prompt).toContain('__mock__');
  });

  test('SP05 无效 preset JSON 时安全回退(不抛)', () => {
    // 历史行为:遇到无效 JSON 忽略,仅展示默认层
    const prompt = buildSystemPrompt({
      ...emptyParams,
      preset: { content: 'not a json' },
    });
    expect(prompt).not.toContain('## 项目预设');
    expect(prompt).toContain('## 最佳实践默认');
  });

  test('SP06 preset 只有 customPrompt 时也能正确呈现', () => {
    const prompt = buildSystemPrompt({
      ...emptyParams,
      preset: {
        content: JSON.stringify({
          customPrompt: '所有金额字段统一用 BigInt 分单位',
        }),
      },
    });
    expect(prompt).toContain('## 项目预设');
    expect(prompt).toContain('所有金额字段统一用 BigInt 分单位');
  });
});
