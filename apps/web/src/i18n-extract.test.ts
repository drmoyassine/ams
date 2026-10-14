// `pnpm i18n:extract` (needs the built shared package, like the other scripts): every key used in the web app exists in the
// English catalogue, and the script reports missing ones with their files and a failing exit code.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('pnpm i18n:extract', () => {
  it('passes for the repository as it is: no key used in the code is missing from the English catalogue', () => {
    const out = execFileSync('node', ['scripts/i18n-extract.mjs'], { cwd: root, encoding: 'utf8' });
    expect(out).toMatch(/\d+ keys used in the code, \d+ in the English catalogue/);
    expect(out).not.toContain('MISSING');
  });

  it('lists a missing key with the file that uses it and fails', () => {
    // A one-file "web app" that uses a key nobody wrote.
    const dir = mkdtempSync(join(tmpdir(), 'i18n-'));
    writeFileSync(join(dir, 'x.tsx'), "export const A = () => t('nav.settings') + t('totally.missing.key');");
    const r = spawnSync('node', ['scripts/i18n-extract.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, I18N_WEB_SRC: dir } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('MISSING');
    expect(r.stdout).toContain('totally.missing.key   (x.tsx)');
    expect(r.stdout).not.toContain('nav.settings   (');
  });
});
