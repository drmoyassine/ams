// DEC-002 / CLAUDE.md constraint 1: no accreditor-specific code. Everything accreditor-specific is framework
// configuration (fixtures, imported files); a name appearing in source would be a branch waiting to happen.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const NAMES = /\b(WSCUC|WASC|ABET|NBAQ|PUC|Kuwait)\b/i;

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'dist-types', 'migrations', 'fixtures'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sources(path);
    // Test code and test-support fixtures name accreditors freely: they load Appendix A files, they do not branch on them.
    else if (/\.(ts|tsx|sql)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && entry !== 'test-support.ts') yield path;
  }
}

describe('no accreditor-specific code', () => {
  it('names no accreditor in application source', () => {
    const offenders: string[] = [];
    for (const area of ['packages', 'apps']) {
      for (const pkg of readdirSync(join(ROOT, area))) {
        const src = join(ROOT, area, pkg, 'src');
        try { statSync(src); } catch { continue; }
        for (const file of sources(src)) {
          readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (NAMES.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`); });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
