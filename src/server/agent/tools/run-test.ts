import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { resetTests, runAllTests } from '../../core/test-runner.js';
import { mockContext } from '../../core/base-model.js';
import { sqlite } from '../../core/database.js';

const GENERATED_DIR = resolve('generated');

export async function runTest(userId: number, moduleName: string): Promise<{
  passed: number;
  total: number;
  failures: { name: string; error: string }[];
}> {
  const testPath = join(GENERATED_DIR, String(userId), moduleName, 'test.ts');

  if (!existsSync(testPath)) {
    throw new Error(`Test file not found: ${moduleName}/test.ts`);
  }

  // Clear test residual data
  const metaPath = join(GENERATED_DIR, String(userId), moduleName, '_meta.json');
  if (existsSync(metaPath)) {
    try {
      const { readFileSync } = await import('fs');
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      for (const entity of meta.entities || []) {
        const tableName = `mock__${userId}_${entity.name}`;
        try {
          sqlite.exec(`DELETE FROM \`${tableName}\``);
        } catch {
          // Table might not exist yet
        }
      }
    } catch {
      // Non-critical
    }
  }

  // Reset test registry
  resetTests();

  // Dynamic import with cache busting
  const fileUrl = pathToFileURL(testPath).href + `?t=${Date.now()}`;

  // Run within mockContext so BaseModel knows the userId
  return mockContext.run({ userId }, async () => {
    await import(fileUrl);
    return runAllTests();
  });
}
