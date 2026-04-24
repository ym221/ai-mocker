/**
 * Task M1.1 — get_module_template Agent 工具 + samples 库单元测试.
 */
import { test, expect } from '@playwright/test';
import { fetchModuleTemplate } from '../src/server/agent/tools/get-module-template';
import { getModuleTemplate, listTemplateKinds } from '../src/server/agent/templates/samples';

test.describe('module template library', () => {
  test('GT01 crud-basic 样例包含 5 个核心文件段 + SQL 表示例', () => {
    const content = getModuleTemplate('crud-basic');
    expect(content).toContain('todo/_meta.json');
    expect(content).toContain('todo/schema.sql');
    expect(content).toContain('todo/controller.ts');
    expect(content).toContain('todo/test.ts');
    expect(content).toContain('todo/api-doc.md');
    // SQL 表 + BaseModel 模板这些实际内容只在 kind=crud-basic 里才有
    expect(content).toContain('CREATE TABLE IF NOT EXISTS `mock__todo`');
    expect(content).toContain(".withMeta('todo')");
    expect(content).toContain("import { test, assert, request } from '@core/test-runner.js'");
  });

  test('GT02 with-constraints 样例包含字段约束 + 跨字段约束演示', () => {
    const content = getModuleTemplate('with-constraints');
    expect(content).toContain('constraints');
    expect(content).toContain('"enum":');
    expect(content).toContain('"pattern":');
    expect(content).toContain('"when":');
    expect(content).toContain('"must":');
    // 跨字段演示场景: qty=0 → out_of_stock
    expect(content).toContain('out_of_stock');
  });

  test('GT03 fetchModuleTemplate 合法 kind 返 success + content', () => {
    const r = fetchModuleTemplate('crud-basic');
    expect(r.success).toBe(true);
    expect(r.kind).toBe('crud-basic');
    expect(r.content).toContain('todo/_meta.json');
  });

  test('GT04 fetchModuleTemplate 非法 kind 返错误 + availableKinds 清单', () => {
    const r = fetchModuleTemplate('nonexistent' as any);
    expect(r.success).toBe(false);
    expect(r.message).toContain('Unknown template kind');
    expect(r.availableKinds).toEqual(['crud-basic', 'with-constraints']);
  });

  test('GT05 listTemplateKinds 返回稳定 order + 全部 kind', () => {
    expect(listTemplateKinds()).toEqual(['crud-basic', 'with-constraints']);
  });
});
