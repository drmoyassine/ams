// The evaluation set (packages/core/eval/assistant-instructions.json): every sample instruction's reference operations must produce
// EXACTLY the expected rows on the fixture tree. No database, no model, no network. (`pnpm assistant:eval` asks a real model.)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiRuntime, createFakeAiModel, runInAiScope, setAiModelForTests } from '../../ai/index.js';
import { RECIPE_OPS } from '@ams/shared';
import { askModelForOperations, checkReference, compareEffect, describeFixture, effectOf, resolveRefs, runOnFixture, uuidFor, type EvalSet } from './eval.js';
import { RowIndex, matchFilter } from './filter.js';
import { fixtureRows } from './eval.js';
import { codeRule, copyField, swapTitleAndDescription, textRule } from './recipes.js';

const set = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../eval/assistant-instructions.json'), 'utf8')) as EvalSet;

describe('the evaluation set', () => {
  it('has 30 to 40 instructions, in English and Arabic, and every recipe appears in it', () => {
    expect(set.instructions.length).toBeGreaterThanOrEqual(30);
    expect(set.instructions.length).toBeLessThanOrEqual(40);
    expect(new Set(set.instructions.map((i) => i.id)).size).toBe(set.instructions.length);
    expect(set.instructions.filter((i) => i.lang === 'ar').length).toBeGreaterThanOrEqual(8);
    expect(set.instructions.filter((i) => i.lang === 'en').length).toBeGreaterThanOrEqual(8);
    for (const i of set.instructions.filter((x) => x.lang === 'ar')) expect(i.text, i.id).toMatch(/[؀-ۿ]/);
    const used = new Set(set.instructions.flatMap((i) => i.operations.map((o) => (o as { op: string }).op)));
    for (const recipe of RECIPE_OPS) expect(used.has(recipe), recipe).toBe(true);
    for (const op of ['set_fields', 'move', 'create_requirement', 'merge', 'split', 'rewrite_text']) expect(used.has(op), op).toBe(true);
  });

  it.each(set.instructions.map((i) => [i.id, i] as const))('%s: the reference operations give exactly the expected rows', async (_id, instruction) => {
    expect(await checkReference(set, instruction)).toEqual([]);
  });

  it('a wrong expectation is reported, not ignored', async () => {
    const swap = set.instructions.find((i) => i.id === 'swap-1')!;
    const effect = effectOf(set.fixture, await runOnFixture(set.fixture, swap.operations));
    expect(compareEffect(effect, { ...swap.expect, changes: { ...swap.expect.changes, '1-1-1': { title: 'Something else', officialText: null } } })).not.toEqual([]);
    expect(compareEffect(effect, { ...swap.expect, skipped: [] })).not.toEqual([]);
    expect(compareEffect(effect, { problem: 'x' })).not.toEqual([]);
  });

  afterEach(() => setAiModelForTests(null));
  it('asks a model through the one import point (temperature 0, the assistant_eval prompt) and what it answers is planned like any operations', async () => {
    const swap = set.instructions.find((i) => i.id === 'swap-1')!;
    const fake = createFakeAiModel([{ operations: swap.operations }]);
    setAiModelForTests(fake.model);
    const runtime = createAiRuntime({ provider: 'test', model: 'test', apiKey: '' });
    const answer = await runInAiScope('job', () => askModelForOperations(set.fixture, swap.text, runtime));
    expect(answer.operations[0]).toMatchObject({ op: 'swap_title_and_description' });
    expect((fake.calls[0] as { temperature?: number }).temperature).toBe(0);
    expect(JSON.stringify(fake.calls[0])).toContain(uuidFor('1-1-1'));
    expect(runtime.calls[0]).toMatchObject({ task: 'assistant_eval', promptVersion: 'v1', ok: true });
    expect(compareEffect(effectOf(set.fixture, await runOnFixture(set.fixture, answer.operations)), swap.expect)).toEqual([]);
  });

  it('describes the fixture for a model with the ids the operations use', () => {
    const text = describeFixture(set.fixture);
    expect(text).toContain(uuidFor('1-1-1'));
    expect(resolveRefs({ id: '@1-1-1', list: ['@2', 'plain'] })).toEqual({ id: uuidFor('1-1-1'), list: [uuidFor('2'), 'plain'] });
  });
});

describe('the rules, row by row', () => {
  const { rows, noteCounts } = fixtureRows(set.fixture);
  const row = (code: string) => rows.find((r) => r.code === code)!;

  it('the title rule is the importer\'s rule (placeWording): a statement of up to 300 characters; nothing to use is skipped, never failed', () => {
    expect(swapTitleAndDescription(row('1-1-1'), 'statement_to_title')).toEqual({ patch: { title: 'The mission states the purpose of the institution.', officialText: null } });
    expect(swapTitleAndDescription(row('1-1-3'), 'statement_to_title')).toBeNull(); // the title already says something
    expect(swapTitleAndDescription(row('1-2-3'), 'statement_to_title')).toEqual({ skip: expect.stringMatching(/no description/) });
    expect(swapTitleAndDescription(row('1-2-2'), 'statement_to_title')).toEqual({ skip: expect.stringMatching(/longer than 300/) });
  });

  it('text results are NFC and never gain a direction mark; a rule that changes nothing returns nothing', () => {
    const decomposed = { ...row('1-2-1'), title: 'الم' };
    const r = textRule({ op: 'prefix_or_replace_text', filter: {}, field: 'title', mode: 'prefix', text: 'Café ', regex: false, caseInsensitive: false });
    if (!r.ok) throw new Error('rule');
    const out = r.run(decomposed);
    expect(out && 'patch' in out && out.patch.title).toBe('Café الم'.normalize('NFC'));
    expect(JSON.stringify(out)).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
    const again = r.run({ ...row('3-1'), title: 'Café Library' });
    expect(again).toBeNull(); // already starts with it: idempotent
  });

  it('copy_field keeps a title on one line and leaves a non-empty target when asked', () => {
    const multi = { ...row('3-2-1'), officialText: 'A statement\n  over two lines.' };
    expect(copyField(multi, { op: 'copy_field', filter: {}, from: 'officialText', to: 'title', onlyIfEmpty: false })).toEqual({ patch: { title: 'A statement over two lines.' } });
    expect(copyField(row('3-1'), { op: 'copy_field', filter: {}, from: 'code', to: 'title', onlyIfEmpty: true })).toEqual({ skip: expect.stringMatching(/already has text/) });
  });

  it('recode needs a mapping or a pattern, refuses contradictions, and reports an unsafe pattern', () => {
    expect(codeRule({ op: 'recode', filter: {} })).toMatchObject({ ok: false });
    expect(codeRule({ op: 'recode', filter: {}, mapping: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] })).toMatchObject({ ok: false });
    expect(codeRule({ op: 'recode', filter: {}, pattern: { find: '(x+)+', replaceWith: '', regex: true } })).toMatchObject({ ok: false });
    const ok = codeRule({ op: 'recode', filter: {}, mapping: [{ from: '1-1', to: '1-A' }] });
    if (!ok.ok) throw new Error('rule');
    expect(ok.newCode(row('1-1'))).toBe('1-A');
    expect(ok.newCode(row('1-2'))).toBeNull();
  });

  it('the filter engine: AND of conditions, loose codes, Arabic spelling variants, flags, and a bad name reports instead of matching everything', () => {
    const index = new RowIndex(rows, noteCounts);
    const codes = (f: object) => matchFilter(index, f).rows.map((r) => r.code);
    expect(codes({ level: 'Indicator', underCode: '1-1' })).toEqual(['1-1-1', '1-1-2', '1-1-3']);
    expect(codes({ codeStartsWith: '3.1' })).toEqual(['3-1', '3-1-1', '3.1.1']); // 3-1 and 3.1 are the same code, loosely
    expect(codes({ textContains: 'خطة دراسية' })).toContain('2-1-1'); // ة and ه are the same letter for matching
    expect(codes({ titleIsCode: true, level: 'Measure' })).toEqual(['1-1']);
    expect(codes({ emptyHeading: true, level: 'Measure' })).toEqual(['2-2', '2-3']);
    expect(codes({ duplicateCode: true })).toEqual(['3.1.1']);
    expect(codes({ quoteNotFound: true })).toEqual(['3-2-2']);
    expect(codes({ editedByPerson: true })).toEqual(['3-2-3']);
    expect(codes({ origin: 'ai' })).toEqual(['3-2-2']);
    expect(codes({ hasChildren: false, level: 'Measure' })).toEqual(['2-2', '2-3']);
    const bad = matchFilter(index, { parentCode: 'no-such' });
    expect(bad.rows).toEqual([]);
    expect(bad.problems[0]).toMatch(/no item with the code no-such/);
    expect(matchFilter(index, { codePattern: '(a+)+' }).problems[0]).toMatch(/too long/);
  });
});
