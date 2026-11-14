// Learning outcomes and their links (TASK-112, DEC-036, docs/assessment-of-learning-plan.md section 1). ILOs belong to the institution
// (org:write to change), PEOs, PLOs and performance indicators to a program (program:write on it), CLOs to a course (program:write at
// its unit). Links: CLO -> PLO with a mapping level (program:write on the PLO's program), PLO -> ILO and PLO -> PEO. The database checks
// the kinds and that the course is in the PLO's program; the level is checked here against the institution's levels.
// An approved outcome is never deleted: it is retired. A draft may be deleted, with its links.
import { and, eq, inArray, or } from 'drizzle-orm';
import { course, courseOutcomeMap, courseProgram, institution, learningOutcome, outcomeLink, program } from '@ams/db';
import {
  OutcomeLevelsSchema, resolveOutcomeLevel, type CoverageIssue, type CreateOutcome, type LearningOutcome, type OutcomeLevel, type OutcomeLinkInput,
  type ProgramOutcomes, type UpdateOutcome, type CourseMap, type CourseMapInput,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { courseScope, loadCourse } from './courses.js';
import { getSyllabusSettings } from '../syllabus/syllabus.js';

type Row = typeof learningOutcome.$inferSelect;
const nfc = (s: string) => s.normalize('NFC').trim();
const clean = (s: string | null | undefined) => (s === undefined ? undefined : s ? nfc(s) : null);
const byCode = (a: { displayOrder: number; code: string }, b: { displayOrder: number; code: string }) =>
  a.displayOrder - b.displayOrder || a.code.localeCompare(b.code, 'en', { numeric: true });
const KIND_NAME = { ilo: 'ILO', peo: 'PEO', plo: 'PLO', pi: 'performance indicator', clo: 'CLO' } as const;

export const toOutcome = (r: Row): LearningOutcome => ({
  id: r.id, kind: r.kind, programId: r.programId, courseId: r.courseId, parentId: r.parentId, code: r.code, textEn: r.textEn, textAr: r.textAr,
  bloomLevel: r.bloomLevel, displayOrder: r.displayOrder, status: r.status, approvedOn: r.approvedOn, approvalRef: r.approvalRef, source: r.source,
});

async function guardCode<T>(fn: () => Promise<T>, kind: Row['kind'], code: string | undefined): Promise<T> {
  try { return await guardIntegrity(fn); } catch (e) {
    if ((e as Error).message.includes('learning_outcome_code_idx')) throw new ConflictError(`there is already a ${KIND_NAME[kind]} with the code ${code ?? ''} here`);
    throw e;
  }
}

// ---- Levels ----------------------------------------------------------------------------------------------------------------

export async function getOutcomeLevels(ctx: Ctx): Promise<OutcomeLevel[]> {
  const [row] = await ctx.tx.select({ levels: institution.outcomeLevels }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  return row?.levels ?? [];
}

/** Sets the mapping levels (DEC-036). A level in use cannot be removed: rename it instead (links keep their code). */
export async function setOutcomeLevels(ctx: Ctx, input: OutcomeLevel[]): Promise<OutcomeLevel[]> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'org:write', { type: 'institution' });
  const levels = OutcomeLevelsSchema.parse(input);
  const used = [...await ctx.tx.selectDistinct({ level: outcomeLink.level }).from(outcomeLink), ...await ctx.tx.selectDistinct({ level: courseOutcomeMap.level }).from(courseOutcomeMap)];
  const gone = [...new Set(used.map((u) => u.level))].filter((l): l is string => !!l && !levels.some((x) => x.code === l));
  if (gone.length) throw new ConflictError(`links or the curriculum map use the level ${gone.join(', ')}; keep it (you may rename it)`);
  await ctx.tx.update(institution).set({ outcomeLevels: levels }).where(eq(institution.id, ctx.caller.institutionId));
  return levels;
}

// ---- Outcomes ----------------------------------------------------------------------------------------------------------------

async function loadOutcome(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.id, id));
  if (!row) throw new NotFoundError(`outcome ${id}`);
  return row;
}

/** Who may change an outcome of this kind and owner. */
async function assertCanWrite(ctx: Ctx, o: Pick<Row, 'kind' | 'programId' | 'courseId'>) {
  if (o.kind === 'ilo') return assertPermitted(ctx, 'org:write', { type: 'institution' });
  if (o.kind === 'clo') return assertPermitted(ctx, 'program:write', courseScope((await loadCourse(ctx, o.courseId!)).orgUnitId));
  return assertPermitted(ctx, 'program:write', { type: 'program', id: o.programId! });
}

/** The institution's ILOs, in order. */
export async function listIlos(ctx: Ctx): Promise<LearningOutcome[]> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  return (await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.kind, 'ilo'))).sort(byCode).map(toOutcome);
}

export async function createOutcome(ctx: Ctx, input: CreateOutcome): Promise<LearningOutcome> {
  assertHuman(ctx);
  const kind = input.kind;
  let programId = input.programId ?? null;
  const courseId = kind === 'clo' ? (input.courseId ?? null) : null;
  const parentId = kind === 'pi' ? (input.parentId ?? null) : null;
  if (kind === 'clo' && !courseId) throw new ValidationError('a CLO needs its course');
  if (kind === 'pi') {
    if (!parentId) throw new ValidationError('a performance indicator needs its PLO');
    const parent = await loadOutcome(ctx, parentId);
    if (parent.kind !== 'plo') throw new ValidationError('a performance indicator belongs under a PLO');
    programId = parent.programId;
  }
  if ((kind === 'peo' || kind === 'plo') && !programId) throw new ValidationError(`a ${KIND_NAME[kind]} needs its program`);
  if (kind === 'ilo' || kind === 'clo') programId = null;
  if (programId) {
    const [p] = await ctx.tx.select({ id: program.id }).from(program).where(eq(program.id, programId));
    if (!p) throw new NotFoundError(`program ${programId}`);
  }
  await assertCanWrite(ctx, { kind, programId, courseId });
  const siblings = await ctx.tx.select({ n: learningOutcome.displayOrder }).from(learningOutcome).where(and(
    eq(learningOutcome.kind, kind),
    programId ? eq(learningOutcome.programId, programId) : courseId ? eq(learningOutcome.courseId, courseId) : eq(learningOutcome.kind, 'ilo'),
  ));
  const [row] = await guardCode(() => ctx.tx.insert(learningOutcome).values({
    institutionId: ctx.caller.institutionId, kind, programId, courseId, parentId, code: nfc(input.code), textEn: nfc(input.textEn),
    textAr: clean(input.textAr) ?? null, bloomLevel: input.bloomLevel ?? null,
    displayOrder: input.displayOrder ?? (siblings.length ? Math.max(...siblings.map((s) => s.n)) + 1 : 0),
    status: input.status ?? 'draft', approvedOn: input.approvedOn ?? null, approvalRef: clean(input.approvalRef) ?? null, source: clean(input.source) ?? null,
  }).returning(), kind, input.code);
  return toOutcome(row!);
}

export async function updateOutcome(ctx: Ctx, id: string, patch: UpdateOutcome): Promise<LearningOutcome> {
  assertHuman(ctx);
  const cur = await loadOutcome(ctx, id);
  await assertCanWrite(ctx, cur);
  const set: Partial<typeof learningOutcome.$inferInsert> = {};
  if (patch.code !== undefined) set.code = nfc(patch.code);
  if (patch.textEn !== undefined) set.textEn = nfc(patch.textEn);
  for (const k of ['textAr', 'approvalRef', 'source'] as const) if (patch[k] !== undefined) set[k] = clean(patch[k]) ?? null;
  if (patch.bloomLevel !== undefined) set.bloomLevel = patch.bloomLevel;
  if (patch.displayOrder !== undefined) set.displayOrder = patch.displayOrder;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.approvedOn !== undefined) set.approvedOn = patch.approvedOn;
  if (!Object.keys(set).length) return toOutcome(cur);
  const [row] = await guardCode(() => ctx.tx.update(learningOutcome).set(set).where(eq(learningOutcome.id, id)).returning(), cur.kind, patch.code);
  return toOutcome(row!);
}

/** Deletes a draft outcome with its links (and, for a PLO, its performance indicators). An approved one is retired instead. */
export async function deleteOutcome(ctx: Ctx, id: string): Promise<{ deleted: true }> {
  assertHuman(ctx);
  const cur = await loadOutcome(ctx, id);
  await assertCanWrite(ctx, cur);
  if (cur.status !== 'draft') throw new ConflictError(`an ${cur.status} ${KIND_NAME[cur.kind]} is kept for the record: retire it instead`);
  await ctx.tx.delete(learningOutcome).where(eq(learningOutcome.id, id));
  return { deleted: true };
}

// ---- Links ---------------------------------------------------------------------------------------------------------------------

/** Adds or changes a link. CLO -> PLO carries a level (a code or alias of the institution's levels, or null for "not set"). */
export async function setOutcomeLink(ctx: Ctx, input: OutcomeLinkInput): Promise<{ fromId: string; toId: string; level: string | null }> {
  assertHuman(ctx);
  const [from, to] = [await loadOutcome(ctx, input.fromId), await loadOutcome(ctx, input.toId)];
  const plo = from.kind === 'plo' ? from : to;
  if (plo.kind !== 'plo') throw new ValidationError('a link joins a CLO to a PLO, or a PLO to an ILO or a PEO');
  await assertPermitted(ctx, 'program:write', { type: 'program', id: plo.programId! });
  let level: string | null = null;
  if (from.kind === 'clo' && input.level) {
    level = resolveOutcomeLevel(await getOutcomeLevels(ctx), input.level);
    if (!level) throw new ValidationError(`"${input.level}" is not one of the mapping levels`);
  } else if (input.level && from.kind !== 'clo') throw new ValidationError('only a CLO-PLO link has a mapping level');
  await guardIntegrity(() => ctx.tx.insert(outcomeLink).values({ institutionId: ctx.caller.institutionId, fromId: from.id, toId: to.id, level })
    .onConflictDoUpdate({ target: [outcomeLink.fromId, outcomeLink.toId], set: { level } }));
  return { fromId: from.id, toId: to.id, level };
}

export async function removeOutcomeLink(ctx: Ctx, fromId: string, toId: string): Promise<{ removed: boolean }> {
  assertHuman(ctx);
  const [from, to] = [await loadOutcome(ctx, fromId), await loadOutcome(ctx, toId)];
  const plo = from.kind === 'plo' ? from : to;
  await assertPermitted(ctx, 'program:write', { type: 'program', id: plo.programId! });
  const gone = await ctx.tx.delete(outcomeLink).where(and(eq(outcomeLink.fromId, fromId), eq(outcomeLink.toId, toId))).returning({ id: outcomeLink.id });
  return { removed: gone.length > 0 };
}

// ---- The curriculum map built top-down (DEC-039) ------------------------------------------------------------------------------

/**
 * Maps a course to a PLO of one of its programs at one level, without needing CLOs (top-down); a null level takes the mapping away.
 * The CLOs that deliver it are linked as before (bottom-up). program:write on the PLO's program.
 */
export async function setCourseMap(ctx: Ctx, input: CourseMapInput): Promise<CourseMap> {
  assertHuman(ctx);
  const target = await loadOutcome(ctx, input.outcomeId);
  if (target.kind !== 'plo') throw new ValidationError('a course is mapped top-down to a PLO');
  await assertPermitted(ctx, 'program:write', { type: 'program', id: target.programId! });
  await loadCourse(ctx, input.courseId);
  const where = and(eq(courseOutcomeMap.courseId, input.courseId), eq(courseOutcomeMap.outcomeId, target.id));
  if (!input.level) {
    await ctx.tx.delete(courseOutcomeMap).where(where);
    return { courseId: input.courseId, outcomeId: target.id, level: null };
  }
  const level = resolveOutcomeLevel(await getOutcomeLevels(ctx), input.level);
  if (!level) throw new ValidationError(`"${input.level}" is not one of the mapping levels`);
  await guardIntegrity(() => ctx.tx.insert(courseOutcomeMap).values({ institutionId: ctx.caller.institutionId, courseId: input.courseId, outcomeId: target.id, level })
    .onConflictDoUpdate({ target: [courseOutcomeMap.courseId, courseOutcomeMap.outcomeId], set: { level } }));
  return { courseId: input.courseId, outcomeId: target.id, level };
}

// ---- A program's outcomes, map and coverage --------------------------------------------------------------------------------

/** Everything the program's Outcomes screen shows: PEOs, PLOs and indicators, ILOs, its courses with CLOs, links, the map, coverage. */
export async function getProgramOutcomes(ctx: Ctx, programId: string): Promise<ProgramOutcomes> {
  await assertPermitted(ctx, 'program:read', { type: 'program', id: programId });
  const [p] = await ctx.tx.select({ id: program.id }).from(program).where(eq(program.id, programId));
  if (!p) throw new NotFoundError(`program ${programId}`);
  const levels = await getOutcomeLevels(ctx);
  const own = (await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.programId, programId))).sort(byCode);
  const ilos = (await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.kind, 'ilo'))).sort(byCode);
  const cps = await ctx.tx.select({ cp: courseProgram, c: course }).from(courseProgram).innerJoin(course, eq(course.id, courseProgram.courseId))
    .where(eq(courseProgram.programId, programId));
  const courseIds = cps.map((r) => r.c.id);
  const clos = courseIds.length ? (await ctx.tx.select().from(learningOutcome).where(and(eq(learningOutcome.kind, 'clo'), inArray(learningOutcome.courseId, courseIds)))).sort(byCode) : [];
  const plos = own.filter((o) => o.kind === 'plo');
  const ploIds = plos.map((o) => o.id);
  const links = ploIds.length ? await ctx.tx.select({ fromId: outcomeLink.fromId, toId: outcomeLink.toId, level: outcomeLink.level }).from(outcomeLink)
    .where(or(inArray(outcomeLink.toId, ploIds), inArray(outcomeLink.fromId, ploIds))) : [];

  const order = new Map(levels.map((l, i) => [l.code, i]));
  const mastery = levels.find((l) => l.mastery)?.code ?? null;
  const cloCourse = new Map(clos.map((c) => [c.id, c.courseId!]));
  const topDown = ploIds.length && courseIds.length
    ? await ctx.tx.select({ courseId: courseOutcomeMap.courseId, ploId: courseOutcomeMap.outcomeId, level: courseOutcomeMap.level }).from(courseOutcomeMap)
      .where(and(inArray(courseOutcomeMap.outcomeId, ploIds), inArray(courseOutcomeMap.courseId, courseIds)))
    : [];
  const map: ProgramOutcomes['map'] = [];
  for (const plo of plos) {
    for (const { c } of cps) {
      const ls = links.filter((l) => l.toId === plo.id && cloCourse.get(l.fromId) === c.id);
      const td = topDown.find((m) => m.ploId === plo.id && m.courseId === c.id)?.level ?? null;
      if (!ls.length && !td) continue;
      const codes = [...new Set(ls.map((l) => l.level).filter((l): l is string => !!l))].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
      map.push({ ploId: plo.id, courseId: c.id, topDown: td, levels: codes, highest: codes.at(-1) ?? null });
    }
  }

  const coverage: CoverageIssue[] = [];
  const cloToPlo = links.filter((l) => cloCourse.has(l.fromId));
  for (const plo of plos.filter((o) => o.status !== 'retired')) {
    const mine = cloToPlo.filter((l) => l.toId === plo.id);
    const direct = topDown.filter((m) => m.ploId === plo.id);
    if (!mine.length && !direct.length) coverage.push({ kind: 'plo_unmapped', refId: plo.id, label: plo.code, message: `${plo.code} has no course mapped to it` });
    else if (mastery && !mine.some((l) => l.level === mastery) && !direct.some((m) => m.level === mastery)) coverage.push({ kind: 'plo_no_mastery', refId: plo.id, label: plo.code, message: `${plo.code} is never reached at the mastery level (${mastery})` });
    if (ilos.length && !links.some((l) => l.fromId === plo.id && ilos.some((i) => i.id === l.toId))) coverage.push({ kind: 'plo_no_ilo', refId: plo.id, label: plo.code, message: `${plo.code} is not linked to an institutional learning outcome` });
  }
  // Courses (DEC-039): mapped either way counts; the syllabus rules' minimum and maximum PLOs and CLOs per course are flagged, never enforced.
  const limits = await getSyllabusSettings(ctx);
  const ploName = new Map(plos.map((o) => [o.id, o.code]));
  const levelName = new Map(levels.map((l) => [l.code, l.name]));
  for (const { c, cp } of cps) {
    if (!c.active) continue;
    const cells = map.filter((m) => m.courseId === c.id && ploName.has(m.ploId) && plos.find((o) => o.id === m.ploId)!.status !== 'retired');
    const role = cp.role === 'core' ? '' : ` (${cp.role})`;
    if (!cells.length) coverage.push({ kind: 'course_unmapped', refId: c.id, label: c.code, message: `${c.code}${role} maps to no PLO of this program` });
    else if (cells.length < limits.minPlos) coverage.push({ kind: 'course_plo_count', refId: c.id, label: c.code, message: `${c.code} maps to ${cells.length} PLO${cells.length === 1 ? '' : 's'}; the syllabus rules ask for at least ${limits.minPlos}` });
    else if (cells.length > limits.maxPlos) coverage.push({ kind: 'course_plo_count', refId: c.id, label: c.code, message: `${c.code} maps to ${cells.length} PLOs; the syllabus rules allow at most ${limits.maxPlos}` });
    const n = clos.filter((o) => o.courseId === c.id && o.status !== 'retired').length;
    if (n < limits.minClos) coverage.push({ kind: 'course_clo_count', refId: c.id, label: c.code, message: `${c.code} has ${n} CLO${n === 1 ? '' : 's'}; the syllabus rules ask for at least ${limits.minClos}` });
    else if (n > limits.maxClos) coverage.push({ kind: 'course_clo_count', refId: c.id, label: c.code, message: `${c.code} has ${n} CLOs; the syllabus rules allow at most ${limits.maxClos}` });
    for (const m of cells.filter((x) => x.topDown)) {
      const plo = ploName.get(m.ploId)!;
      const name = (code: string) => `${levelName.get(code) ?? code}`;
      if (!links.some((l) => l.toId === m.ploId && cloCourse.get(l.fromId) === c.id)) {
        coverage.push({ kind: 'course_map_no_clo', refId: c.id, label: `${c.code} ${plo}`, message: `${c.code} is mapped to ${plo} (${name(m.topDown!)}) but none of its CLOs is linked to ${plo}` });
      } else if (m.highest && m.highest !== m.topDown) {
        coverage.push({ kind: 'level_mismatch', refId: c.id, label: `${c.code} ${plo}`, message: `${c.code} is mapped to ${plo} as ${name(m.topDown!)}, but its CLOs reach ${name(m.highest)}` });
      }
    }
  }
  for (const l of cloToPlo.filter((x) => !x.level)) {
    const clo = clos.find((o) => o.id === l.fromId)!; const plo = plos.find((o) => o.id === l.toId)!;
    const cc = cps.find((r) => r.c.id === clo.courseId)?.c.code ?? '';
    coverage.push({ kind: 'link_no_level', refId: clo.id, label: `${cc} ${clo.code}`, message: `${cc} ${clo.code} -> ${plo.code} has no level` });
  }

  return {
    programId, levels,
    peos: own.filter((o) => o.kind === 'peo').map(toOutcome), plos: plos.map(toOutcome), indicators: own.filter((o) => o.kind === 'pi').map(toOutcome),
    ilos: ilos.map(toOutcome),
    courses: cps.sort((a, b) => (a.cp.year ?? 99) - (b.cp.year ?? 99) || (a.cp.term ?? 9) - (b.cp.term ?? 9) || a.c.code.localeCompare(b.c.code, 'en', { numeric: true }))
      .map(({ c, cp }) => ({ courseId: c.id, code: c.code, titleEn: c.titleEn, role: cp.role, year: cp.year, term: cp.term, clos: clos.filter((o) => o.courseId === c.id).map(toOutcome) })),
    links, map, coverage,
  };
}

/** A course's CLOs, in order. */
export async function listCourseOutcomes(ctx: Ctx, courseId: string): Promise<LearningOutcome[]> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  await loadCourse(ctx, courseId);
  return (await ctx.tx.select().from(learningOutcome).where(eq(learningOutcome.courseId, courseId))).sort(byCode).map(toOutcome);
}

