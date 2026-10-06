// The glossary: starter terms, structural suggestions for how each standard's words map onto them, edits and who may make them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, ValidationError } from '../ctx.js';
import { setUpQualityFramework, getQualityFramework } from '../framework/internal.js';
import { updateVersionConfig } from '../framework/versions.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { classifyLevel } from './defaults.js';
import { autoMapStandards, createTerm, getGlossary, listExternalTerms, seedDefaultGlossary, setAlias, updateTerm } from './glossary.js';

let w: World;
const std = async (short: string) => (await w.as('admin', (c) => listExternalTerms(c))).find((s) => s.accreditorShortName === short)!;
const termId = async (key: string) => (await w.as('admin', (c) => getGlossary(c))).terms.find((t) => t.key === key)!.id;

beforeAll(async () => {
  w = await buildWorld('glossary');
  await w.as('admin', (c) => setUpQualityFramework(c, { levelLabels: ['Standard', 'Sub-standard'] })); // its levels are the glossary's level terms
}, 60000);
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
    expect(g.terms.map((t) => t.key)).toEqual(expect.arrayContaining(['level_1', 'level_2', 'required_action', 'observation', 'self_study_report']));
    expect(g.aliases).toEqual([]);
  });
});

describe('external terms and the suggested mapping', () => {
  it('lists the levels, finding names and report types of every standard, with a structural suggestion', async () => {
    const abet = await std('ABET');
    const suggestion = (s: typeof abet, source: string, term: string) => s.terms.find((t) => t.source === source && t.externalTerm === term)!.suggestedKey;
    expect(suggestion(abet, 'level_label', 'Criterion')).toBe('level_1');
    expect(suggestion(abet, 'level_label', 'Item')).toBe('level_2');
    for (const code of ['deficiency', 'weakness', 'concern']) expect(suggestion(abet, 'finding_code', code)).toBe('required_action');
    expect(suggestion(abet, 'finding_code', 'observation')).toBe('observation');
    expect(suggestion(abet, 'report_template', 'ssr')).toBe('self_study_report');
    expect(suggestion(abet, 'report_template', 'readiness')).toBeNull(); // no stable internal term

    const wscuc = await std('WSCUC');
    expect(suggestion(wscuc, 'level_label', 'Standard')).toBe('level_1');
    expect(suggestion(wscuc, 'level_label', 'Heading')).toBe('level_1');
    expect(suggestion(wscuc, 'level_label', 'CFR')).toBe('level_2');
    expect(suggestion(wscuc, 'finding_code', 'recommendation')).toBe('required_action');
    expect(suggestion(wscuc, 'finding_code', 'commendation')).toBe('observation');
    expect(suggestion(wscuc, 'report_template', 'institutional_report')).toBe('self_study_report');
    expect(suggestion(wscuc, 'report_template', 'annual_report')).toBe('annual_report');

    const puc = await std('PUC');
    expect(['Standard', 'Measure'].map((l) => suggestion(puc, 'level_label', l))).toEqual(['level_1', 'level_1']);
    expect(suggestion(puc, 'level_label', 'Indicator')).toBe('level_2');
    expect(abet.terms.every((t) => t.termId === null)).toBe(true);
  });

  it('maps everything suggested, once, and leaves what has no suggestion unmapped', async () => {
    const first = await w.as('alo', (c) => autoMapStandards(c));
    expect(first.mapped).toBeGreaterThan(20);
    expect(await w.as('alo', (c) => autoMapStandards(c))).toEqual({ mapped: 0 });
    const abet = await std('ABET');
    const mapped = (term: string, source = 'level_label') => abet.terms.find((t) => t.source === source && t.externalTerm === term)!.termId;
    expect(mapped('Criterion')).toBe(await termId('level_1'));
    expect(mapped('Item')).toBe(await termId('level_2'));
    expect(mapped('readiness', 'report_template')).toBeNull();
    await expect(w.as('contrib', (c) => autoMapStandards(c))).rejects.toThrow(ForbiddenError);
  });
});

describe('editing the mapping', () => {
  it('re-maps and clears one external term', async () => {
    const wscuc = await std('WSCUC');
    const base = { frameworkId: wscuc.frameworkId, source: 'level_label' as const, externalTerm: 'CFR' };
    const group = await termId('level_1');
    await w.as('alo', (c) => setAlias(c, { ...base, termId: group }));
    expect((await std('WSCUC')).terms.find((t) => t.externalTerm === 'CFR')!.termId).toBe(group);
    await w.as('alo', (c) => setAlias(c, { ...base, termId: null }));
    expect((await std('WSCUC')).terms.find((t) => t.externalTerm === 'CFR')!.termId).toBeNull();
    await w.as('alo', (c) => setAlias(c, { ...base, termId: group })); // put back what the suggestion would have been
    await w.as('alo', (c) => setAlias(c, { ...base, termId: null }));
    await w.as('alo', (c) => autoMapStandards(c, wscuc.frameworkId));
    expect((await std('WSCUC')).terms.find((t) => t.externalTerm === 'CFR')!.termId).toBe(await termId('level_2'));
  });

  it('refuses a term of the wrong kind, an unknown external term, and non-editors', async () => {
    const wscuc = await std('WSCUC');
    await expect(w.as('alo', (c) => setAlias(c, { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'CFR', termId: '00000000-0000-4000-8000-000000000000' }))).rejects.toThrow(/term/);
    await expect(w.as('alo', async (c) => setAlias(c, { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'CFR', termId: await termId('observation') }))).rejects.toThrow(ConflictError);
    await expect(w.as('alo', async (c) => setAlias(c, { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'Nonsense', termId: await termId('level_2') }))).rejects.toThrow(ValidationError);
    await expect(w.as('contrib', async (c) => setAlias(c, { frameworkId: wscuc.frameworkId, source: 'level_label', externalTerm: 'CFR', termId: await termId('level_2') }))).rejects.toThrow(ForbiddenError);
  });
});

describe('level terms follow the quality framework', () => {
  it('are the framework\'s level names, not typed in or renamed here', async () => {
    const levels = (await w.as('contrib', (c) => getGlossary(c))).terms.filter((t) => t.kind === 'level');
    expect(levels.map((t) => [t.key, t.labelEn])).toEqual([['level_1', 'Standard'], ['level_2', 'Sub-standard']]);
    await expect(w.as('alo', (c) => createTerm(c, { kind: 'level', labelEn: 'Extra' }))).rejects.toThrow(ValidationError);
    await expect(w.as('alo', async (c) => updateTerm(c, await termId('level_1'), { labelEn: 'Pillar' }))).rejects.toThrow(ConflictError);
    const ar = await w.as('alo', async (c) => updateTerm(c, await termId('level_1'), { labelAr: 'معيار' })); // the Arabic name and definitions are editable
    expect(ar.labelAr).toBe('معيار');
  });

  it('are renamed, extended and cut back with the framework, and mappings move rather than break', async () => {
    const v = (await w.as('admin', (c) => getQualityFramework(c))).versions[0]!;
    const before = await termId('level_2');
    await w.as('admin', (c) => updateVersionConfig(c, v.id, { levelLabels: ['Pillar', 'Standard', 'Indicator'] }));
    let g = await w.as('contrib', (c) => getGlossary(c));
    expect(g.terms.filter((t) => t.kind === 'level' && t.active).map((t) => t.labelEn)).toEqual(['Indicator', 'Pillar', 'Standard']);
    expect(await termId('level_2')).toBe(before); // renamed in place, so what mapped to it still does
    expect(g.terms.find((t) => t.key === 'level_2')!.labelEn).toBe('Standard');
    await w.as('alo', (c) => autoMapStandards(c));
    const abet = await std('ABET');
    expect(abet.terms.find((t) => t.externalTerm === 'Item')!.termId).toBe(before); // mapped earlier to the old lowest level, kept
    await w.as('admin', (c) => updateVersionConfig(c, v.id, { levelLabels: ['Standard', 'Sub-standard'] }));
    g = await w.as('contrib', (c) => getGlossary(c));
    expect(g.terms.find((t) => t.key === 'level_3')!.active).toBe(false);
    // what mapped to the level that went away now maps to the lowest remaining one
    expect((await w.as('alo', (c) => getGlossary(c))).aliases.some((a) => a.termId === g.terms.find((t) => t.key === 'level_3')!.id)).toBe(false);
  });
});

describe('terms', () => {
  it('adds a term with a generated key, refuses a duplicate, and edits labels and definitions in both languages', async () => {
    const t = await w.as('alo', (c) => createTerm(c, { kind: 'general', labelEn: 'Sub-requirement', labelAr: 'متطلب فرعي', definitionEn: 'A part of a requirement.' }));
    expect(t).toMatchObject({ key: 'sub_requirement', kind: 'general', labelAr: 'متطلب فرعي', active: true });
    await expect(w.as('alo', (c) => createTerm(c, { kind: 'general', labelEn: 'Sub-requirement' }))).rejects.toThrow(/already exists/);
    const edited = await w.as('alo', (c) => updateTerm(c, t.id, { labelEn: 'Sub-item', definitionAr: 'جزء من متطلب' }));
    expect(edited).toMatchObject({ key: 'sub_requirement', labelEn: 'Sub-item', definitionAr: 'جزء من متطلب' });
    await expect(w.as('contrib', (c) => updateTerm(c, t.id, { labelEn: 'x' }))).rejects.toThrow(ForbiddenError);
  });

  it('cannot deactivate a term that standards map to, but can once nothing does', async () => {
    const id = await termId('required_action');
    await expect(w.as('alo', (c) => updateTerm(c, id, { active: false }))).rejects.toThrow(/still map/);
    const free = await w.as('alo', (c) => createTerm(c, { kind: 'general', labelEn: 'Spare term' }));
    expect((await w.as('alo', (c) => updateTerm(c, free.id, { active: false }))).active).toBe(false);
  });

  it('is audited', async () => {
    const { rows } = await w.db.su.query(`select count(*)::int as n from audit_event where target_type in ('glossary_term', 'glossary_alias')`);
    expect(rows[0].n).toBeGreaterThan(20);
  });
});
