// The browser's confirm/alert/prompt cannot come back in the web app (DEC-026): the lint rule that forbids them is tested
// here against the repository's own ESLint configuration.
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.js') });
const lint = async (code: string, file = 'apps/web/src/pages/example.tsx') => (await eslint.lintText(code, { filePath: resolve(root, file) }))[0]!.messages;

describe('no browser dialogs in the web app', () => {
  it.each([
    ['confirm(...)', "export const a = () => { if (confirm('Delete?')) return 1; return 0; };"],
    ['window.confirm(...)', "export const a = () => (window.confirm('Delete?') ? 1 : 0);"],
    ['globalThis.confirm(...)', "export const a = () => globalThis.confirm('Delete?');"],
    ['alert(...)', "export const a = () => { alert('Saved'); };"],
    ['window.alert(...)', "export const a = () => { window.alert('Saved'); };"],
    ['prompt(...)', "export const a = () => prompt('Name?');"],
  ])('refuses %s', async (_name, code) => {
    const messages = await lint(code);
    expect(messages.map((m) => m.ruleId)).toEqual([expect.stringMatching(/^no-restricted-(globals|properties)$/)]);
    expect(messages[0]!.message).toContain('useConfirm()');
  });

  it('refuses it in tsx and in tests of the web app too', async () => {
    expect((await lint("export const A = () => <button onClick={() => window.confirm('x')}>x</button>;", 'apps/web/src/components/x.tsx')).length).toBe(1);
    expect((await lint("export const a = () => confirm('x');", 'apps/web/src/example.test.tsx')).length).toBe(1);
  });

  it('allows a local function or hook called confirm (the app dialog), and the rule does not reach other packages', async () => {
    expect(await lint("const confirm = async (o: { title: string }) => o.title === 'x';\nexport const a = () => confirm({ title: 'Delete?' });")).toEqual([]);
    expect(await lint("export const a = (confirm: (m: string) => boolean) => confirm('x');")).toEqual([]);
    expect((await lint("export const a = () => confirm('x');", 'packages/core/src/example.ts')).filter((m) => m.ruleId?.startsWith('no-restricted'))).toEqual([]);
  });
});

describe('no hard-coded UI text in converted files (warning)', () => {
  const converted = 'apps/web/src/pages/layout.tsx';
  const rule = (m: { ruleId: string | null }) => m.ruleId === 'ams/no-literal-ui-text';

  it('warns about JSX text and visible attributes in a converted file', async () => {
    const messages = await lint("export const A = () => <button title=\"Close it\" aria-label=\"Close\" placeholder=\"Type here\">Save the draft</button>;", converted);
    const hits = messages.filter(rule);
    expect(hits).toHaveLength(4);
    expect(hits.every((m) => m.severity === 1)).toBe(true); // a warning, not an error
    expect(hits.map((m) => m.message).join(' ')).toContain('use t(');
  });

  it('accepts text that comes from t(), symbols, numbers and code', async () => {
    const ok = "export const A = ({ t }: { t: (k: string) => string }) => <p title={t('a.b')}><span aria-hidden=\"true\">✕</span> {t('a.c')} 12 · <code>pnpm test</code></p>;";
    expect((await lint(ok, converted)).filter(rule)).toEqual([]);
  });

  it('does not reach files that are not converted yet', async () => {
    expect((await lint('export const A = () => <p>Some English text</p>;', 'apps/web/src/pages/version.tsx')).filter(rule)).toEqual([]);
  });

  it('covers every converted file listed in the configuration', async () => {
    const { CONVERTED_UI } = (await import('../../../eslint.config.js' as string)) as { CONVERTED_UI: string[] };
    expect(CONVERTED_UI.length).toBeGreaterThan(10);
    for (const f of CONVERTED_UI) expect((await lint('export const A = () => <p>Some English text</p>;', f)).filter(rule), f).toHaveLength(1);
  });

  it('keeps the converted files clean today', async () => {
    const { CONVERTED_UI } = (await import('../../../eslint.config.js' as string)) as { CONVERTED_UI: string[] };
    const results = await eslint.lintFiles(CONVERTED_UI.map((f: string) => resolve(root, f)));
    const left = results.flatMap((r) => r.messages.filter(rule).map((m) => `${r.filePath.replace(root, '')}:${m.line} ${m.message}`));
    expect(left).toEqual([]);
  });
});
