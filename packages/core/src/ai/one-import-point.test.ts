// DEC-012 / CLAUDE.md constraint 7: the AI SDK is imported in one place, and the API and web never call the models.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'dist-types', 'migrations'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx|mjs)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield path;
  }
}
const scan = (dirs: string[], pattern: RegExp, allowed: (rel: string) => boolean) => {
  const offenders: string[] = [];
  for (const d of dirs) {
    for (const file of sources(join(ROOT, d))) {
      const rel = relative(ROOT, file);
      if (!allowed(rel) && pattern.test(readFileSync(file, 'utf8'))) offenders.push(rel);
    }
  }
  return offenders;
};

describe('AI import point', () => {
  it('imports the AI SDK and its providers only under packages/core/src/ai', () => {
    expect(scan(['apps', 'packages'], /from\s+['"](ai|ai\/test|@ai-sdk\/[^'"]+)['"]/, (rel) => rel.startsWith('packages/core/src/ai/'))).toEqual([]);
  });
  it('lets the API and the SPA reach a model only through the settings connection test', () => {
    expect(scan(['apps/api/src', 'apps/web/src'], /\b(aiExtract|aiOcr|embed|runInAiScope|loadAiRuntime|upsertEmbeddings|createModel)\b\s*[(<]/, () => false)).toEqual([]);
  });
});
