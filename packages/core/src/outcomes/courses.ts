// Courses (TASK-105): a course of the institution, owned by an org unit, serving programs as core, elective or service courses. The
// course record is institution-wide (everyone with org:read sees the catalogue); writing it needs program:write at its unit (or at
// the institution when it has none); linking it to a program needs program:write on that program.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { concentration, course, courseProgram, courseProgramConcentration, learningOutcome, orgUnit, program, syllabusVersion } from '@ams/db';
import type { Course, CourseProgramInput, CreateCourse, Scope, UpdateCourse } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';

type CourseRow = typeof course.$inferSelect;
const nfc = (s: string) => s.normalize('NFC').trim();
const clean = (s: string | null | undefined) => (s === undefined ? undefined : s ? nfc(s) : null);
export const courseScope = (orgUnitId: string | null): Scope => (orgUnitId ? { type: 'org_unit', id: orgUnitId } : { type: 'institution' });

/** Unique-index violations in words. */
async function guardCodes<T>(fn: () => Promise<T>, code?: string): Promise<T> {
  try { return await guardIntegrity(fn); } catch (e) {
    const m = (e as Error).message;
    if (m.includes('course_code_idx')) throw new ConflictError(`a course with the code ${code ?? ''} already exists`.replace('  ', ' '));
    if (m.includes('course_external_id_idx')) throw new ConflictError('another course has that student-system id');
    throw e;
  }
}

/** The concentrations each study-plan row (course_program id) counts toward (DEC-047). */
export async function concentrationsOf(ctx: Ctx, courseProgramIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!courseProgramIds.length) return out;
  const rows = await ctx.tx.select({ cp: courseProgramConcentration.courseProgramId, c: courseProgramConcentration.concentrationId }).from(courseProgramConcentration)
    .where(inArray(courseProgramConcentration.courseProgramId, courseProgramIds));
  for (const r of rows) out.set(r.cp, [...(out.get(r.cp) ?? []), r.c]);
  return out;
}

async function rowsToCourses(ctx: Ctx, rows: CourseRow[]): Promise<Course[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const links = await ctx.tx.select({ courseId: courseProgram.courseId, programId: courseProgram.programId, role: courseProgram.role, year: courseProgram.year, term: courseProgram.term, block: courseProgram.block, id: courseProgram.id }).from(courseProgram).where(inArray(courseProgram.courseId, ids));
  const concs = await concentrationsOf(ctx, links.map((l) => l.id));
  const clos = await ctx.tx.select({ courseId: learningOutcome.courseId, n: sql<number>`count(*)::int` }).from(learningOutcome)
    .where(and(inArray(learningOutcome.courseId, ids), eq(learningOutcome.kind, 'clo'))).groupBy(learningOutcome.courseId);
  const cloN = new Map(clos.map((c) => [c.courseId, c.n]));
  const approved = new Set((await ctx.tx.select({ courseId: syllabusVersion.courseId }).from(syllabusVersion)
    .where(and(inArray(syllabusVersion.courseId, ids), eq(syllabusVersion.status, 'approved')))).map((v) => v.courseId));
  return rows.map((r) => withMissing({
    id: r.id, orgUnitId: r.orgUnitId, code: r.code, externalId: r.externalId, titleEn: r.titleEn, titleAr: r.titleAr, description: r.description,
    credits: r.credits === null ? null : Number(r.credits), level: r.level, languageOfInstruction: r.languageOfInstruction, active: r.active,
    programIds: links.filter((l) => l.courseId === r.id).map((l) => l.programId),
    placements: links.filter((l) => l.courseId === r.id).map((l) => ({ programId: l.programId, role: l.role, year: l.year, term: l.term, block: l.block, concentrationIds: concs.get(l.id) ?? [] })), cloCount: cloN.get(r.id) ?? 0, approved: approved.has(r.id),
  }));
}
/** What a course record must have (the owner, 2026-11-18): a unit, its credit hours and at least one program it serves (code and English title always do). */
const withMissing = (c: Omit<Course, 'missing'>): Course => ({
  ...c, missing: [...(c.orgUnitId ? [] : ['Unit']), ...(c.credits === null ? ['Credit hours'] : []), ...(c.programIds.length ? [] : ['Study plan'])],
});

/**
 * The course's content (titles, credits, description, language, CLOs) is changed through its draft once it has approved content
 * (the owner, 2026-11-18: the course is the master record, changes are drafted and approved, the syllabus is a report generated from it).
 * Before that, a new course's content is seeded directly.
 */
export async function assertContentEditable(ctx: Ctx, courseId: string, what: string): Promise<void> {
  const [v] = await ctx.tx.select({ id: syllabusVersion.id }).from(syllabusVersion).where(and(eq(syllabusVersion.courseId, courseId), eq(syllabusVersion.status, 'approved')));
  if (v) throw new ConflictError(`${what} of a course with approved content changes through its draft (the course page, Course content), and takes effect once approved`);
}

export async function loadCourse(ctx: Ctx, id: string): Promise<CourseRow> {
  const [row] = await ctx.tx.select().from(course).where(eq(course.id, id));
  if (!row) throw new NotFoundError(`course ${id}`);
  return row;
}

/** The institution's courses by code; `programId` narrows to the courses of one program. */
export async function listCourses(ctx: Ctx, filter: { programId?: string } = {}): Promise<Course[]> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const rows = filter.programId
    ? (await ctx.tx.select({ c: course }).from(course).innerJoin(courseProgram, eq(courseProgram.courseId, course.id))
      .where(eq(courseProgram.programId, filter.programId)).orderBy(asc(course.code))).map((r) => r.c)
    : await ctx.tx.select().from(course).orderBy(asc(course.code));
  return rowsToCourses(ctx, rows);
}

export async function getCourse(ctx: Ctx, id: string): Promise<Course> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  return (await rowsToCourses(ctx, [await loadCourse(ctx, id)]))[0]!;
}

async function assertUnit(ctx: Ctx, id: string | null | undefined) {
  if (!id) return;
  const [u] = await ctx.tx.select({ id: orgUnit.id, active: orgUnit.active }).from(orgUnit).where(eq(orgUnit.id, id));
  if (!u) throw new NotFoundError(`org unit ${id}`);
  if (!u.active) throw new ConflictError('a course cannot be owned by an inactive unit');
}

export async function createCourse(ctx: Ctx, input: CreateCourse): Promise<Course> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', courseScope(input.orgUnitId ?? null));
  await assertUnit(ctx, input.orgUnitId);
  const [row] = await guardCodes(() => ctx.tx.insert(course).values({
    institutionId: ctx.caller.institutionId, orgUnitId: input.orgUnitId ?? null, code: nfc(input.code), externalId: clean(input.externalId) ?? null,
    titleEn: nfc(input.titleEn), titleAr: clean(input.titleAr) ?? null, description: clean(input.description) ?? null,
    credits: input.credits === null || input.credits === undefined ? null : String(input.credits), level: input.level ?? null,
    languageOfInstruction: clean(input.languageOfInstruction) ?? null,
  }).returning(), input.code);
  return (await rowsToCourses(ctx, [row!]))[0]!;
}

/** Edits a course. Moving it to another unit needs program:write at both units. */
export async function updateCourse(ctx: Ctx, id: string, patch: UpdateCourse): Promise<Course> {
  assertHuman(ctx);
  const cur = await loadCourse(ctx, id);
  await assertPermitted(ctx, 'program:write', courseScope(cur.orgUnitId));
  if (patch.orgUnitId !== undefined && patch.orgUnitId !== cur.orgUnitId) {
    await assertPermitted(ctx, 'program:write', courseScope(patch.orgUnitId));
    await assertUnit(ctx, patch.orgUnitId);
  }
  const content = (['titleEn', 'titleAr', 'description', 'languageOfInstruction'] as const).filter((k) => patch[k] !== undefined && (clean(patch[k] as string) ?? null) !== (cur[k] ?? null));
  if (patch.credits !== undefined && (patch.credits === null ? null : Number(patch.credits)) !== (cur.credits === null ? null : Number(cur.credits))) content.push('credits' as never);
  if (content.length) await assertContentEditable(ctx, id, `The ${content.join(', ')}`);
  const set: Partial<typeof course.$inferInsert> = {};
  if (patch.orgUnitId !== undefined) set.orgUnitId = patch.orgUnitId;
  if (patch.code !== undefined) set.code = nfc(patch.code);
  if (patch.titleEn !== undefined) set.titleEn = nfc(patch.titleEn);
  for (const k of ['externalId', 'titleAr', 'description', 'languageOfInstruction'] as const) if (patch[k] !== undefined) set[k] = clean(patch[k]) ?? null;
  if (patch.credits !== undefined) set.credits = patch.credits === null ? null : String(patch.credits);
  if (patch.level !== undefined) set.level = patch.level;
  if (patch.active !== undefined) set.active = patch.active;
  if (!Object.keys(set).length) return getCourse(ctx, id);
  const [row] = await guardCodes(() => ctx.tx.update(course).set(set).where(eq(course.id, id)).returning(), patch.code);
  return (await rowsToCourses(ctx, [row!]))[0]!;
}

/** Deleting a course deactivates it: results, syllabi and the audit trail refer to it (the API's DELETE). */
/**
 * Deletes a course that has no history: no approved syllabus (its draft, CLOs, study-plan rows and links go with it). A course with an
 * approved syllabus is kept for the record and deactivated instead, as is one the database will not let go (it then says why).
 */
export async function deleteCourse(ctx: Ctx, id: string): Promise<{ deleted: boolean; course: Course | null; reason: string | null }> {
  assertHuman(ctx);
  const cur = await loadCourse(ctx, id);
  await assertPermitted(ctx, 'program:write', courseScope(cur.orgUnitId));
  const kept = await ctx.tx.select({ id: syllabusVersion.id }).from(syllabusVersion)
    .where(and(eq(syllabusVersion.courseId, id), inArray(syllabusVersion.status, ['approved', 'superseded']))).limit(1);
  if (kept.length) return { deleted: false, course: await updateCourse(ctx, id, { active: false }), reason: 'it has an approved syllabus, which is kept for the record' };
  try {
    await ctx.tx.transaction(async (sp) => { await sp.delete(course).where(eq(course.id, id)); });
    return { deleted: true, course: null, reason: null };
  } catch (e) {
    return { deleted: false, course: await updateCourse(ctx, id, { active: false }), reason: `the database keeps it (${(e as Error).message})` };
  }
}

/** Puts a course in a program (or changes its role, year and term there). */
export async function setCourseProgram(ctx: Ctx, courseId: string, programId: string, input: CourseProgramInput): Promise<Course> {
  assertHuman(ctx);
  await loadCourse(ctx, courseId);
  const [p] = await ctx.tx.select({ id: program.id }).from(program).where(eq(program.id, programId));
  if (!p) throw new NotFoundError(`program ${programId}`);
  await assertPermitted(ctx, 'program:write', { type: 'program', id: programId });
  const concIds = input.concentrationIds === undefined ? undefined : [...new Set(input.concentrationIds)];
  if (concIds?.length) {
    const ks = await ctx.tx.select({ id: concentration.id, programId: concentration.programId }).from(concentration).where(inArray(concentration.id, concIds));
    if (ks.length !== concIds.length || ks.some((k) => k.programId !== programId)) throw new ValidationError('a concentration does not belong to this program');
  }
  // The block and the concentrations are left as they are when the input does not name them (a role change must not unplace the course).
  const place = input.block !== undefined ? { block: input.block } : {};
  const [row] = await guardIntegrity(() => ctx.tx.insert(courseProgram).values({
    institutionId: ctx.caller.institutionId, courseId, programId, role: input.role ?? 'core', year: input.year ?? null, term: input.term ?? null, ...place,
  }).onConflictDoUpdate({ target: [courseProgram.courseId, courseProgram.programId], set: { role: input.role ?? 'core', year: input.year ?? null, term: input.term ?? null, ...place } }).returning({ id: courseProgram.id }));
  if (concIds !== undefined) {
    await ctx.tx.delete(courseProgramConcentration).where(eq(courseProgramConcentration.courseProgramId, row!.id));
    if (concIds.length) await ctx.tx.insert(courseProgramConcentration).values(concIds.map((concentrationId) => ({ institutionId: ctx.caller.institutionId, courseProgramId: row!.id, concentrationId })));
  }
  return getCourse(ctx, courseId);
}

/** Takes a course out of a program. Its CLOs' links to that program's PLOs go with it (they would no longer be valid). */
export async function removeCourseProgram(ctx: Ctx, courseId: string, programId: string): Promise<Course> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', { type: 'program', id: programId });
  await ctx.tx.execute(sql`delete from outcome_link l using learning_outcome f, learning_outcome t
    where l.from_id = f.id and l.to_id = t.id and f.course_id = ${courseId}::uuid and t.program_id = ${programId}::uuid`);
  await ctx.tx.delete(courseProgram).where(and(eq(courseProgram.courseId, courseId), eq(courseProgram.programId, programId)));
  return getCourse(ctx, courseId);
}
