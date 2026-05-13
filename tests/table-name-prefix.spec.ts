import { test, expect } from '@playwright/test';
import { injectUserIdToTableNames } from '../src/server/core/table-name-prefix';

test.describe('injectUserIdToTableNames', () => {
  test('裸名 mock__Xxx 改写成 mock__1_Xxx', () => {
    expect(injectUserIdToTableNames('SELECT * FROM mock__OwnerCandidate', 1))
      .toBe('SELECT * FROM mock__1_OwnerCandidate');
  });

  test('反引号包裹 `mock__Xxx` 也改写', () => {
    expect(injectUserIdToTableNames('SELECT * FROM `mock__OwnerCandidate`', 1))
      .toBe('SELECT * FROM `mock__1_OwnerCandidate`');
  });

  test('snake_case 表名同样改写', () => {
    expect(injectUserIdToTableNames('SELECT * FROM mock__direct_hotel_finance WHERE id = ?', 7))
      .toBe('SELECT * FROM mock__7_direct_hotel_finance WHERE id = ?');
  });

  test('已带 userId 前缀的 mock__1_xxx 不双重注入', () => {
    expect(injectUserIdToTableNames('SELECT * FROM mock__1_OwnerCandidate', 1))
      .toBe('SELECT * FROM mock__1_OwnerCandidate');
    expect(injectUserIdToTableNames('SELECT * FROM `mock__42_thing`', 42))
      .toBe('SELECT * FROM `mock__42_thing`');
  });

  test('多张表混合 + 跨多个 SQL 语句', () => {
    const sql = `
      INSERT INTO mock__SupplierHotel (...) VALUES (...);
      INSERT INTO \`mock__DirectHotelFinance\` (...) VALUES (...);
      SELECT * FROM mock__ExportTask WHERE status = 0;
    `;
    const out = injectUserIdToTableNames(sql, 1);
    expect(out).toContain('mock__1_SupplierHotel');
    expect(out).toContain('`mock__1_DirectHotelFinance`');
    expect(out).toContain('mock__1_ExportTask');
  });

  test('不匹配业务列名 / 字符串 literal 里的 mock__xxx', () => {
    // 列名 mock_id 不该匹配(单下划线)
    expect(injectUserIdToTableNames('SELECT mock_id FROM users', 1))
      .toBe('SELECT mock_id FROM users');
    // 邻接 word char 的不该匹配 (xxxmock__yyy)
    expect(injectUserIdToTableNames("SELECT 'xxxmock__yyy' AS x", 1))
      .toBe("SELECT 'xxxmock__yyy' AS x");
  });
});
