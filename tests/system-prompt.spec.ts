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
    // Step-Fix-1.4 压缩后 "禁止折中/擅自补充/曲解" 合并在一条,"禁止动作" 标题保留
    expect(prompt).toContain('禁止动作');
    expect(prompt).toContain('禁止折中');
    expect(prompt).toContain('禁止同项混合');
    expect(prompt).toContain('决策对账');
    // Step-Fix-1.4 把 6 行表格压缩成单行枚举,便于 AI 直接逐项对账
    expect(prompt).toContain('响应信封');
    expect(prompt).toContain('字段命名');
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

  test('SP07 prompt 体积上限 — 回归防膨胀', () => {
    // prompt 瘦身后 < 12.8KB(完整 todo 模板 ~8KB 已移到 get_module_template 工具按需拉)。
    // 加新规则前先评估 byte 成本,该 bound 是软约束,有充分理由可调高。
    const emptyPrompt = buildSystemPrompt(emptyParams);
    const withPresetPrompt = buildSystemPrompt({
      ...emptyParams,
      preset: {
        content: JSON.stringify({ fieldNaming: 'snake_case', responseFormat: { success: true, data: null } }),
      },
    });
    expect(Buffer.byteLength(emptyPrompt, 'utf8')).toBeLessThan(12800);
    expect(Buffer.byteLength(withPresetPrompt, 'utf8')).toBeLessThan(13000);
    // 用 get_module_template 工具按需拉样例,不在 prompt 里写死
    expect(emptyPrompt).toContain('get_module_template');
    expect(emptyPrompt).not.toContain('CREATE TABLE IF NOT EXISTS `mock__todo`');
    expect(emptyPrompt).not.toContain("test('创建待办', async (ctx)");
  });

  test('SP08 (Step-Fix-1.4) 5 必需文件清单明示', () => {
    const prompt = buildSystemPrompt(emptyParams);
    // 开工流程段必须逐项列出 5 个必需文件,让 AI 无法"漏写 api-doc.md"
    for (const f of ['_meta.json', 'schema.sql', 'controller.ts', 'test.ts', 'api-doc.md']) {
      expect(prompt).toContain(f);
    }
    expect(prompt).toContain('必需文件');
    expect(prompt).toContain('缺一');
  });

  test('SP09 schema.sql 时间戳字段按需可选,框架不强制', () => {
    const prompt = buildSystemPrompt(emptyParams);
    // 主键 id 自增是硬规则
    expect(prompt).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    // 时间戳由用户/AI 按 spec 决定,框架不自动管
    expect(prompt).toContain('按用户 spec 决定');
    expect(prompt).toContain('框架不自动管');
    // 加时间戳时的 DEFAULT 指引
    expect(prompt).toContain('CURRENT_TIMESTAMP');
  });

  test('SP10 (Step-Fix-1.4) _meta.json 禁用 legacy entity 字段,只用 entities[]', () => {
    const prompt = buildSystemPrompt(emptyParams);
    expect(prompt).toContain('entities');
    // 必须明确禁止,否则弱模型仍会凭记忆/训练分布写 entity 顶层字段
    expect(prompt).toContain('禁用');
    expect(prompt).toContain('老格式');
  });

  test('SP11 (Step-Fix-1.4) 多实体 controller 命名规则 + 必填 endpoint.controller', () => {
    const prompt = buildSystemPrompt(emptyParams);
    // 多实体场景必须说明 named-handler 方案
    expect(prompt).toContain('多实体');
    expect(prompt).toContain('endpoints[].controller');
    // 具体示例: listItems / getWarehouseById 等命名模式
    expect(prompt).toMatch(/listItems|getWarehouseById|createItem/);
    // 签名说明 req = { body, query, params }
    expect(prompt).toContain('body');
    expect(prompt).toContain('query');
    expect(prompt).toContain('params');
  });
});
