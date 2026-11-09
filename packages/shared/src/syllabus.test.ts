import { describe, expect, it } from 'vitest';
import { DEFAULT_OUTCOME_LEVELS } from './outcomes.js';
import {
  DEFAULT_SYLLABUS_TEMPLATE, SyllabusTemplateSchema,
  checkSyllabus, cloWeights, DEFAULT_SYLLABUS_SETTINGS, emptySyllabus, errorsOf, SyllabusSettingsSchema, type SyllabusCheckContext, type SyllabusContent,
} from './syllabus.js';

const settings = DEFAULT_SYLLABUS_SETTINGS;
const ctx = (over: Partial<SyllabusCheckContext> = {}): SyllabusCheckContext => ({ settings, levels: DEFAULT_OUTCOME_LEVELS, ...over });
const codes = (c: SyllabusContent, over: Partial<SyllabusCheckContext> = {}) => checkSyllabus(c, ctx(over)).map((x) => x.code);

/** A complete, valid syllabus: 4 CLOs over 2 PLOs, three assessments whose weights and shares are 100, one rubric. */
function good(): SyllabusContent {
  const c = emptySyllabus();
  c.info = { titleEn: 'Digital Signal Processing', titleAr: 'معالجة الإشارات الرقمية', credits: 3, languageOfDelivery: 'english', contactLecture: 3, contactLab: 0, contactOther: 0, courseType: 'didactic', courseLevel: '400', category: 'program_core', sustainability: 'none', prerequisiteIds: [], corequisiteIds: [] };
  c.description.en = 'An advanced course on discrete-time signals and filters.';
  c.methodology = 'Lectures, demonstrations and hands-on work.';
  c.materials = [{ kind: 'textbook', citation: 'Proakis, Digital Signal Processing', isbn: '', year: null }];
  c.clos = ['a', 'b', 'c', 'd'].map((id, k) => ({ id, code: `CLO${k + 1}`, textEn: `Outcome ${k + 1}`, textAr: '', bloom: 'apply', ploId: k < 2 ? 'plo1' : 'plo2', level: k < 3 ? 'R' : 'M' }));
  c.rubrics = [{ id: 'r', title: 'Problem solving', levels: [{ name: 'Proficient', min: 70, max: 100 }, { name: 'Developing', min: 0, max: 69 }], criteria: [{ name: 'Method', descriptions: ['Sound', 'Partly sound'] }] }];
  c.assessments = [
    { id: 'q', name: 'Quizzes', category: 'quiz', objective: '', weight: 30, dueWeek: 6, clos: [{ cloId: 'a', share: 50, rubricId: 'r' }, { cloId: 'b', share: 50, rubricId: 'r' }] },
    { id: 'm', name: 'Mid exam', category: 'midterm', objective: '', weight: 30, dueWeek: 8, clos: [{ cloId: 'b', share: 50, rubricId: 'r' }, { cloId: 'c', share: 50, rubricId: 'r' }] },
    { id: 'f', name: 'Final exam', category: 'final', objective: '', weight: 40, dueWeek: 15, clos: [{ cloId: 'c', share: 50, rubricId: 'r' }, { cloId: 'd', share: 50, rubricId: 'r' }] },
  ];
  c.outline = [{ week: 1, topic: 'Signals and systems', reading: '', lab: '', cloIds: ['a'], sdgs: [], assessmentId: '', activity: '' }];
  return c;
}

describe('the syllabus rule checker', () => {
  it('finds nothing wrong with a complete syllabus', () => {
    expect(checkSyllabus(good(), ctx({ allowedPloIds: new Set(['plo1', 'plo2']), programCount: 1 }))).toEqual([]);
  });

  it('flags every missing required field of a new draft as an error, and never throws', () => {
    const found = codes(emptySyllabus());
    for (const code of ['info.title', 'info.credits', 'info.language', 'info.contact', 'info.type', 'info.level', 'info.category', 'info.sustainability', 'description.missing', 'methodology.missing', 'clos.min', 'materials.textbook', 'assessments.none']) expect(found).toContain(code);
  });

  it('holds the number of CLOs and of distinct PLOs to the settings, minimum and maximum', () => {
    const c = good();
    expect(codes(c, { settings: { ...settings, maxClos: 3 } })).toContain('clos.max');
    expect(codes(c, { settings: { ...settings, minClos: 5 } })).toContain('clos.min');
    expect(codes(c, { settings: { ...settings, maxPlos: 1 } })).toContain('plos.max');
    expect(codes(c, { settings: { ...settings, minPlos: 3 } })).toContain('plos.min');
    expect(codes(c)).not.toContain('plos.max'); // two PLOs: within 1..5
  });

  it('wants one PLO and a coverage level for each CLO, and refuses an unknown level or a PLO of another program', () => {
    const c = good();
    c.clos[0]!.ploId = ''; c.clos[1]!.level = ''; c.clos[2]!.level = 'Z'; c.clos[3]!.bloom = '';
    const found = checkSyllabus(c, ctx({ allowedPloIds: new Set(['plo2']) }));
    expect(found.filter((x) => x.severity === 'error').map((x) => [x.code, x.ref])).toEqual(expect.arrayContaining([['clo.plo', 'a'], ['clo.level', 'b'], ['clo.levelInvalid', 'c'], ['clo.bloom', 'd']]));
    const other = good();
    expect(checkSyllabus(other, ctx({ allowedPloIds: new Set(['plo2']) })).some((x) => x.code === 'clo.ploInvalid' && x.ref === 'a')).toBe(true);
  });

  it('reads a configured alias of a coverage level as that level (D is Reinforced)', () => {
    const c = good(); c.clos[0]!.level = 'D';
    expect(codes(c)).not.toContain('clo.levelInvalid');
  });

  it('adds up the weights: the course total and each assessment’s CLO shares must be 100', () => {
    const c = good(); c.assessments[0]!.weight = 20; c.assessments[1]!.clos[0]!.share = 40;
    const found = checkSyllabus(c, ctx());
    expect(found.find((x) => x.code === 'assessments.total')?.message).toContain('90%');
    expect(found.find((x) => x.code === 'assessment.shares')?.message).toContain('90%');
  });

  it('wants every CLO assessed, every assessed CLO with a known rubric, and lets participation have no CLO', () => {
    const c = good(); c.assessments[2]!.clos = c.assessments[2]!.clos.filter((l) => l.cloId === 'c'); c.assessments[2]!.clos[0]!.share = 100;
    expect(codes(c)).toContain('clo.notAssessed');
    const r = good(); r.assessments[0]!.clos[0]!.rubricId = ''; r.assessments[0]!.clos[1]!.rubricId = 'nope';
    expect(codes(r)).toEqual(expect.arrayContaining(['assessment.rubric', 'assessment.rubricUnknown']));
    const p = good(); p.assessments.push({ id: 'p', name: 'Participation', category: 'participation', objective: '', weight: 0, dueWeek: 14, clos: [] });
    expect(codes(p)).not.toContain('assessment.noClo');
  });

  it('warns, without an error, about a CLO that carries too little of the grade', () => {
    const c = good();
    c.assessments[2]!.clos[1]!.share = 5; c.assessments[2]!.clos[0]!.share = 95; // CLO d: 40% x 5% = 2% of the grade
    const found = checkSyllabus(c, ctx());
    expect(found.find((x) => x.code === 'clo.lowWeight')).toMatchObject({ severity: 'warning', ref: 'd' });
    expect(errorsOf(found)).toEqual([]);
    expect(cloWeights(c).get('d')).toBeCloseTo(2);
  });

  it('checks the outline, the rubrics and the requisites', () => {
    const c = good();
    c.outline.push({ week: 1, topic: 'Again', reading: '', lab: '', cloIds: ['zzz'], sdgs: [], assessmentId: '', activity: '' }, { week: 2, topic: '', reading: '', lab: '', cloIds: [], sdgs: [], assessmentId: '', activity: '' });
    c.rubrics[0]!.criteria[0]!.descriptions = ['Sound', ''];
    c.info.prerequisiteIds = ['ghost'];
    expect(codes(c, { knownCourseIds: new Set() })).toEqual(expect.arrayContaining(['outline.duplicateWeek', 'outline.clo', 'outline.topic', 'rubric.descriptions', 'info.requisite']));
  });

  it('lets an admin make an unlocked field optional, but never the CLOs, the weights or the rubrics', () => {
    const c = emptySyllabus();
    expect(codes(c, { optional: new Set(['description.en', 'methodology']) })).not.toContain('description.missing');
    expect(codes(c, { optional: new Set(['clos', 'assessments', 'rubrics']) })).toEqual(expect.arrayContaining(['clos.min', 'assessments.none']));
  });

  it('warns when the contact hours are fewer than the credit hours', () => {
    const c = good(); c.info.contactLecture = 1;
    expect(checkSyllabus(c, ctx()).find((x) => x.code === 'info.contactHours')?.severity).toBe('warning');
  });
});

describe('the syllabus settings', () => {
  it('refuse a minimum above a maximum and an escalation that does not go up the line', () => {
    expect(SyllabusSettingsSchema.safeParse(settings).success).toBe(true);
    expect(SyllabusSettingsSchema.safeParse({ ...settings, minClos: 9 }).success).toBe(false);
    expect(SyllabusSettingsSchema.safeParse({ ...settings, minPlos: 6 }).success).toBe(false);
    expect(SyllabusSettingsSchema.safeParse({ ...settings, escalateDays: { chair: 10, dean: 5, vpaa: 20 } }).success).toBe(false);
  });
});

describe('the syllabus template', () => {
  const t = DEFAULT_SYLLABUS_TEMPLATE;
  it('accepts the default, a reordered one, an added section and an optional field', () => {
    expect(SyllabusTemplateSchema.safeParse(t).success).toBe(true);
    expect(SyllabusTemplateSchema.safeParse({ ...t, sections: [...t.sections].reverse() }).success).toBe(true);
    expect(SyllabusTemplateSchema.safeParse({ ...t, sections: [...t.sections, { key: 'custom:policy-links', title: 'Policy links', help: '', locked: false }] }).success).toBe(true);
    expect(SyllabusTemplateSchema.safeParse({ ...t, optional: ['methodology', 'info.titleAr'] }).success).toBe(true);
  });
  it('refuses to remove a section the rules depend on, to make a locked field optional, or to hide a built-in lock', () => {
    const r = SyllabusTemplateSchema.safeParse({ ...t, sections: t.sections.filter((x) => x.key !== 'clos') });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/cannot be removed/);
    expect(SyllabusTemplateSchema.safeParse({ ...t, optional: ['clos'] }).success).toBe(false);
    expect(SyllabusTemplateSchema.safeParse({ ...t, sections: t.sections.map((x) => (x.key === 'assessments' ? { ...x, locked: false } : x)) }).success).toBe(false);
    expect(SyllabusTemplateSchema.safeParse({ ...t, sections: [...t.sections, { key: 'made-up', title: 'X', help: '', locked: false }] }).success).toBe(false);
  });
});
