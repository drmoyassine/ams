// Assessment of learning (TASK-114..117; docs/assessment-of-learning-plan.md 2-6): the IE-001 plan per program and year, course
// attainment by the QAIEO method, results for CLOs and PLOs with their standing against the target, corrective actions, and the
// ILO rotation with the institutional report. Aggregates only: nothing student-level is stored (BI rule 5). Program rows need
// program:write on the program; course assessments program:write at the course's unit; institution settings org:write.
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  assessmentPlan, assessmentPlanItem, correctiveAction, course, courseAssessment, courseAssessmentPart, courseProgram, iloSchedule, institution,
  learningOutcome, outcomeLink, outcomeResult, program,
} from '@ams/db';
import {
  AssessmentBenchmarksSchema, computeAttainment, standingOf, type AssessmentBenchmarks, type AssessmentPlan, type Attainment, type CorrectiveAction,
  type CourseAssessment, type IloReport, type IloScheduleRow, type ImportResultRow, type OutcomeResult, type ProgramAssessment, type SaveAction,
  type SaveCourseAssessment, type SaveIloSchedule, type SavePlanItem, type SaveResult, type UpdatePlan,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted, isPermitted } from '../permissions.js';
import { courseScope, loadCourse } from './courses.js';
import { getOutcomeLevels } from './outcomes.js';

const num = (v: string | null) => (v === null ? null : Number(v));
const str = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));
const clean = (s: string | null | undefined) => (s === undefined ? undefined : s ? s.normalize('NFC').trim() || null : null);
const today = () => new Date().toISOString().slice(0, 10);
const fold = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const ATTAINMENT_SOURCE = 'Course attainment (QAIEO method)';

// ---- Benchmarks ---------------------------------------------------------------------------------------------------------------

export async function getBenchmarks(ctx: Ctx): Promise<AssessmentBenchmarks> {
  const [row] = await ctx.tx.select({ b: institution.assessmentBenchmarks }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  return AssessmentBenchmarksSchema.parse(row?.b ?? {});
}
export async function setBenchmarks(ctx: Ctx, input: AssessmentBenchmarks): Promise<AssessmentBenchmarks> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'org:write', { type: 'institution' });
  const b = AssessmentBenchmarksSchema.parse(input);
  await ctx.tx.update(institution).set({ assessmentBenchmarks: b }).where(eq(institution.id, ctx.caller.institutionId));
  return b;
}

// ---- Plan (TASK-114) ---------------------------------------------------------------------------------------------------------

async function programRow(ctx: Ctx, id: string) {
  const [p] = await ctx.tx.select().from(program).where(eq(program.id, id));
  if (!p) throw new NotFoundError(`program ${id}`);
  return p;
}
async function planRow(ctx: Ctx, id: string) {
  const [p] = await ctx.tx.select().from(assessmentPlan).where(eq(assessmentPlan.id, id));
  if (!p) throw new NotFoundError(`plan ${id}`);
  return p;
}
const activePlos = async (ctx: Ctx, programId: string) =>
  (await ctx.tx.select().from(learningOutcome).where(and(eq(learningOutcome.programId, programId), eq(learningOutcome.kind, 'plo'))))
    .filter((o) => o.status !== 'retired').sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code, 'en', { numeric: true }));

/** Creates the plan of a year with a row per PLO (copying the rows of another year's plan when asked). */
export async function createPlan(ctx: Ctx, programId: string, input: { academicYear: string; copyFrom?: string | null }): Promise<AssessmentPlan> {
  assertHuman(ctx);
  await programRow(ctx, programId);
  await assertPermitted(ctx, 'program:write', { type: 'program', id: programId });
  const [plan] = await guardIntegrity(() => ctx.tx.insert(assessmentPlan).values({ institutionId: ctx.caller.institutionId, programId, academicYear: input.academicYear }).returning())
    .catch((e: Error) => { if (/assessment_plan_idx|integrity|duplicate/.test(e.message)) throw new ConflictError(`there is already a plan for ${input.academicYear}`); throw e; });
  const from = input.copyFrom
    ? (await ctx.tx.select().from(assessmentPlan).where(and(eq(assessmentPlan.programId, programId), eq(assessmentPlan.academicYear, input.copyFrom))))[0] : undefined;
  const old = from ? await ctx.tx.select().from(assessmentPlanItem).where(eq(assessmentPlanItem.planId, from.id)) : [];
  const plos = await activePlos(ctx, programId);
  if (plos.length) {
    await ctx.tx.insert(assessmentPlanItem).values(plos.map((p) => {
      const o = old.find((x) => x.ploId === p.id);
      const { id: _i, createdAt: _c, createdBy: _cb, updatedAt: _u, updatedBy: _ub, planId: _p, ...copy } = o ?? ({} as typeof assessmentPlanItem.$inferSelect);
      return { ...(o ? copy : {}), institutionId: ctx.caller.institutionId, planId: plan!.id, ploId: p.id };
    }));
  }
  return getPlan(ctx, plan!.id);
}

export async function getPlan(ctx: Ctx, planId: string): Promise<AssessmentPlan> {
  const plan = await planRow(ctx, planId);
  await assertPermitted(ctx, 'program:read', { type: 'program', id: plan.programId });
  const items = await ctx.tx.select().from(assessmentPlanItem).where(eq(assessmentPlanItem.planId, planId));
  const plos = await activePlos(ctx, plan.programId);
  const order = new Map(plos.map((p, i) => [p.id, i]));
  items.sort((a, b) => (order.get(a.ploId) ?? 999) - (order.get(b.ploId) ?? 999));
  const bench = await getBenchmarks(ctx);
  const issues: AssessmentPlan['issues'] = [];
  // Mastery: the direct course should reach the PLO at the mastery level (the curriculum map).
  const mastery = (await getOutcomeLevels(ctx)).find((l) => l.mastery)?.code ?? null;
  const links = plos.length ? await ctx.tx.select({ fromId: outcomeLink.fromId, toId: outcomeLink.toId, level: outcomeLink.level, courseId: learningOutcome.courseId })
    .from(outcomeLink).innerJoin(learningOutcome, eq(learningOutcome.id, outcomeLink.fromId)).where(inArray(outcomeLink.toId, plos.map((p) => p.id))) : [];
  const courses = new Map((await ctx.tx.select({ id: course.id, code: course.code }).from(course)).map((c) => [c.id, c.code]));
  for (const p of plos) {
    const it = items.find((i) => i.ploId === p.id);
    if (!it) { issues.push({ ploId: p.id, message: `${p.code} is not in the plan` }); continue; }
    if (!it.directMethod || !it.directCourseId) issues.push({ ploId: p.id, message: `${p.code} has no direct measure in a course` });
    else if (mastery && !links.some((l) => l.toId === p.id && l.courseId === it.directCourseId && l.level === mastery)) {
      issues.push({ ploId: p.id, message: `${courses.get(it.directCourseId) ?? 'The direct course'} does not reach ${p.code} at the mastery level (${mastery}) on the curriculum map` });
    }
    if (!it.indirectMethod) issues.push({ ploId: p.id, message: `${p.code} has no indirect measure` });
    if (it.targetShare === null && it.targetScore === null && bench.ploShare === undefined && bench.ploScore === undefined) issues.push({ ploId: p.id, message: `${p.code} has no target (set one here or the institution's PLO target)` });
    if (!it.assessIn) issues.push({ ploId: p.id, message: `${p.code} has no assessment term (each PLO is assessed directly at least every two years)` });
  }
  return {
    id: plan.id, programId: plan.programId, academicYear: plan.academicYear, status: plan.status, coordinator: plan.coordinator, endorsedBy: plan.endorsedBy,
    submittedOn: plan.submittedOn, endorsedOn: plan.endorsedOn, notes: plan.notes, issues,
    items: items.map((i) => ({
      id: i.id, ploId: i.ploId, assessIn: i.assessIn, directCourseId: i.directCourseId, directMethod: i.directMethod, directRubric: i.directRubric, indirectMethod: i.indirectMethod,
      indirectFrequency: i.indirectFrequency, indirectRespondents: i.indirectRespondents, targetScore: num(i.targetScore), targetShare: num(i.targetShare), benchmark: i.benchmark,
      responsible: i.responsible, collectionWindow: i.collectionWindow, submitBy: i.submitBy, reassessIn: i.reassessIn,
    })),
  };
}

/** Status: draft -> submitted (by the coordinator) -> endorsed (by the dean) or returned; dates are kept. */
export async function updatePlan(ctx: Ctx, planId: string, patch: UpdatePlan): Promise<AssessmentPlan> {
  assertHuman(ctx);
  const plan = await planRow(ctx, planId);
  await assertPermitted(ctx, 'program:write', { type: 'program', id: plan.programId });
  const set: Partial<typeof assessmentPlan.$inferInsert> = {};
  for (const k of ['coordinator', 'endorsedBy', 'notes'] as const) if (patch[k] !== undefined) set[k] = clean(patch[k]) ?? null;
  if (patch.status && patch.status !== plan.status) {
    set.status = patch.status;
    if (patch.status === 'submitted') set.submittedOn = today();
    if (patch.status === 'endorsed') set.endorsedOn = today();
  }
  if (Object.keys(set).length) await ctx.tx.update(assessmentPlan).set(set).where(eq(assessmentPlan.id, planId));
  return getPlan(ctx, planId);
}

export async function savePlanItem(ctx: Ctx, itemId: string, patch: SavePlanItem): Promise<AssessmentPlan> {
  assertHuman(ctx);
  const [item] = await ctx.tx.select().from(assessmentPlanItem).where(eq(assessmentPlanItem.id, itemId));
  if (!item) throw new NotFoundError(`plan item ${itemId}`);
  const plan = await planRow(ctx, item.planId);
  await assertPermitted(ctx, 'program:write', { type: 'program', id: plan.programId });
  if (plan.status === 'endorsed') throw new ConflictError('an endorsed plan is fixed; start the next year\'s plan to change it');
  const set: Partial<typeof assessmentPlanItem.$inferInsert> = {};
  for (const k of ['assessIn', 'directMethod', 'directRubric', 'indirectMethod', 'indirectFrequency', 'indirectRespondents', 'benchmark', 'responsible', 'collectionWindow', 'reassessIn'] as const) {
    if (patch[k] !== undefined) set[k] = clean(patch[k]) ?? null;
  }
  if (patch.directCourseId !== undefined) {
    if (patch.directCourseId) {
      const [cp] = await ctx.tx.select().from(courseProgram).where(and(eq(courseProgram.courseId, patch.directCourseId), eq(courseProgram.programId, plan.programId)));
      if (!cp) throw new ValidationError('the direct course is not part of this program');
    }
    set.directCourseId = patch.directCourseId ?? null;
  }
  if (patch.targetScore !== undefined) set.targetScore = str(patch.targetScore);
  if (patch.targetShare !== undefined) set.targetShare = str(patch.targetShare);
  if (patch.submitBy !== undefined) set.submitBy = patch.submitBy ?? null;
  if (Object.keys(set).length) await ctx.tx.update(assessmentPlanItem).set(set).where(eq(assessmentPlanItem.id, itemId));
  return getPlan(ctx, plan.id);
}

// ---- Course assessments and attainment (TASK-115) ----------------------------------------------------------------------------

export async function listCourseAssessments(ctx: Ctx, courseId: string, term?: string): Promise<CourseAssessment[]> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const rows = await ctx.tx.select().from(courseAssessment).where(term ? and(eq(courseAssessment.courseId, courseId), eq(courseAssessment.term, term)) : eq(courseAssessment.courseId, courseId))
    .orderBy(asc(courseAssessment.term), asc(courseAssessment.displayOrder), asc(courseAssessment.createdAt));
  const parts = rows.length ? await ctx.tx.select().from(courseAssessmentPart).where(inArray(courseAssessmentPart.assessmentId, rows.map((r) => r.id))).orderBy(asc(courseAssessmentPart.displayOrder)) : [];
  return rows.map((r) => ({
    id: r.id, courseId: r.courseId, term: r.term, name: r.name, totalMarks: Number(r.totalMarks), classAverage: num(r.classAverage), students: r.students,
    parts: parts.filter((p) => p.assessmentId === r.id).map((p) => ({ id: p.id, label: p.label, marks: Number(p.marks), cloIds: p.cloIds })),
  }));
}

/** Adds an assessment, or replaces one (with its parts). Parts must add up to the total and name CLOs of this course. */
export async function saveCourseAssessment(ctx: Ctx, courseId: string, input: SaveCourseAssessment, id?: string): Promise<CourseAssessment[]> {
  assertHuman(ctx);
  const c = await loadCourse(ctx, courseId);
  await assertPermitted(ctx, 'program:write', courseScope(c.orgUnitId));
  const clos = new Set((await ctx.tx.select({ id: learningOutcome.id }).from(learningOutcome).where(eq(learningOutcome.courseId, courseId))).map((r) => r.id));
  if (input.parts.some((p) => p.cloIds.some((x) => !clos.has(x)))) throw new ValidationError('a part names a CLO of another course');
  const sum = input.parts.reduce((s, p) => s + p.marks, 0);
  if (input.parts.length && Math.abs(sum - input.totalMarks) > 0.01) throw new ValidationError(`the parts add up to ${sum}, not the total of ${input.totalMarks}`);
  if (input.classAverage !== null && input.classAverage !== undefined && input.classAverage > input.totalMarks) throw new ValidationError('the class average is above the total');
  const values = { term: input.term.trim(), name: input.name.trim(), totalMarks: String(input.totalMarks), classAverage: str(input.classAverage), students: input.students ?? null };
  let aid = id;
  if (aid) {
    const [cur] = await ctx.tx.select().from(courseAssessment).where(and(eq(courseAssessment.id, aid), eq(courseAssessment.courseId, courseId)));
    if (!cur) throw new NotFoundError(`assessment ${aid}`);
    await ctx.tx.update(courseAssessment).set(values).where(eq(courseAssessment.id, aid));
    await ctx.tx.delete(courseAssessmentPart).where(eq(courseAssessmentPart.assessmentId, aid));
  } else {
    const n = (await ctx.tx.select({ id: courseAssessment.id }).from(courseAssessment).where(and(eq(courseAssessment.courseId, courseId), eq(courseAssessment.term, values.term)))).length;
    aid = (await ctx.tx.insert(courseAssessment).values({ ...values, institutionId: ctx.caller.institutionId, courseId, displayOrder: n }).returning())[0]!.id;
  }
  if (input.parts.length) {
    await ctx.tx.insert(courseAssessmentPart).values(input.parts.map((p, i) => ({ institutionId: ctx.caller.institutionId, assessmentId: aid!, label: p.label, marks: String(p.marks), cloIds: [...new Set(p.cloIds)], displayOrder: i })));
  }
  return listCourseAssessments(ctx, courseId, values.term);
}

export async function deleteCourseAssessment(ctx: Ctx, courseId: string, id: string): Promise<{ deleted: boolean }> {
  assertHuman(ctx);
  const c = await loadCourse(ctx, courseId);
  await assertPermitted(ctx, 'program:write', courseScope(c.orgUnitId));
  const gone = await ctx.tx.delete(courseAssessment).where(and(eq(courseAssessment.id, id), eq(courseAssessment.courseId, courseId))).returning({ id: courseAssessment.id });
  return { deleted: gone.length > 0 };
}

export interface CourseAttainment extends Attainment {
  courseId: string; term: string;
  /** Roll-up through the CLO-PLO links: per PLO (of each program the course serves) the marks possible, achieved and attainment. */
  plos: { ploId: string; code: string; programId: string; possible: number; achieved: number; attainment: number | null }[];
}
export async function getCourseAttainment(ctx: Ctx, courseId: string, term: string): Promise<CourseAttainment> {
  const list = await listCourseAssessments(ctx, courseId, term);
  const a = computeAttainment(list);
  const cloIds = a.clos.map((c) => c.cloId);
  const links = cloIds.length ? await ctx.tx.select({ fromId: outcomeLink.fromId, toId: outcomeLink.toId, code: learningOutcome.code, programId: learningOutcome.programId })
    .from(outcomeLink).innerJoin(learningOutcome, eq(learningOutcome.id, outcomeLink.toId)).where(inArray(outcomeLink.fromId, cloIds)) : [];
  const by = new Map<string, { ploId: string; code: string; programId: string; possible: number; achieved: number }>();
  for (const l of links) {
    const c = a.clos.find((x) => x.cloId === l.fromId)!;
    const cur = by.get(l.toId) ?? { ploId: l.toId, code: l.code, programId: l.programId!, possible: 0, achieved: 0 };
    cur.possible += c.possible; cur.achieved += c.achieved; by.set(l.toId, cur);
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { ...a, courseId, term, plos: [...by.values()].map((p) => ({ ...p, possible: r2(p.possible), achieved: r2(p.achieved), attainment: p.possible ? r2((p.achieved / p.possible) * 100) : null })) };
}

/** Records the attainment of a course offering as direct results (CLOs and the PLOs they roll up to). Re-recording replaces them. */
export async function recordCourseAttainment(ctx: Ctx, courseId: string, term: string): Promise<{ recorded: number }> {
  assertHuman(ctx);
  const c = await loadCourse(ctx, courseId);
  await assertPermitted(ctx, 'program:write', courseScope(c.orgUnitId));
  const a = await getCourseAttainment(ctx, courseId, term);
  if (!a.clos.length) throw new ConflictError('no assessment of this offering has marks on CLOs and a class average');
  const ids = [...a.clos.map((x) => x.cloId), ...a.plos.map((p) => p.ploId)];
  await ctx.tx.delete(outcomeResult).where(and(inArray(outcomeResult.outcomeId, ids), eq(outcomeResult.courseId, courseId), eq(outcomeResult.term, term), eq(outcomeResult.source, ATTAINMENT_SOURCE)));
  const students = Math.max(0, ...(await listCourseAssessments(ctx, courseId, term)).map((x) => x.students ?? 0)) || null;
  const rows = [...a.clos.map((x) => ({ outcomeId: x.cloId, attainment: x.attainment })), ...a.plos.map((p) => ({ outcomeId: p.ploId, attainment: p.attainment }))]
    .filter((r) => r.attainment !== null)
    .map((r) => ({ institutionId: ctx.caller.institutionId, outcomeId: r.outcomeId, courseId, term, kind: 'direct' as const, method: 'Class average by CLO marks',
      sampleSize: students, meanScore: String(r.attainment), scaleMax: '100', source: ATTAINMENT_SOURCE }));
  if (rows.length) await ctx.tx.insert(outcomeResult).values(rows);
  return { recorded: rows.length };
}

// ---- Results (TASK-115) -----------------------------------------------------------------------------------------------------

type ResultRow = typeof outcomeResult.$inferSelect;
async function assertOutcomeWritable(ctx: Ctx, outcomeId: string) {
  const [o] = await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.id, outcomeId));
  if (!o) throw new NotFoundError(`outcome ${outcomeId}`);
  if (o.kind === 'clo') {
    // A CLO's results are written by the course's owners, or by a writer of any program the course serves.
    const programs = (await ctx.tx.select({ id: courseProgram.programId }).from(courseProgram).where(eq(courseProgram.courseId, o.courseId!))).map((r) => r.id);
    for (const id of programs) if (await isPermitted(ctx.tx, 'program:write', { type: 'program', id })) return o;
    await assertPermitted(ctx, 'program:write', courseScope((await loadCourse(ctx, o.courseId!)).orgUnitId));
  }
  else if (o.programId) await assertPermitted(ctx, 'program:write', { type: 'program', id: o.programId });
  else await assertPermitted(ctx, 'org:write', { type: 'institution' });
  return o;
}

export async function addResult(ctx: Ctx, input: SaveResult): Promise<{ id: string }> {
  assertHuman(ctx);
  await assertOutcomeWritable(ctx, input.outcomeId);
  if (input.studentsAtTarget !== null && input.studentsAtTarget !== undefined && input.sampleSize !== null && input.sampleSize !== undefined && input.studentsAtTarget > input.sampleSize) {
    throw new ValidationError('more students at target than in the sample');
  }
  const [row] = await guardIntegrity(() => ctx.tx.insert(outcomeResult).values({
    institutionId: ctx.caller.institutionId, outcomeId: input.outcomeId, courseId: input.courseId ?? null, term: input.term.trim(), kind: input.kind,
    method: clean(input.method) ?? null, sampleSize: input.sampleSize ?? null, studentsAtTarget: input.studentsAtTarget ?? null, shareAtTarget: str(input.shareAtTarget),
    meanScore: str(input.meanScore), scaleMax: str(input.scaleMax), responseRate: str(input.responseRate), source: clean(input.source) ?? null, notes: clean(input.notes) ?? null,
  }).returning({ id: outcomeResult.id }));
  return row!;
}

export async function deleteResult(ctx: Ctx, id: string): Promise<{ deleted: boolean }> {
  assertHuman(ctx);
  const [r] = await ctx.tx.select().from(outcomeResult).where(eq(outcomeResult.id, id));
  if (!r) throw new NotFoundError(`result ${id}`);
  await assertOutcomeWritable(ctx, r.outcomeId);
  await ctx.tx.delete(outcomeResult).where(eq(outcomeResult.id, id));
  return { deleted: true };
}

/** Targets per outcome: the latest plan item's (PLOs) or the institution's. */
async function targetsFor(ctx: Ctx, programId: string, bench: AssessmentBenchmarks) {
  const plans = await ctx.tx.select().from(assessmentPlan).where(eq(assessmentPlan.programId, programId)).orderBy(desc(assessmentPlan.academicYear));
  const items = plans.length ? await ctx.tx.select().from(assessmentPlanItem).where(inArray(assessmentPlanItem.planId, plans.map((p) => p.id))) : [];
  return (o: { id: string; kind: string }) => {
    const it = plans.map((p) => items.find((i) => i.planId === p.id && i.ploId === o.id)).find((i) => i && (i.targetShare !== null || i.targetScore !== null));
    const isClo = o.kind === 'clo';
    return {
      score: it ? num(it.targetScore) : (isClo ? bench.cloScore : bench.ploScore) ?? null,
      share: it ? num(it.targetShare) : (isClo ? bench.cloShare : bench.ploShare) ?? null,
      indirectScore: bench.indirectScore ?? null,
    };
  };
}

function toResult(r: ResultRow, target: ReturnType<Awaited<ReturnType<typeof targetsFor>>>): OutcomeResult {
  const base = {
    id: r.id, outcomeId: r.outcomeId, courseId: r.courseId, term: r.term, kind: r.kind, method: r.method, sampleSize: r.sampleSize, studentsAtTarget: r.studentsAtTarget,
    shareAtTarget: num(r.shareAtTarget), meanScore: num(r.meanScore), scaleMax: num(r.scaleMax), responseRate: num(r.responseRate), source: r.source, notes: r.notes, createdAt: r.createdAt.toISOString(),
  };
  return { ...base, ...standingOf(base, target) };
}

/** A program's assessment: benchmarks, plans, results of its PLOs and its courses' CLOs, corrective actions, gaps without an action. */
export async function getProgramAssessment(ctx: Ctx, programId: string): Promise<ProgramAssessment> {
  await assertPermitted(ctx, 'program:read', { type: 'program', id: programId });
  await programRow(ctx, programId);
  const bench = await getBenchmarks(ctx);
  const plans = await ctx.tx.select().from(assessmentPlan).where(eq(assessmentPlan.programId, programId)).orderBy(desc(assessmentPlan.academicYear));
  const courseIds = (await ctx.tx.select({ id: courseProgram.courseId }).from(courseProgram).where(eq(courseProgram.programId, programId))).map((r) => r.id);
  const outcomes = await ctx.tx.select({ id: learningOutcome.id, kind: learningOutcome.kind }).from(learningOutcome).where(
    courseIds.length ? inArray(learningOutcome.courseId, courseIds) : eq(learningOutcome.programId, programId));
  const own = await ctx.tx.select({ id: learningOutcome.id, kind: learningOutcome.kind }).from(learningOutcome).where(and(eq(learningOutcome.programId, programId), eq(learningOutcome.kind, 'plo')));
  const all = [...own, ...outcomes.filter((o) => o.kind === 'clo')];
  const kindOf = new Map(all.map((o) => [o.id, o.kind]));
  const target = await targetsFor(ctx, programId, bench);
  const rows = all.length ? await ctx.tx.select().from(outcomeResult).where(inArray(outcomeResult.outcomeId, all.map((o) => o.id))).orderBy(desc(outcomeResult.term), desc(outcomeResult.createdAt)) : [];
  const results = rows.map((r) => toResult(r, target({ id: r.outcomeId, kind: kindOf.get(r.outcomeId) ?? 'plo' })));
  const actions = (await ctx.tx.select().from(correctiveAction).where(eq(correctiveAction.programId, programId)).orderBy(desc(correctiveAction.createdAt))).map(toAction);
  const handled = new Set(actions.map((a) => a.resultId).filter(Boolean));
  const openGaps = results.filter((r) => r.standing === 'below' && kindOf.get(r.outcomeId) === 'plo' && !handled.has(r.id)).map((r) => ({ resultId: r.id, outcomeId: r.outcomeId, term: r.term }));
  return { benchmarks: bench, plans: plans.map((p) => ({ id: p.id, academicYear: p.academicYear, status: p.status })), results, actions, openGaps };
}

/**
 * Imports results rows (a course report or survey sheet) for a program: the outcome by its code, a PLO of the program ("SO2") or a CLO
 * as "<course code> <CLO code>". With apply false nothing changes; rows that do not resolve are listed.
 */
export async function importResults(ctx: Ctx, programId: string, rows: ImportResultRow[], opts: { apply: boolean; source: string }): Promise<{ added: number; skipped: { row: string; reason: string }[] }> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', { type: 'program', id: programId });
  const plos = await ctx.tx.select().from(learningOutcome).where(and(eq(learningOutcome.programId, programId), eq(learningOutcome.kind, 'plo')));
  const cps = await ctx.tx.select({ c: course }).from(courseProgram).innerJoin(course, eq(course.id, courseProgram.courseId)).where(eq(courseProgram.programId, programId));
  const clos = cps.length ? await ctx.tx.select().from(learningOutcome).where(inArray(learningOutcome.courseId, cps.map((r) => r.c.id))) : [];
  const skipped: { row: string; reason: string }[] = [];
  let added = 0;
  for (const r of rows) {
    const label = `${r.outcome} ${r.term}`;
    let outcomeId: string | undefined; let courseId: string | null = null;
    const plo = plos.find((p) => fold(p.code) === fold(r.outcome));
    if (plo) outcomeId = plo.id;
    else {
      const c = cps.map((x) => x.c).sort((a, b) => b.code.length - a.code.length).find((x) => fold(r.outcome).startsWith(fold(x.code) + ' ') || (r.course && fold(r.course) === fold(x.code)));
      const code = c ? (fold(r.outcome).startsWith(fold(c.code) + ' ') ? fold(r.outcome).slice(fold(c.code).length + 1) : fold(r.outcome)) : '';
      const clo = c ? clos.find((o) => o.courseId === c.id && fold(o.code) === code) : undefined;
      if (clo) { outcomeId = clo.id; courseId = c!.id; }
    }
    if (!outcomeId) { skipped.push({ row: label, reason: 'no PLO of this program, or CLO of its courses, with that code' }); continue; }
    if (r.course && !courseId) courseId = cps.find((x) => fold(x.c.code) === fold(r.course))?.c.id ?? null;
    if (opts.apply) {
      await addResult(ctx, {
        outcomeId, courseId, term: r.term, kind: r.kind, method: r.method ?? null, sampleSize: r.sampleSize ?? null, studentsAtTarget: r.studentsAtTarget ?? null,
        shareAtTarget: r.shareAtTarget ?? null, meanScore: r.meanScore ?? null, scaleMax: r.scaleMax ?? null, responseRate: r.responseRate ?? null, source: opts.source,
      });
    }
    added++;
  }
  return { added, skipped };
}

// ---- Corrective actions (TASK-116) ------------------------------------------------------------------------------------------

const toAction = (a: typeof correctiveAction.$inferSelect): CorrectiveAction => ({
  id: a.id, programId: a.programId, outcomeId: a.outcomeId, resultId: a.resultId, gap: a.gap, rootCause: a.rootCause, action: a.action, owner: a.owner,
  implementIn: a.implementIn, verificationPlan: a.verificationPlan, status: a.status, verifiedResultId: a.verifiedResultId, verificationNote: a.verificationNote, createdAt: a.createdAt.toISOString(),
});

export async function addAction(ctx: Ctx, programId: string, input: SaveAction): Promise<CorrectiveAction> {
  assertHuman(ctx);
  await programRow(ctx, programId);
  await assertPermitted(ctx, 'program:write', { type: 'program', id: programId });
  const [row] = await ctx.tx.insert(correctiveAction).values({
    institutionId: ctx.caller.institutionId, programId, outcomeId: input.outcomeId ?? null, resultId: input.resultId ?? null, gap: input.gap.trim(),
    rootCause: clean(input.rootCause) ?? null, action: clean(input.action) ?? null, owner: clean(input.owner) ?? null, implementIn: clean(input.implementIn) ?? null,
    verificationPlan: clean(input.verificationPlan) ?? null, status: input.status ?? 'open',
  }).returning();
  return toAction(row!);
}

/** Updates an action. "Verified" or "not effective" needs the re-assessment result it is judged on. */
export async function updateAction(ctx: Ctx, id: string, patch: Partial<SaveAction>): Promise<CorrectiveAction> {
  assertHuman(ctx);
  const [cur] = await ctx.tx.select().from(correctiveAction).where(eq(correctiveAction.id, id));
  if (!cur) throw new NotFoundError(`action ${id}`);
  await assertPermitted(ctx, 'program:write', { type: 'program', id: cur.programId });
  const set: Partial<typeof correctiveAction.$inferInsert> = {};
  for (const k of ['rootCause', 'action', 'owner', 'implementIn', 'verificationPlan', 'verificationNote'] as const) if (patch[k] !== undefined) set[k] = clean(patch[k]) ?? null;
  if (patch.gap !== undefined) set.gap = patch.gap.trim();
  if (patch.verifiedResultId !== undefined) set.verifiedResultId = patch.verifiedResultId ?? null;
  if (patch.status !== undefined) {
    if ((patch.status === 'verified' || patch.status === 'not_effective') && !(set.verifiedResultId ?? cur.verifiedResultId)) {
      throw new ValidationError('name the re-assessment result the action is judged on');
    }
    set.status = patch.status;
  }
  const [row] = await ctx.tx.update(correctiveAction).set(set).where(eq(correctiveAction.id, id)).returning();
  return toAction(row!);
}

// ---- ILO rotation and the institutional report (TASK-117) --------------------------------------------------------------------

export async function saveIloSchedule(ctx: Ctx, input: SaveIloSchedule): Promise<IloScheduleRow> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'org:write', { type: 'institution' });
  const [ilo] = await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.id, input.iloId));
  if (!ilo || ilo.kind !== 'ilo') throw new ValidationError('schedule an institutional learning outcome');
  const [row] = await ctx.tx.insert(iloSchedule).values({ institutionId: ctx.caller.institutionId, iloId: input.iloId, academicYear: input.academicYear, mechanism: clean(input.mechanism) ?? null, indirectMeasure: clean(input.indirectMeasure) ?? null })
    .onConflictDoUpdate({ target: [iloSchedule.iloId, iloSchedule.academicYear], set: { mechanism: clean(input.mechanism) ?? null, indirectMeasure: clean(input.indirectMeasure) ?? null } }).returning();
  return { id: row!.id, iloId: row!.iloId, academicYear: row!.academicYear, mechanism: row!.mechanism, indirectMeasure: row!.indirectMeasure };
}

export async function deleteIloSchedule(ctx: Ctx, id: string): Promise<{ deleted: boolean }> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'org:write', { type: 'institution' });
  const gone = await ctx.tx.delete(iloSchedule).where(eq(iloSchedule.id, id)).returning({ id: iloSchedule.id });
  return { deleted: gone.length > 0 };
}

/** Per ILO: its years, the PLOs linked to it across the programs the person can see, and their latest direct results. */
export async function getIloReport(ctx: Ctx): Promise<IloReport> {
  await assertPermitted(ctx, 'program:read', { type: 'any' });
  const ilos = (await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.kind, 'ilo'))).sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code, 'en', { numeric: true }));
  const schedule = (await ctx.tx.select().from(iloSchedule).orderBy(asc(iloSchedule.academicYear))).map((r) => ({ id: r.id, iloId: r.iloId, academicYear: r.academicYear, mechanism: r.mechanism, indirectMeasure: r.indirectMeasure }));
  const programs = await ctx.tx.select({ id: program.id, name: program.nameEn }).from(program);
  const visible = new Map(programs.map((p) => [p.id, p.name]));
  const links = ilos.length ? await ctx.tx.select({ ploId: outcomeLink.fromId, iloId: outcomeLink.toId, code: learningOutcome.code, programId: learningOutcome.programId })
    .from(outcomeLink).innerJoin(learningOutcome, eq(learningOutcome.id, outcomeLink.fromId)).where(inArray(outcomeLink.toId, ilos.map((i) => i.id))) : [];
  const ploIds = [...new Set(links.map((l) => l.ploId))];
  const results = ploIds.length ? await ctx.tx.select().from(outcomeResult).where(and(inArray(outcomeResult.outcomeId, ploIds), eq(outcomeResult.kind, 'direct'))).orderBy(desc(outcomeResult.term), desc(outcomeResult.createdAt)) : [];
  const bench = await getBenchmarks(ctx);
  const targetCache = new Map<string, Awaited<ReturnType<typeof targetsFor>>>();
  const issues: string[] = [];
  const report: IloReport['ilos'] = [];
  for (const i of ilos) {
    const mine = links.filter((l) => l.iloId === i.id && l.programId && visible.has(l.programId));
    const plos: IloReport['ilos'][number]['plos'] = [];
    for (const l of mine) {
      if (!targetCache.has(l.programId!)) targetCache.set(l.programId!, await targetsFor(ctx, l.programId!, bench));
      const r = results.find((x) => x.outcomeId === l.ploId);
      plos.push({ ploId: l.ploId, code: l.code, programId: l.programId!, program: visible.get(l.programId!)!, latest: r ? toResult(r, targetCache.get(l.programId!)!({ id: l.ploId, kind: 'plo' })) : null });
    }
    const progs = new Set(plos.map((p) => p.programId));
    const latestBy = [...progs].map((pid) => plos.filter((p) => p.programId === pid).map((p) => p.latest).filter(Boolean)[0] ?? null);
    if (!plos.length) issues.push(`${i.code} is not linked from any program's PLO`);
    report.push({
      iloId: i.id, code: i.code, text: i.textEn, years: schedule.filter((s) => s.iloId === i.id).map((s) => s.academicYear), plos,
      programs: progs.size, atOrAbove: latestBy.filter((r) => r?.standing === 'at_or_above').length, below: latestBy.filter((r) => r?.standing === 'below').length,
      noResult: latestBy.filter((r) => !r || r.standing === 'none').length,
    });
  }
  for (const i of ilos) if (!schedule.some((s) => s.iloId === i.id)) issues.push(`${i.code} has no year in the rotation`);
  return { schedule, ilos: report, issues };
}
