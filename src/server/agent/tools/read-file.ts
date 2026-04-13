import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const GENERATED_DIR = resolve('generated');

function validatePath(userPath: string, userId: number): string {
  if (userPath.includes('..') || /^[/\\]/.test(userPath) || /^[a-zA-Z]:/.test(userPath)) {
    throw new Error('Invalid path: directory traversal or absolute paths are not allowed');
  }

  const fullPath = resolve(join(GENERATED_DIR, String(userId), userPath));
  const expectedPrefix = resolve(join(GENERATED_DIR, String(userId)));

  if (!fullPath.startsWith(expectedPrefix)) {
    throw new Error('Invalid path: must be within generated/{userId}/ directory');
  }

  return fullPath;
}

export async function readFile(userId: number, path: string): Promise<string> {
  const fullPath = validatePath(path, userId);

  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${path}`);
  }

  return readFileSync(fullPath, 'utf-8');
}
