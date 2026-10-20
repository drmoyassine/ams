// Academic calendar, cycle plans and proposed runs (TASK-081) against a real database: the calendar manager, plans on an evidence item
// (course assessment, every semester), on the whole IQF (annual report, every year, every program), on a standard with scope, inheritance
// down the IQF and to a mapped external requirement with override and opt-out, the due runs, "Skip this period", launching a proposed
// run (plan, period, previous run), a date set by a decision, permissions and Undo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity } from '@ams/db';
import type { UndoDescriptor } from '@ams/shared';
import { LaunchCycleSchema } from '@ams/shared';
import { ConflictError, ForbiddenError, ValidationError, type Ctx } from '../ctx.js';
import { buildWorld, type World } from '../engagement/test-support.js';
import { requirementContexts } from '../evidence/evidence.js';
import { setUpQualityFramework } from '../framework/internal.js';
import { createRequirement, listRequirements, reviewRequirement } from '../framework/requirements.js';
import { publishVersion, submitForReview } from '../framework/versions.js';
import { createMapping, reviewMapping } from '../mapping/mapping.js';
import { setRequirementScope } from '../scope/assignments.js';
import {
  activateCycle, clearPlan, createAcademicTerm, deleteAcademicTerm, getCycle, getTargetPlans, installDefaultTemplates, launchCycle, listAcademicTerms, listDueRuns, listPlans,
  listTemplates, loadPlanAssignments, reorderAcademicTerms, setNextDate, setPlan, skipDueRun, updateAcademicTerm,
} from './index.js';

let w: World;
const ids: Record<string, string> = {};
let lastUndo: UndoDescriptor | null = null;
const asU = <T>(who: string, fn: (ctx: Ctx) => Promise<T>) => {
  const caller = { userId: w.ids[who]!, institutionId: w.ids.inst!, requestId: crypto.randomUUID(), actorType: 'user' as const };
  lastUndo = null;
  return withIdentity(w.pool, caller, (tx) => fn({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined, store: w.store, undo: (d) => { lastUndo = d; } }));
};
const one = async (sql: string, p: unknown[] = []) => (await w.db.su.query(sql, p)).rows[0].id as string;
const TODAY = '2026-09-10';
const due = (q: Parameters<typeof listDueRuns>[1] = {}) => w.as('alo', (c) => listDueRuns(c, { horizonDays: 200, ...q }, { today: TODAY }));
const summary = (r: Awaited<ReturnType<typeof listDueRuns>>) => r.runs.map((x) => `${x.periodLabel}|${x.subjectName ?? x.anchorName}`);

beforeAll(async () => {
  w = await buildWorld('plansvc');
  const q = await w.as('admin', (c) => setUpQualityFramework(c));
  ids.qv = q.versions[0]!.id;
  const std = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'Q1', levelLabel: 'Standard', title: 'Teaching quality' }));
  const sub1 = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'Q1.1', levelLabel: 'Sub-standard', title: 'Course review', parentId: std.id }));
  const sub2 = await w.as('admin', (c) => createRequirement(c, { versionId: ids.qv!, code: 'Q1.2', levelLabel: 'Sub-standard', title: 'Assessment', parentId: std.id }));
  for (const r of [std, sub1, sub2]) await w.as('admin', (c) => reviewRequirement(c, r.id, 'approved'));
  await w.as('admin', (c) => submitForReview(c, ids.qv!));
  await w.as('admin', (c) => publishVersion(c, ids.qv!));
  ids.iqfFw = await one(`select framework_id as id from framework_version where id = $1`, [ids.qv]);
  ids.q1 = std.id; ids.q12 = sub2.id;
  const ext = await w.as('admin', (c) => listRequirements(c, w.ids.abet!));
  ids.ext1 = ext.find((r) => r.isAssessable)!.id;
  ids.extCode1 = ext.find((r) => r.id === ids.ext1)!.code;
  ids.abetFw = await one(`select framework_id as id from framework_version where id = $1`, [w.ids.abet]);
  const unit = await one(`select id from org_unit limit 1`);
  ids.unit = unit;
  ids.civil = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Civil', 'bachelor') returning id`, [w.ids.inst, unit]);
  ids.msCivil = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'MS Civil', 'master') returning id`, [w.ids.inst, unit]);
  ids.evidence = await one(`insert into evidence_item (institution_id, title, type, owner_unit_id) values ($1, 'Course results', 'document', $2) returning id`, [w.ids.inst, unit]);
  await w.as('admin', (c) => installDefaultTemplates(c));
  for (const t of await w.as('admin', (c) => listTemplates(c))) ids[`tpl_${t.key}`] = t.id;
  ids.other = await one(`insert into institution (name_en) values ('Other University') returning id`);
}, 240000);
afterAll(() => w.close());

describe('the academic calendar', () => {
  it('is managed by whoever writes the organization, with English and Arabic names', async () => {
    await expect(w.as('contrib', (c) => createAcademicTerm(c, { name: 'Fall 2026', kind: 'term', startDate: '2026-08-24', endDate: '2026-12-18' }))).rejects.toThrow(ForbiddenError);
    const year = await asU('admin', (c) => createAcademicTerm(c, { name: 'AY2026-27', nameAr: 'العام ٢٠٢٦-٢٧', kind: 'year', startDate: '2026-08-15', endDate: '2027-08-14' }));
    expect(year).toMatchObject({ name: 'AY2026-27', nameAr: 'العام ٢٠٢٦-٢٧', kind: 'year', active: true, displayOrder: 0 });
    expect(lastUndo).toMatchObject({ method: 'DELETE', path: `/api/academic-terms/${year.id}` });
    await w.as('admin', (c) => createAcademicTerm(c, { name: 'AY2027-28', kind: 'year', startDate: '2027-08-15', endDate: '2028-08-14' }));
    await w.as('admin', (c) => createAcademicTerm(c, { name: 'Fall 2026', kind: 'term', startDate: '2026-08-24', endDate: '2026-12-18' }));
    await w.as('admin', (c) => createAcademicTerm(c, { name: 'Spring 2027', kind: 'term', startDate: '2027-01-18', endDate: '2027-05-14' }));
    await w.as('admin', (c) => createAcademicTerm(c, { name: 'Fall 2027', kind: 'term', startDate: '2027-08-23', endDate: '2027-12-17' }));
    expect((await w.as('contrib', (c) => listAcademicTerms(c))).map((t) => t.name)).toEqual(['AY2026-27', 'AY2027-28', 'Fall 2026', 'Spring 2027', 'Fall 2027']);
  });

  it('refuses overlapping terms of a kind, backwards dates and a repeated name; a year may overlap a term', async () => {
    await expect(w.as('admin', (c) => createAcademicTerm(c, { name: 'Winter', kind: 'term', startDate: '2026-12-01', endDate: '2027-01-30' }))).rejects.toThrow(ConflictError);
    await expect(w.as('admin', (c) => createAcademicTerm(c, { name: 'Bad', kind: 'term', startDate: '2028-02-01', endDate: '2028-01-01' }))).rejects.toThrow(ValidationError);
    await expect(w.as('admin', (c) => createAcademicTerm(c, { name: 'fall 2026', kind: 'term', startDate: '2029-01-01', endDate: '2029-02-01' }))).rejects.toThrow(ValidationError);
    const terms = await w.as('admin', (c) => listAcademicTerms(c));
    const spring = terms.find((t) => t.name === 'Spring 2027')!;
    await expect(w.as('admin', (c) => updateAcademicTerm(c, spring.id, { startDate: '2026-12-10' }))).rejects.toThrow(ConflictError);
    // Switching a term off lets another take its dates.
    await w.as('admin', (c) => updateAcademicTerm(c, spring.id, { active: false }));
    const winter = await w.as('admin', (c) => createAcademicTerm(c, { name: 'Winter', kind: 'term', startDate: '2027-01-02', endDate: '2027-02-27' }));
    await expect(w.as('admin', (c) => updateAcademicTerm(c, spring.id, { active: true }))).rejects.toThrow(ConflictError);
    await w.as('admin', (c) => deleteAcademicTerm(c, winter.id));
    await w.as('admin', (c) => updateAcademicTerm(c, spring.id, { active: true }));
  });

  it('is reordered, renamed and deleted with Undo', async () => {
    const terms = await w.as('admin', (c) => listAcademicTerms(c));
    const order = [terms[4]!.id, ...terms.slice(0, 4).map((t) => t.id)];
    expect((await asU('admin', (c) => reorderAcademicTerms(c, { ids: order }))).map((t) => t.id)).toEqual(order);
    expect(lastUndo).toMatchObject({ method: 'POST', path: '/api/academic-terms/reorder', body: { ids: terms.map((t) => t.id) } });
    await expect(w.as('admin', (c) => reorderAcademicTerms(c, { ids: order.slice(1) }))).rejects.toThrow(ValidationError);
    await w.as('admin', (c) => reorderAcademicTerms(c, { ids: terms.map((t) => t.id) }));
    const renamed = await asU('admin', (c) => updateAcademicTerm(c, terms[0]!.id, { nameAr: null }));
    expect(renamed.nameAr).toBeNull();
    const extra = await w.as('admin', (c) => createAcademicTerm(c, { name: 'Summer 2027', kind: 'term', startDate: '2027-06-01', endDate: '2027-07-31' }));
    await asU('admin', (c) => deleteAcademicTerm(c, extra.id));
    expect(lastUndo).toMatchObject({ method: 'POST', path: '/api/academic-terms', body: { name: 'Summer 2027', kind: 'term', startDate: '2027-06-01', endDate: '2027-07-31' } });
  });
});

describe('course assessment: every semester, on an evidence item, for every program', () => {
  it('is set by QA only, on a template that fits the anchor', async () => {
    const input = { anchorKind: 'evidence_item' as const, anchorId: ids.evidence!, templateId: ids.tpl_course_assessment!, recurrence: { every: 1, unit: 'term' as const }, firstStart: '2026-08-01', appliesTo: { kinds: ['program' as const] } };
    await expect(w.as('contrib', (c) => setPlan(c, input))).rejects.toThrow(ForbiddenError);
    await expect(w.as('admin', (c) => setPlan(c, { ...input, templateId: ids.tpl_annual_program_report! }))).rejects.toThrow(ConflictError);   // does not fit an evidence item
    await expect(w.as('admin', (c) => setPlan(c, { ...input, anchorId: ids.other! }))).rejects.toThrow();
    const plan = await asU('admin', (c) => setPlan(c, input));
    expect(plan).toMatchObject({ mode: 'own', anchorName: 'Course results', templateName: 'Course assessment (every semester)', subjectCount: 3, active: true, canManage: true });
    expect(lastUndo).toMatchObject({ method: 'DELETE', path: `/api/cycle-plans/${plan.id}` });
    ids.coursePlan = plan.id;
  });

  it('proposes one run per program per term, the current term due and the next coming up', async () => {
    const r = await due();
    expect(summary(r)).toEqual([
      'Fall 2026|BS Civil', 'Fall 2026|BS Mechanical Engineering', 'Fall 2026|MS Civil',
      'Spring 2027|BS Civil', 'Spring 2027|BS Mechanical Engineering', 'Spring 2027|MS Civil',
    ]);
    expect(r.runs[0]).toMatchObject({ planId: ids.coursePlan, state: 'due', periodStart: '2026-08-24', periodEnd: '2026-12-18', anchorKind: 'evidence_item', anchorId: ids.evidence, subjectKind: 'program', canLaunch: true });
    expect(r.runs[3]).toMatchObject({ state: 'upcoming', periodStart: '2027-01-18' });
    expect(r.gaps).toEqual([]);
    expect(summary(await due({ state: 'upcoming' }))).toHaveLength(3);
    expect(summary(await due({ subjectId: ids.civil! }))).toEqual(['Fall 2026|BS Civil', 'Spring 2027|BS Civil']);
    expect(summary(await due({ templateId: ids.tpl_annual_program_report! }))).toEqual([]);
  });

  it('says where the calendar ends instead of guessing a term', async () => {
    const far = await due({ horizonDays: 800 });
    expect(far.runs.filter((x) => x.periodLabel === 'Fall 2027')).toHaveLength(3);
    expect(far.gaps).toEqual([expect.objectContaining({ planId: ids.coursePlan, from: '2027-12-18', reason: 'no_term' })]);
    const plans = await w.as('alo', (c) => listPlans(c, { today: TODAY }));
    expect(plans.find((p) => p.id === ids.coursePlan)).toMatchObject({ nextDue: '2026-08-24', nextLabel: 'Fall 2026', gap: { reason: 'no_term' } });
  });

  it('"Skip this period" records a reason and the run is not proposed again; it can be brought back', async () => {
    await expect(w.as('contrib', (c) => skipDueRun(c, { planId: ids.coursePlan!, subjectKind: 'program', subjectId: w.ids.mech!, periodStart: '2026-08-24', reason: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(w.as('admin', (c) => skipDueRun(c, { planId: ids.coursePlan!, subjectKind: 'program', subjectId: w.ids.mech!, periodStart: '2026-08-24', reason: '   ' }))).rejects.toThrow();
    await asU('admin', (c) => skipDueRun(c, { planId: ids.coursePlan!, subjectKind: 'program', subjectId: w.ids.mech!, periodStart: '2026-08-24', reason: 'Program is on sabbatical' }));
    expect(lastUndo).toMatchObject({ method: 'DELETE' });
    expect(summary(await due())).not.toContain('Fall 2026|BS Mechanical Engineering');
    expect(summary(await due())).toContain('Spring 2027|BS Mechanical Engineering');
    await expect(w.as('admin', (c) => skipDueRun(c, { planId: ids.coursePlan!, subjectKind: 'program', subjectId: w.ids.mech!, periodStart: '2026-08-24', reason: 'again' }))).rejects.toThrow(ConflictError);
    const row = (await w.db.su.query(`select id, reason from cycle_plan_skip`)).rows[0];
    expect(row.reason).toBe('Program is on sabbatical');
  });

  it('launching a proposed run sets plan, period and label, and finds the previous run of the same plan', async () => {
    const run = (await due()).runs.find((x) => x.periodLabel === 'Fall 2026' && x.subjectId === ids.civil)!;
    const launch = (r: typeof run, who = 'admin') => w.as(who, (c) => launchCycle(c, LaunchCycleSchema.parse({
      templateId: r.templateId, anchorKind: r.anchorKind, anchorId: r.anchorId, subjectKind: r.subjectKind, subjectId: r.subjectId, startDate: r.periodStart, periodLabel: r.periodLabel,
      planId: r.planId, periodStart: r.periodStart, ...(r.responsibleUnitId ? { responsibleUnitId: r.responsibleUnitId } : {}),
    })));
    const first = await launch(run);
    expect(first).toMatchObject({ planId: ids.coursePlan, periodLabel: 'Fall 2026', periodStart: '2026-08-24', previousCycleId: null, subjectId: ids.civil });
    expect(summary(await due())).not.toContain('Fall 2026|BS Civil');
    await expect(launch(run)).rejects.toThrow(ConflictError);   // the same period twice
    await w.as('admin', (c) => activateCycle(c, first.id));
    const spring = (await due()).runs.find((x) => x.periodLabel === 'Spring 2027' && x.subjectId === ids.civil)!;
    expect(spring.previousCycleId).toBe(first.id);
    const second = await launch(spring);
    expect(second).toMatchObject({ planId: ids.coursePlan, periodLabel: 'Spring 2027', previousCycleId: first.id });
    expect((await w.as('alo', (c) => getCycle(c, second.id))).planId).toBe(ids.coursePlan);
    // A cancelled run is proposed again; a plan that made runs cannot be removed.
    await expect(w.as('admin', (c) => clearPlan(c, ids.coursePlan!))).rejects.toThrow(ConflictError);
  });

  it('refuses a run for a plan with the wrong template, or without a period', async () => {
    const bad = (extra: Record<string, unknown>) => w.as('admin', (c) => launchCycle(c, LaunchCycleSchema.parse({
      anchorKind: 'evidence_item', anchorId: ids.evidence, subjectKind: 'program', subjectId: ids.msCivil, startDate: '2026-08-24', planId: ids.coursePlan, ...extra })));
    await expect(bad({ periodStart: '2026-08-24', templateId: ids.tpl_internal_audit })).rejects.toThrow(ValidationError);
    await expect(bad({})).rejects.toThrow(ValidationError);
  });
});

describe('the IQF annual report: every year, for every program', () => {
  it('a plan on the whole standard proposes one run per program per academic year, about the standard\'s published version', async () => {
    const plan = await w.as('admin', (c) => setPlan(c, {
      anchorKind: 'framework', frameworkId: ids.iqfFw!, templateId: ids.tpl_annual_program_report!, recurrence: { every: 1, unit: 'year' }, firstStart: '2026-08-01', appliesTo: { kinds: ['program'] },
    }));
    expect(plan).toMatchObject({ anchorKind: 'framework', subjectCount: 3, nextLabel: 'AY2026-27' });
    ids.iqfPlan = plan.id;
    const r = await due({ templateId: ids.tpl_annual_program_report! });
    expect(summary(r)).toEqual(['AY2026-27|BS Civil', 'AY2026-27|BS Mechanical Engineering', 'AY2026-27|MS Civil']);
    expect(r.runs[0]).toMatchObject({ anchorKind: 'framework_version', anchorId: ids.qv, subjectKind: 'program', state: 'due' });
    expect(summary(await due({ templateId: ids.tpl_annual_program_report!, horizonDays: 400 }))).toHaveLength(6);
  });

  it('is a plan per anchor and template: setting it again changes it', async () => {
    const again = await w.as('admin', (c) => setPlan(c, {
      anchorKind: 'framework', frameworkId: ids.iqfFw!, templateId: ids.tpl_annual_program_report!, recurrence: { every: 1, unit: 'year' }, firstStart: '2026-08-01', appliesTo: { kinds: ['program'], programLevels: ['bachelor'] },
    }));
    expect(again.id).toBe(ids.iqfPlan);
    expect(again.subjectCount).toBe(2);
    expect((await w.as('alo', (c) => listPlans(c, { today: TODAY }))).filter((p) => p.anchorKind === 'framework')).toHaveLength(1);
  });
});

describe('plans on a standard: scope, inheritance, mapped requirements, override and opt-out', () => {
  const planOn = (code: string, over: Record<string, unknown> = {}) => w.as('admin', (c) => setPlan(c, {
    anchorKind: 'requirement', frameworkId: ids.iqfFw!, code, templateId: ids.tpl_course_assessment!, recurrence: { every: 1, unit: 'term' }, firstStart: '2026-08-01', ...over,
  } as never));
  const nodeOf = async (versionId: string, code: string) => (await w.as('alo', (c) => loadPlanAssignments(c, versionId))).get(code)!;

  it('Standard Q1 every term runs for the programs in its scope, narrowed by applies_to', async () => {
    await w.as('admin', (c) => setRequirementScope(c, { frameworkId: ids.iqfFw!, code: 'Q1', levelKey: 'program', itemIds: [w.ids.mech!, ids.msCivil!] }));
    const plan = await planOn('Q1');
    expect(plan).toMatchObject({ anchorKind: 'requirement', code: 'Q1', anchorName: 'Q1 Teaching quality', subjectCount: 2 });
    ids.q1Plan = plan.id;
    const runs = (await due({ planId: plan.id })).runs;
    expect(runs.map((x) => `${x.periodLabel}|${x.subjectName}`)).toEqual([
      'Fall 2026|BS Mechanical Engineering', 'Fall 2026|MS Civil', 'Spring 2027|BS Mechanical Engineering', 'Spring 2027|MS Civil',
    ]);
    expect(runs[0]).toMatchObject({ anchorKind: 'requirement', anchorId: ids.q1 });
    const narrowed = await planOn('Q1', { appliesTo: { programLevels: ['master'] } });
    expect(narrowed.id).toBe(plan.id);
    expect(narrowed.subjectCount).toBe(1);
    expect((await due({ planId: plan.id })).runs.map((x) => x.subjectName)).toEqual(['MS Civil', 'MS Civil']);
    const outside = await planOn('Q1', { appliesTo: { ids: [ids.civil] } });
    expect(outside.subjectCount).toBe(0);   // BS Civil is not in the standard's scope
    await planOn('Q1', { appliesTo: {} });
  });

  it('sub-standards inherit the nearest ancestor\'s plan, labelled with where it is set', async () => {
    const q11 = await nodeOf(ids.qv!, 'Q1.1');
    expect(q11.own).toEqual([]);
    expect(q11.effective.filter((e) => e.templateId === ids.tpl_course_assessment)).toEqual([expect.objectContaining({ planId: ids.q1Plan, templateName: 'Course assessment (every semester)', source: { kind: 'parent', code: 'Q1' }, optedOut: false, recurrence: { every: 1, unit: 'term' } })]);
    // The whole-standard plan (annual report) reaches every node too.
    expect((await nodeOf(ids.qv!, 'Q1.1')).effective.map((e) => [e.templateName, e.source.kind])).toContainEqual(['Annual program report', 'framework']);
  });

  it('an own plan overrides; "Back to inherited" removes it', async () => {
    const own = await planOn('Q1.1', { recurrence: { every: 1, unit: 'year' } });
    const q11 = await nodeOf(ids.qv!, 'Q1.1');
    const course = q11.effective.find((e) => e.templateId === ids.tpl_course_assessment)!;
    expect(course).toMatchObject({ planId: own.id, source: { kind: 'own' }, recurrence: { every: 1, unit: 'year' } });
    expect(q11.inherited.find((e) => e.templateId === ids.tpl_course_assessment)).toMatchObject({ planId: ids.q1Plan, source: { kind: 'parent', code: 'Q1' } });
    await asU('admin', (c) => clearPlan(c, own.id));
    expect(lastUndo).toMatchObject({ method: 'PUT', path: '/api/cycle-plans', body: { anchorKind: 'requirement', code: 'Q1.1', templateId: ids.tpl_course_assessment, recurrence: { every: 1, unit: 'year' } } });
    expect((await nodeOf(ids.qv!, 'Q1.1')).effective.find((e) => e.templateId === ids.tpl_course_assessment)).toMatchObject({ planId: ids.q1Plan, source: { kind: 'parent', code: 'Q1' } });
  });

  it('an opt-out stops the template at that node', async () => {
    const out = await asU('admin', (c) => setPlan(c, { anchorKind: 'requirement', frameworkId: ids.iqfFw!, code: 'Q1.1', templateId: ids.tpl_course_assessment!, mode: 'opt_out' }));
    expect(out).toMatchObject({ mode: 'opt_out', recurrence: null, firstStart: null, nextDue: null, subjectCount: 0 });
    const q11 = await nodeOf(ids.qv!, 'Q1.1');
    expect(q11.effective.find((e) => e.templateId === ids.tpl_course_assessment)).toMatchObject({ planId: out.id, optedOut: true, source: { kind: 'own' } });
    expect((await nodeOf(ids.qv!, 'Q1.2')).effective.find((e) => e.templateId === ids.tpl_course_assessment)).toMatchObject({ planId: ids.q1Plan, optedOut: false });
    expect((await due({ planId: out.id })).runs).toEqual([]);   // an opt-out proposes nothing
    await w.as('admin', (c) => clearPlan(c, out.id));
  });

  it('an external requirement follows its approved mapped IQF node unless it has its own', async () => {
    const m = await w.as('alo', (c) => createMapping(c, w.ids.abet!, { externalRequirementId: ids.ext1!, internalRequirementId: ids.q12!, relation: 'covers', rationale: 'same ground' }));
    // A proposed mapping moves nothing.
    expect((await nodeOf(w.ids.abet!, ids.extCode1!)).effective.find((e) => e.templateId === ids.tpl_course_assessment)).toBeUndefined();
    await w.as('admin', (c) => reviewMapping(c, m.id, 'approved'));
    const e = (await nodeOf(w.ids.abet!, ids.extCode1!)).effective.find((x) => x.templateId === ids.tpl_course_assessment)!;
    expect(e).toMatchObject({ planId: ids.q1Plan, source: { kind: 'iqf', code: 'Q1.2' }, sourceCodes: ['Q1.2'], optedOut: false });
    // It can have its own, which overrides; and opt out.
    const mine = await w.as('admin', (c) => setPlan(c, { anchorKind: 'requirement', frameworkId: ids.abetFw!, code: ids.extCode1!, templateId: ids.tpl_course_assessment!, recurrence: { every: 1, unit: 'year' }, firstStart: '2026-09-01' }));
    const withOwn = await nodeOf(w.ids.abet!, ids.extCode1!);
    expect(withOwn.effective.find((x) => x.templateId === ids.tpl_course_assessment)).toMatchObject({ planId: mine.id, source: { kind: 'own' } });
    expect(withOwn.inherited.find((x) => x.templateId === ids.tpl_course_assessment)).toMatchObject({ planId: ids.q1Plan, source: { kind: 'iqf', code: 'Q1.2' } });
    await w.as('admin', (c) => clearPlan(c, mine.id));
    expect((await nodeOf(w.ids.abet!, ids.extCode1!)).effective.find((x) => x.templateId === ids.tpl_course_assessment)).toMatchObject({ planId: ids.q1Plan });
    // The IQF node opting out reaches the external requirement it maps to.
    const iqfOut = await w.as('admin', (c) => setPlan(c, { anchorKind: 'requirement', frameworkId: ids.iqfFw!, code: 'Q1.2', templateId: ids.tpl_course_assessment!, mode: 'opt_out' }));
    expect((await nodeOf(w.ids.abet!, ids.extCode1!)).effective.find((x) => x.templateId === ids.tpl_course_assessment)).toMatchObject({ optedOut: true });
    await w.as('admin', (c) => clearPlan(c, iqfOut.id));
  });

  it('the batched requirement context and the dialog carry the plans (own, effective, inherited)', async () => {
    const ctxs = await w.as('alo', (c) => requirementContexts(c, ids.qv!));
    expect(ctxs.byCode.Q1!.plans!.own.map((p) => p.templateName)).toEqual(['Course assessment (every semester)']);
    expect(ctxs.byCode['Q1.2']!.plans!.effective.map((e) => e.source.kind).sort()).toEqual(['framework', 'parent']);
    const ext = await w.as('alo', (c) => requirementContexts(c, w.ids.abet!));
    expect(ext.byCode[ids.extCode1!]!.plans!.effective.find((e) => e.templateId === ids.tpl_course_assessment)!.source).toEqual({ kind: 'iqf', code: 'Q1.2' });
    const target = await w.as('alo', (c) => getTargetPlans(c, { anchorKind: 'requirement', frameworkId: ids.abetFw!, code: ids.extCode1! }));
    expect(target.own).toEqual([]);
    expect(target.effective.length).toBeGreaterThan(0);
  });
});

describe('a date set by a decision', () => {
  it('proposes the first run, then waits for a person to set the next date', async () => {
    const plan = await w.as('admin', (c) => setPlan(c, {
      anchorKind: 'org_unit', anchorId: ids.unit!, templateId: ids.tpl_internal_audit!, recurrence: { after: 'previous_ends', setBy: 'decision' }, firstStart: '2026-09-01', responsibleUnitId: ids.unit!, ownerUserId: w.ids.coord!,
    }));
    expect(plan).toMatchObject({ subjectCount: 1, nextDue: '2026-09-01', nextLabel: '2026', waitingForDate: false, anchorName: 'Engineering', ownerName: 'coord' });
    const run = (await due({ planId: plan.id })).runs[0]!;
    expect(run).toMatchObject({ anchorKind: 'org_unit', anchorId: ids.unit, subjectKind: null, subjectId: null, subjectName: 'Engineering', ownerName: 'coord', responsibleUnitName: 'Engineering', state: 'due' });
    const made = await w.as('admin', (c) => launchCycle(c, LaunchCycleSchema.parse({
      templateId: run.templateId, anchorKind: run.anchorKind, anchorId: run.anchorId, startDate: run.periodStart, periodLabel: run.periodLabel, planId: run.planId, periodStart: run.periodStart, responsibleUnitId: run.responsibleUnitId, leadUserId: run.ownerUserId,
    })));
    expect(made).toMatchObject({ planId: plan.id, periodLabel: '2026', leadUserId: w.ids.coord });
    expect((await due({ planId: plan.id })).runs).toEqual([]);
    expect((await w.as('alo', (c) => listPlans(c, { today: TODAY }))).find((p) => p.id === plan.id)).toMatchObject({ waitingForDate: true, nextDue: null });
    expect((await due({ planId: plan.id })).gaps).toEqual([expect.objectContaining({ reason: 'no_date' })]);
  });

  it('takes the date a decision fixes, once, after the last one', async () => {
    const plan = (await w.as('alo', (c) => listPlans(c))).find((p) => p.recurrence && 'after' in p.recurrence)!;
    await expect(w.as('contrib', (c) => setNextDate(c, plan.id, '2027-03-01'))).rejects.toThrow(ForbiddenError);
    await expect(w.as('admin', (c) => setNextDate(c, plan.id, '2026-09-01'))).rejects.toThrow(ValidationError);
    await expect(w.as('admin', (c) => setNextDate(c, ids.coursePlan!, '2030-01-01'))).rejects.toThrow(ConflictError);
    const set = await w.as('admin', (c) => setNextDate(c, plan.id, '2027-03-01'));
    expect(set.recurrence).toEqual({ after: 'previous_ends', setBy: 'decision', dates: ['2027-03-01'] });
    expect(set).toMatchObject({ nextDue: '2027-03-01', nextLabel: '2027', waitingForDate: false });
    expect((await due({ planId: plan.id })).runs.map((r) => [r.periodLabel, r.state])).toEqual([['2027', 'upcoming']]);
  });
});

describe('who can see and change what', () => {
  it('everyone who can read cycles sees plans and proposed runs; only QA changes them', async () => {
    const plans = await w.as('contrib', (c) => listPlans(c, { today: TODAY }));
    expect(plans.length).toBeGreaterThan(3);
    expect(plans.every((p) => p.canManage === false)).toBe(true);
    expect((await w.as('contrib', (c) => listDueRuns(c, {}, { today: TODAY }))).runs.every((r) => r.canLaunch === false || r.responsibleUnitId === null)).toBe(true);
    await expect(w.as('contrib', (c) => clearPlan(c, ids.q1Plan!))).rejects.toThrow(ForbiddenError);
  });

  it('plans of another institution are invisible', async () => {
    const theirs = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'theirs', 'theirs@x.org') returning id`, [ids.other]);
    const caller = { userId: theirs, institutionId: ids.other!, requestId: crypto.randomUUID(), actorType: 'user' as const };
    await w.db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.other, theirs]);
    const list = await withIdentity(w.pool, caller, (tx) => listPlans({ tx, caller, queue: { send: async () => undefined }, afterCommit: () => undefined, store: w.store, undo: () => undefined }));
    expect(list).toEqual([]);
  });
});
