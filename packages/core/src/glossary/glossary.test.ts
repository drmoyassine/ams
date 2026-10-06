// The glossary: starter terms, structural suggestions for how each standard's words map onto them, edits and who may make them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { classifyLevel } from './defaults.js';
import { autoMapStandards, createTerm, getGlossary, listExternalTerms, seedDefaultGlossary, setAlias, updateTerm } from './glossary.js';

let w: World;
const std = async (short: string) => (await w.as('admin', (c) => listExternalTerms(c))).find((s) => s.accreditorShortName === short)!;
const termId = async (key: string) => (await w.as('admin', (c) => getGlossary(c))).terms.find((t) => t.key === key)!.id;

beforeAll(async () => { w = await buildWorld('glossary'); }, 60000);
afterAll(() => w.close());

describe('structural level classification', () => {
  it('calls a label a group when it only sits at the top, labels headings, or always has requirements below it', () => {
    const base = { label: 'x', allTopLevel: false, noneAssessable: false, allHaveChildren: false };
    expect(classifyLevel({ ...base, allTopLevel: true })).toBe('requirement_group');
    expect(classifyLevel({ ...base, noneAssessable: true })).toBe('requirement_group');
    expect(classifyLevel({ ...base, allHaveChildren: true })).toBe('requirement_group');
    expect(classifyLevel(base)).toBe('requirement');
  });
});

describe('starter glossary', () => {
  it('is added once, to the institution, by someone who may edit', async () => {
    await expect(w.as('contrib', (c) => seedDefaultGlossary(c))).rejects.toThrow(ForbiddenError);
    const first = await w.as('alo', (c) => seedDefaultGlossary(c));
    expect(first.added).toBeGreaterThanOrEqual(8);
    expect(await w.as('alo', (c) => seedDefaultGlossary(c))).toEqual({ added: 0 });
    const g = await w.as('contrib', (c) => getGlossary(c)); // everyone in the institution can read it
    expect(g.terms.map((t) => t.key)).toEqual(expect.arrayContaining(['requirement_group', 'requirement', 'required_action', 'observation', 'self_study_report']));
    expect(g.aliases).toEqual([]);
  });
});

describe('external terms and the suggested mapping', () => {
  it('lists the levels, finding names and report types of every standard, with a structural suggestion', async () => {
    const abet = await std('ABET');
    const suggestion = (s: typeof abet, source: string, term: string) => s.terms.find((t) => t.source === source && t.externalTerm === term)!.suggestedKey;
    expect(suggestion(abet, 'level_label', 'Criterion')).toBe('requirement_group');
    expect(suggestion(abet, 'level_label', 'Item')).toBe('requirement');
    for (const code of ['deficiency', 'weakness', 'concern']) expect(suggestion(abet, 'finding_code', code)).toBe('required_action');
    expect(suggestion(abet, 'finding_code', 'observation')).toBe('observation');
    expect(suggestion(abet, 'report_template', 'ssr')).toBe('self_study_report');
    expect(suggestion(abet, 'report_template', 'readiness')).toBeNull(); // no stable internal term

    const wscuc = await std('WSCUC');
    expect(suggestion(wscuc, 'level_label', 'Standard')).toBe('requirement_group');
    expect(suggestion(wscuc, 'level_label', 'Heading')).toBe('requirement_group');
    expect(suggestion(wscuc, 'level_label', 'CFR')).toBe('requirement');
    expect(suggestion(wscuc, 'finding_code', 'recommendation')).toBe('required_action');
    expect(suggestion(wscuc, 'finding_code', 'commendation')).toBe('observation');
    expect(suggestion(wscuc, 'report_template', 'institutional_report')).toBe('self_study_report');
    expect(suggestion(wscuc, 'report_template', 'annual_report')).toBe('annual_report');

    const puc = await std('PUC');
    expect(['Standard', 'Measure'].map((l) => suggestion(puc, 'level_label', l))).toEqual(['requirement_group', 'requirement_group']);
    expect(suggestion(puc, 'level_label', 'Indicator')).toBe('requirement');
    expect(abet.terms.every((t) => t.termId === null)).toBe(true);
  });

  it('maps everything suggested, once, and leaves what has no suggestion unmapped', async () => {
    const first = await w.as('alo', (c) => autoMapStandards(c));
    expect(first.mapped).toBeGreaterThan(20);
    expect(await w.as('alo', (c) => autoMapStandards(c))).toEqual({ mapped: 0 });
    const abet = await std('ABET');
    const mapped = (term: string, source = 'level_label') => abet.terms.find((t) => t.source === source && t.externalTerm === term)!.termId;
    expect(mapped('Criterion')).toBe(await termId('requirement_group'));
    expect(mapped('Item')).toBe(await termId('requirement'));
    expect(mapped('readiness', 'report_template')).toBeNull();
    await expect(w.as('contrib', (c) => autoMapStandards(c))).rejects.toThrow(ForbiddenError);
  });
});

describe('editing the mapping', () => {
  it('re-maps and clears one external term', async () => {
    const wscuc = await std('WSCUC');
    const base = { frameworkId: wscuc.frameworkId, source: 'level_label' as const, externalTerm: 'CFR' };
    const group = await termId('requirement_group');
    await w.as('alo', (c) => setAlias(c, { ...base, termId: group }));
    expect((await std('WSCUC')).terms.find((t) => t.externalTerm === 'CFR')!.termId).toBe(group);
    await w.as('alo', (c) => setAlias(c, { ...base, termId: null }));
    expect((await std('WSCUC')).terms.find((t) => t.externalTerm === 'CFR')!.termId).toBeNull();
    await w.as('alo', (c) => setAlias(c, { ...base, termId: group })); // put back what the suggestion would have been
    await w.as('alo', (c) => setAlias(c, { ...base, termId: null }));
    await w.as('alo', (c) => autoMapStandards(c, wscuc.frameworkId));
    expect((await std('WSCUC')).terms.find((t) => t.externalTerm === 'CFR')!.termId).toBe(await termId('requirement'));
  });

  it('refuses a term of the wrong kind, an unknown external term, and non-editors', async () => {
    const wscuc = await std('WSCUC');
    await expect(w.as('alo', (c) => setAlias(c, { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'CFR', termId: '00000000-0000-4000-8000-000000000000' }))).rejects.toThrow(/term/);
    await expect(w.as('alo', async (c) => setAlias(c, { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'CFR', termId: await termId('observation') }))).rejects.toThrow(ConflictError);
    await expect(w.as('alo', async (c) => setAlias(c, { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'Nonsense', termId: await termId('requirement') }))).rejects.toThrow(ValidationError);
    await expect(w.as('contrib', async (c) => setAlias(c, { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'CFR', termId: await termId('requirement') }))).rejects.toThrow(ForbiddenError);
  });
});

describe('terms', () => {
  it('adds a term with a generated key, refuses a duplicate, and edits labels and definitions in both languages', async () => {
    const t = await w.as('alo', (c) => createTerm(c, { kind: 'level', labelEn: 'Sub-requirement', labelAr: 'متطلب فرعي', definitionEn: 'A part of a requirement.' }));
    expect(t).toMatchObject({ key: 'sub_requirement', kind: 'level', labelAr: 'متطلب فرعي', active: true });
    await expect(w.as('alo', (c) => createTerm(c, { kind: 'level', labelEn: 'Sub-requirement' }))).rejects.toThrow(/already exists/);
    const edited = await w.as('alo', (c) => updateTerm(c, t.id, { labelEn: 'Sub-item', definitionAr: 'جزء من متطلب' }));
    expect(edited).toMatchObject({ key: 'sub_requirement', labelEn: 'Sub-item', definitionAr: 'جزء من متطلب' });
    await expect(w.as('contrib', (c) => updateTerm(c, t.id, { labelEn: 'x' }))).rejects.toThrow(ForbiddenError);
  });

  it('cannot deactivate a term that standards map to, but can once nothing does', async () => {
    const id = await termId('requirement');
    await expect(w.as('alo', (c) => updateTerm(c, id, { active: false }))).rejects.toThrow(/still map/);
    const free = await w.as('alo', (c) => createTerm(c, { kind: 'general', labelEn: 'Spare term' }));
    expect((await w.as('alo', (c) => updateTerm(c, free.id, { active: false }))).active).toBe(false);
  });

  it('is audited', async () => {
    const { rows } = await w.db.su.query(`select count(*)::int as n from audit_event where target_type in ('glossary_term', 'glossary_alias')`);
    expect(rows[0].n).toBeGreaterThan(20);
  });
});
