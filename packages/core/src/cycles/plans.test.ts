// Plan inheritance and the subjects of a plan (TASK-081). Pure: own, nearest ancestor, the whole standard, approved mapped IQF
// nodes, opt-out, and applies_to narrowing the node's effective scope.
import { describe, expect, it } from 'vitest';
import { resolvePlanTree, subjectsFor, type Candidate, type MappedPlans, type PlanRef, type Universe } from './plans.js';

const tree = [
  { code: '4', parentCode: null }, { code: '4.1', parentCode: '4' }, { code: '4.1.a', parentCode: '4.1' }, { code: '4.2', parentCode: '4' }, { code: '5', parentCode: null },
];
const ANNUAL = 'tpl-annual', COURSE = 'tpl-course';
const plan = (id: string, templateId: string, mode: 'own' | 'opt_out' = 'own'): PlanRef => ({ id, templateId, mode });
const own = (entries: Record<string, PlanRef[]>) => new Map(Object.entries(entries));
const eff = (r: ReturnType<typeof resolvePlanTree>, code: string) => r.get(code)!.effective.map((e) => [e.templateId, e.planId, e.source.kind, e.source.code, e.optedOut]);

describe('plans down a tree', () => {
  it('a node uses its own plan, else its nearest ancestor\'s, labelled with where it is set', () => {
    const r = resolvePlanTree(tree, own({ '4': [plan('p4', ANNUAL)], '4.1': [plan('p41', ANNUAL)] }));
    expect(eff(r, '4')).toEqual([[ANNUAL, 'p4', 'own', null, false]]);
    expect(eff(r, '4.1')).toEqual([[ANNUAL, 'p41', 'own', null, false]]);
    expect(eff(r, '4.1.a')).toEqual([[ANNUAL, 'p41', 'parent', '4.1', false]]);
    expect(eff(r, '4.2')).toEqual([[ANNUAL, 'p4', 'parent', '4', false]]);
    expect(eff(r, '5')).toEqual([]);
  });
  it('keeps the origin through several levels ("From 4" for 4.1.a when 4.1 inherited it)', () => {
    const r = resolvePlanTree(tree, own({ '4': [plan('p4', ANNUAL)] }));
    expect(eff(r, '4.1.a')).toEqual([[ANNUAL, 'p4', 'parent', '4', false]]);
  });
  it('a plan on the whole standard reaches every node, labelled as such', () => {
    const r = resolvePlanTree(tree, own({}), [plan('pw', ANNUAL)]);
    expect(eff(r, '5')).toEqual([[ANNUAL, 'pw', 'framework', null, false]]);
    expect(eff(r, '4.1.a')).toEqual([[ANNUAL, 'pw', 'framework', null, false]]);
  });
  it('plans of different templates are independent: an extra one on a standard adds to the one above', () => {
    const r = resolvePlanTree(tree, own({ '4': [plan('p4c', COURSE)] }), [plan('pw', ANNUAL)]);
    expect(eff(r, '4.2')).toEqual([[ANNUAL, 'pw', 'framework', null, false], [COURSE, 'p4c', 'parent', '4', false]]);
    expect(eff(r, '5')).toEqual([[ANNUAL, 'pw', 'framework', null, false]]);
  });
  it('an opt-out stops the template at that node and below, and only that template', () => {
    const r = resolvePlanTree(tree, own({ '4': [plan('p4', ANNUAL), plan('p4c', COURSE)], '4.1': [plan('o41', ANNUAL, 'opt_out')] }));
    expect(eff(r, '4.1')).toEqual([[ANNUAL, 'o41', 'own', null, true], [COURSE, 'p4c', 'parent', '4', false]]);
    expect(eff(r, '4.1.a')).toEqual([[ANNUAL, 'o41', 'parent', '4.1', true], [COURSE, 'p4c', 'parent', '4', false]]);
    expect(eff(r, '4.2').map((e) => e[4])).toEqual([false, false]);
  });
  it('"Back to inherited" shows what the node would have without its own plans', () => {
    const r = resolvePlanTree(tree, own({ '4': [plan('p4', ANNUAL)], '4.1': [plan('p41', ANNUAL)] }));
    expect(r.get('4.1')!.inherited.map((e) => [e.planId, e.source.kind, e.source.code])).toEqual([['p4', 'parent', '4']]);
    expect(r.get('4.2')!.inherited).toEqual(r.get('4.2')!.effective);
  });
});

describe('an external standard follows its approved mapped IQF nodes', () => {
  const ext = [{ code: 'C1', parentCode: null }, { code: 'C1.1', parentCode: 'C1' }, { code: 'C2', parentCode: null }];
  const iqf = resolvePlanTree(tree, own({ '4': [plan('p4', ANNUAL)], '4.1': [plan('p41', ANNUAL)], '4.2': [plan('o42', ANNUAL, 'opt_out')] }));
  const via = (...codes: string[]) => codes.map((code): MappedPlans => ({ code, effective: iqf.get(code)!.effective }));

  it('takes the mapped node\'s plan unless it has its own', () => {
    const r = resolvePlanTree(ext, own({}), [], new Map([['C1', via('4.1')]]));
    expect(eff(r, 'C1')).toEqual([[ANNUAL, 'p41', 'iqf', '4.1', false]]);
    expect(eff(r, 'C1.1')).toEqual([[ANNUAL, 'p41', 'iqf', '4.1', false]]);   // its child follows through the origin
    expect(eff(r, 'C2')).toEqual([]);
    const mine = resolvePlanTree(ext, own({ C1: [plan('pc1', ANNUAL)] }), [], new Map([['C1', via('4.1')]]));
    expect(eff(mine, 'C1')).toEqual([[ANNUAL, 'pc1', 'own', null, false]]);
    expect(mine.get('C1')!.inherited.map((e) => [e.planId, e.source.kind, e.source.code])).toEqual([['p41', 'iqf', '4.1']]);
  });
  it('with several mapped nodes takes the first plan (code order) that is not opted out, naming every node that gives it', () => {
    const r = resolvePlanTree(ext, own({}), [], new Map([['C1', via('4.1', '4.1.a', '4.2')]]));
    const e = r.get('C1')!.effective[0]!;
    expect([e.planId, e.source, e.sourceCodes, e.optedOut]).toEqual(['p41', { kind: 'iqf', code: '4.1' }, ['4.1', '4.1.a'], false]);
    const optedOutFirst = resolvePlanTree(ext, own({}), [], new Map([['C1', via('4.2', '4.1')]]));
    expect(optedOutFirst.get('C1')!.effective[0]).toMatchObject({ planId: 'p41', optedOut: false });
    const allOut = resolvePlanTree(ext, own({}), [], new Map([['C1', via('4.2')]]));
    expect(allOut.get('C1')!.effective[0]).toMatchObject({ planId: 'o42', optedOut: true });
  });
  it('an external requirement can opt out of what the IQF gives it', () => {
    const r = resolvePlanTree(ext, own({ C1: [plan('oc1', ANNUAL, 'opt_out')] }), [], new Map([['C1', via('4.1')]]));
    expect(eff(r, 'C1')).toEqual([[ANNUAL, 'oc1', 'own', null, true]]);
    expect(eff(r, 'C1.1')).toEqual([[ANNUAL, 'oc1', 'parent', 'C1', true]]);
  });
});

describe('who a plan\'s runs are about', () => {
  const c = (kind: Candidate['kind'], id: string, name: string, extra: Partial<Candidate> = {}): Candidate => ({ kind, id, name, unitId: kind === 'org_unit' ? id : null, ...extra });
  const u: Universe = {
    institution: c('institution', 'inst', 'Gulf University'),
    units: [c('org_unit', 'u-eng', 'Engineering', { unitType: 'college' }), c('org_unit', 'u-qa', 'QA Office', { unitType: 'admin_unit' })],
    programs: [
      c('program', 'p-me', 'BS Mechanical', { unitId: 'u-eng', programLevel: 'bachelor' }), c('program', 'p-ce', 'BS Civil', { unitId: 'u-eng', programLevel: 'bachelor' }),
      c('program', 'p-ms', 'MS Civil', { unitId: 'u-eng', programLevel: 'master' }),
    ],
  };
  const names = (l: Candidate[]) => l.map((x) => x.name);

  it('is the node\'s effective scope: every program, or only the listed ones', () => {
    expect(names(subjectsFor(u, [{ kind: 'program', itemIds: [] }]))).toEqual(['BS Civil', 'BS Mechanical', 'MS Civil']);
    expect(names(subjectsFor(u, [{ kind: 'program', itemIds: ['p-me'] }]))).toEqual(['BS Mechanical']);
    expect(names(subjectsFor(u, [{ kind: 'institution', itemIds: [] }]))).toEqual(['Gulf University']);
  });
  it('unites several levels (a standard mapped to scopes at two levels), without repeats, units before programs', () => {
    expect(names(subjectsFor(u, [{ kind: 'program', itemIds: ['p-ce'] }, { kind: 'org_unit', itemIds: [] }, { kind: 'program', itemIds: ['p-ce', 'p-me'] }]))).toEqual(['Engineering', 'QA Office', 'BS Civil', 'BS Mechanical']);
  });
  it('is narrowed by applies_to: kinds, unit types, program levels, an explicit list', () => {
    const all = [{ kind: 'program' as const, itemIds: [] }, { kind: 'org_unit' as const, itemIds: [] }];
    expect(names(subjectsFor(u, all, { kinds: ['program'] }))).toEqual(['BS Civil', 'BS Mechanical', 'MS Civil']);
    expect(names(subjectsFor(u, all, { kinds: ['org_unit'], unitTypes: ['admin_unit'] }))).toEqual(['QA Office']);
    expect(names(subjectsFor(u, [{ kind: 'program', itemIds: [] }], { programLevels: ['master'] }))).toEqual(['MS Civil']);
    expect(names(subjectsFor(u, [{ kind: 'program', itemIds: [] }], { ids: ['p-me', 'p-ms', 'u-eng'] }))).toEqual(['BS Mechanical', 'MS Civil']);
  });
  it('can never reach beyond the scope: applies_to listing a program outside the scope adds nothing', () => {
    expect(names(subjectsFor(u, [{ kind: 'program', itemIds: ['p-me'] }], { ids: ['p-ce'] }))).toEqual([]);
  });
  it('with no scope anywhere applies_to alone names them; with neither there are none', () => {
    expect(names(subjectsFor(u, null, { kinds: ['program'], programLevels: ['bachelor'] }))).toEqual(['BS Civil', 'BS Mechanical']);
    expect(names(subjectsFor(u, null, { ids: ['p-ms', 'u-qa'] }))).toEqual(['QA Office', 'MS Civil']);
    expect(subjectsFor(u, null, {})).toEqual([]);
  });
  it('course and custom levels hold no records yet, so they give nobody', () => {
    expect(subjectsFor(u, [{ kind: 'course', itemIds: [] }, { kind: 'custom', itemIds: [] }])).toEqual([]);
  });
});
