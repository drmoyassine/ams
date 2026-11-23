// The catalog's structure (DEC-046, step 2). General Education is one institutional block (its credits and its areas with a minimum each and
// a pool of courses), owned by Academic Affairs: whoever holds program:write for the whole institution. Concentrations, block credits and
// elective slots belong to a program (program:write at the program). The checks are flagged, never refused.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { concentration, course, courseProgram, courseProgramConcentration, courseRequisite, programGenedArea, genedArea, genedAreaCourse, institution, program, programBlock, studyPlanSlot } from '@ams/db';
import {
  CatalogSettingsSchema, REQUIREMENT_BLOCKS, REQUIREMENT_KINDS,
  type BlockTotal, type CatalogSettings, type Concentration, type CreateConcentration, type CreateGenedArea, type CreateStudySlot, type GenedArea, type GenedOverview,
  type ProgramBlock, type ProgramRequirements, type SetProgramGenedArea, type RequirementBlock, type RequirementIssue, type RequirementKind, type SetProgramBlock, type StudySlot, type UpdateConcentration,
  type UpdateGenedArea, type UpdateStudySlot,
} from '@ams/shared';
import { ConflictError, NotFoundError, ValidationError, type Ctx } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';

const nfc = (s: string) => s.normalize('NFC').trim();
const clean = (s: string | null | undefined) => (s === null || s === undefined ? null : nfc(s) || null);
const num = (v: string | number | null) => (v === null ? null : Number(v));
const ALL = { type: 'institution' } as const;
const programScope = (id: string) => ({ type: 'program', id }) as const;

// ---- Settings and General Education (Academic Affairs) --------------------------------------------------------------------

export async function getCatalogSettings(ctx: Ctx): Promise<CatalogSettings> {
  const [row] = await ctx.tx.select({ s: institution.catalogSettings }).from(institution).where(eq(institution.id, ctx.caller.institutionId));
  return CatalogSettingsSchema.parse({ genedCredits: null, freeElectiveCredits: null, ...(row?.s ?? {}) });
}
/** Sets the institution's defaults; a field left out stays as it is. */
export async function setCatalogSettings(ctx: Ctx, input: Partial<CatalogSettings>): Promise<CatalogSettings> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', ALL);
  const next = CatalogSettingsSchema.parse({ ...(await getCatalogSettings(ctx)), ...input });
  await ctx.tx.update(institution).set({ catalogSettings: next }).where(eq(institution.id, ctx.caller.institutionId));
  return next;
}

const toArea = (r: typeof genedArea.$inferSelect, courseIds: string[]): GenedArea => ({ id: r.id, code: r.code, nameEn: r.nameEn, nameAr: r.nameAr, minCredits: Number(r.minCredits), displayOrder: r.displayOrder, active: r.active, courseIds });

export async function listGenedAreas(ctx: Ctx): Promise<GenedOverview> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const areas = await ctx.tx.select().from(genedArea).orderBy(asc(genedArea.displayOrder), asc(genedArea.code));
  const pools = areas.length ? await ctx.tx.select().from(genedAreaCourse) : [];
  return { settings: await getCatalogSettings(ctx), areas: areas.map((a) => toArea(a, pools.filter((p) => p.areaId === a.id).map((p) => p.courseId))) };
}

export async function createGenedArea(ctx: Ctx, input: CreateGenedArea): Promise<GenedArea> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', ALL);
  const [last] = await ctx.tx.select({ n: sql<number>`coalesce(max(${genedArea.displayOrder}), -1)::int` }).from(genedArea);
  const [row] = await guardIntegrity(() => ctx.tx.insert(genedArea).values({
    institutionId: ctx.caller.institutionId, code: nfc(input.code), nameEn: nfc(input.nameEn), nameAr: clean(input.nameAr), minCredits: String(input.minCredits ?? 0), displayOrder: (last?.n ?? -1) + 1,
  }).returning());
  return toArea(row!, []);
}
export async function updateGenedArea(ctx: Ctx, id: string, patch: UpdateGenedArea): Promise<GenedArea> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', ALL);
  const set: Partial<typeof genedArea.$inferInsert> = {};
  if (patch.code !== undefined) set.code = nfc(patch.code);
  if (patch.nameEn !== undefined) set.nameEn = nfc(patch.nameEn);
  if (patch.nameAr !== undefined) set.nameAr = clean(patch.nameAr);
  if (patch.minCredits !== undefined) set.minCredits = String(patch.minCredits);
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.displayOrder !== undefined) set.displayOrder = patch.displayOrder;
  const [row] = Object.keys(set).length ? await guardIntegrity(() => ctx.tx.update(genedArea).set(set).where(eq(genedArea.id, id)).returning()) : await ctx.tx.select().from(genedArea).where(eq(genedArea.id, id));
  if (!row) throw new NotFoundError(`GenEd area ${id}`);
  const pool = await ctx.tx.select({ c: genedAreaCourse.courseId }).from(genedAreaCourse).where(eq(genedAreaCourse.areaId, id));
  return toArea(row, pool.map((p) => p.c));
}
export async function deleteGenedArea(ctx: Ctx, id: string): Promise<{ deleted: true }> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', ALL);
  await ctx.tx.delete(genedArea).where(eq(genedArea.id, id));
  return { deleted: true };
}
/** Sets the pool of an area: exactly these courses count toward it. */
export async function setAreaCourses(ctx: Ctx, areaId: string, courseIds: string[]): Promise<GenedArea> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'program:write', ALL);
  const [area] = await ctx.tx.select().from(genedArea).where(eq(genedArea.id, areaId));
  if (!area) throw new NotFoundError(`GenEd area ${areaId}`);
  const ids = [...new Set(courseIds)];
  if (ids.length && (await ctx.tx.select({ id: course.id }).from(course).where(inArray(course.id, ids))).length !== ids.length) throw new ValidationError('a course in the pool does not exist');
  await ctx.tx.delete(genedAreaCourse).where(eq(genedAreaCourse.areaId, areaId));
  if (ids.length) await ctx.tx.insert(genedAreaCourse).values(ids.map((courseId) => ({ institutionId: ctx.caller.institutionId, areaId, courseId })));
  return toArea(area, ids);
}

/** A program's own minimum for a General education area; null returns it to the institution's. */
export async function setProgramGenedArea(ctx: Ctx, input: SetProgramGenedArea): Promise<{ minCredits: number | null }> {
  assertHuman(ctx);
  await loadProgram(ctx, input.programId);
  await assertPermitted(ctx, 'program:write', programScope(input.programId));
  if (!(await ctx.tx.select({ id: genedArea.id }).from(genedArea).where(eq(genedArea.id, input.areaId))).length) throw new NotFoundError(`GenEd area ${input.areaId}`);
  const same = and(eq(programGenedArea.programId, input.programId), eq(programGenedArea.areaId, input.areaId));
  if (input.minCredits === null) { await ctx.tx.delete(programGenedArea).where(same); return { minCredits: null }; }
  const [cur] = await ctx.tx.select().from(programGenedArea).where(same);
  if (cur) await ctx.tx.update(programGenedArea).set({ minCredits: String(input.minCredits) }).where(eq(programGenedArea.id, cur.id));
  else await ctx.tx.insert(programGenedArea).values({ institutionId: ctx.caller.institutionId, programId: input.programId, areaId: input.areaId, minCredits: String(input.minCredits) });
  return { minCredits: input.minCredits };
}

const SHORT: Record<RequirementBlock, string> = { general_education: 'General education', free_elective: 'Free electives', college: 'College', major: 'Major', concentration: 'Concentration' };

// ---- Concentrations ---------------------------------------------------------------------------------------------------------------

const toConcentration = (r: typeof concentration.$inferSelect): Concentration => ({ id: r.id, programId: r.programId, code: r.code, nameEn: r.nameEn, nameAr: r.nameAr, displayOrder: r.displayOrder, active: r.active });

export async function listConcentrations(ctx: Ctx, programId: string): Promise<Concentration[]> {
  return (await ctx.tx.select().from(concentration).where(eq(concentration.programId, programId)).orderBy(asc(concentration.displayOrder), asc(concentration.code))).map(toConcentration);
}
async function loadProgram(ctx: Ctx, id: string) {
  const [p] = await ctx.tx.select().from(program).where(eq(program.id, id));
  if (!p) throw new NotFoundError(`program ${id}`);
  return p;
}
export async function createConcentration(ctx: Ctx, input: CreateConcentration): Promise<Concentration> {
  assertHuman(ctx);
  await loadProgram(ctx, input.programId);
  await assertPermitted(ctx, 'program:write', programScope(input.programId));
  const [last] = await ctx.tx.select({ n: sql<number>`coalesce(max(${concentration.displayOrder}), -1)::int` }).from(concentration).where(eq(concentration.programId, input.programId));
  const [row] = await guardIntegrity(() => ctx.tx.insert(concentration).values({
    institutionId: ctx.caller.institutionId, programId: input.programId, code: nfc(input.code), nameEn: nfc(input.nameEn), nameAr: clean(input.nameAr), displayOrder: (last?.n ?? -1) + 1,
  }).returning());
  return toConcentration(row!);
}
export async function updateConcentration(ctx: Ctx, id: string, patch: UpdateConcentration): Promise<Concentration> {
  assertHuman(ctx);
  const [cur] = await ctx.tx.select().from(concentration).where(eq(concentration.id, id));
  if (!cur) throw new NotFoundError(`concentration ${id}`);
  await assertPermitted(ctx, 'program:write', programScope(cur.programId));
  const set: Partial<typeof concentration.$inferInsert> = {};
  if (patch.code !== undefined) set.code = nfc(patch.code);
  if (patch.nameEn !== undefined) set.nameEn = nfc(patch.nameEn);
  if (patch.nameAr !== undefined) set.nameAr = clean(patch.nameAr);
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.displayOrder !== undefined) set.displayOrder = patch.displayOrder;
  if (!Object.keys(set).length) return toConcentration(cur);
  const [row] = await guardIntegrity(() => ctx.tx.update(concentration).set(set).where(eq(concentration.id, id)).returning());
  return toConcentration(row!);
}
/** Deletes a concentration nobody uses; one with courses, slots or credits in it is deactivated instead. */
export async function deleteConcentration(ctx: Ctx, id: string): Promise<{ deleted: boolean; concentration: Concentration }> {
  assertHuman(ctx);
  const [cur] = await ctx.tx.select().from(concentration).where(eq(concentration.id, id));
  if (!cur) throw new NotFoundError(`concentration ${id}`);
  await assertPermitted(ctx, 'program:write', programScope(cur.programId));
  const used = (await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(courseProgramConcentration).where(eq(courseProgramConcentration.concentrationId, id)))[0]!.n
    + (await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(studyPlanSlot).where(eq(studyPlanSlot.concentrationId, id)))[0]!.n
    + (await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(programBlock).where(eq(programBlock.concentrationId, id)))[0]!.n;
  if (used) {
    const [row] = await ctx.tx.update(concentration).set({ active: false }).where(eq(concentration.id, id)).returning();
    return { deleted: false, concentration: toConcentration(row!) };
  }
  await ctx.tx.delete(concentration).where(eq(concentration.id, id));
  return { deleted: true, concentration: toConcentration(cur) };
}

// ---- Block credits and slots (a program's) -----------------------------------------------------------------------------------------

async function assertConcentration(ctx: Ctx, programId: string, concentrationId: string | null | undefined) {
  if (!concentrationId) return;
  const [c] = await ctx.tx.select({ programId: concentration.programId }).from(concentration).where(eq(concentration.id, concentrationId));
  if (!c || c.programId !== programId) throw new ValidationError('the concentration does not belong to this program');
}
const toBlock = (r: typeof programBlock.$inferSelect): ProgramBlock => ({ id: r.id, programId: r.programId, concentrationId: r.concentrationId, block: r.block, requirement: r.requirement, credits: Number(r.credits) });

/** Sets the credits a program (or one concentration) asks of a block, core or elective; null clears it. */
export async function setProgramBlock(ctx: Ctx, input: SetProgramBlock): Promise<ProgramBlock | null> {
  assertHuman(ctx);
  await loadProgram(ctx, input.programId);
  await assertPermitted(ctx, 'program:write', programScope(input.programId));
  const concentrationId = input.concentrationId ?? null;
  if ((input.block === 'concentration') !== (concentrationId !== null)) throw new ValidationError(input.block === 'concentration' ? 'the concentration block belongs to a concentration' : 'only the concentration block belongs to a concentration');
  await assertConcentration(ctx, input.programId, concentrationId);
  const same = and(eq(programBlock.programId, input.programId), eq(programBlock.block, input.block), eq(programBlock.requirement, input.requirement),
    concentrationId ? eq(programBlock.concentrationId, concentrationId) : sql`${programBlock.concentrationId} is null`);
  if (input.credits === null || input.credits === undefined) { await ctx.tx.delete(programBlock).where(same); return null; }
  const [cur] = await ctx.tx.select().from(programBlock).where(same);
  const [row] = cur
    ? await ctx.tx.update(programBlock).set({ credits: String(input.credits) }).where(eq(programBlock.id, cur.id)).returning()
    : await ctx.tx.insert(programBlock).values({ institutionId: ctx.caller.institutionId, programId: input.programId, concentrationId, block: input.block, requirement: input.requirement, credits: String(input.credits) }).returning();
  return toBlock(row!);
}

const toSlot = (r: typeof studyPlanSlot.$inferSelect): StudySlot => ({
  id: r.id, programId: r.programId, concentrationId: r.concentrationId, block: r.block, requirement: r.requirement, areaId: r.areaId, name: r.name, rule: r.rule, credits: Number(r.credits), year: r.year, term: r.term,
});
async function assertArea(ctx: Ctx, areaId: string | null | undefined) {
  if (areaId && !(await ctx.tx.select({ id: genedArea.id }).from(genedArea).where(eq(genedArea.id, areaId))).length) throw new ValidationError('no such General Education area');
}
export async function createStudySlot(ctx: Ctx, input: CreateStudySlot): Promise<StudySlot> {
  assertHuman(ctx);
  await loadProgram(ctx, input.programId);
  await assertPermitted(ctx, 'program:write', programScope(input.programId));
  await assertConcentration(ctx, input.programId, input.concentrationId);
  await assertArea(ctx, input.areaId);
  const [row] = await ctx.tx.insert(studyPlanSlot).values({
    institutionId: ctx.caller.institutionId, programId: input.programId, concentrationId: input.concentrationId ?? null, block: input.block, requirement: input.requirement ?? 'elective', areaId: input.areaId ?? null,
    name: nfc(input.name), rule: clean(input.rule), credits: String(input.credits), year: input.year ?? null, term: input.term ?? null,
  }).returning();
  return toSlot(row!);
}
export async function updateStudySlot(ctx: Ctx, id: string, patch: UpdateStudySlot): Promise<StudySlot> {
  assertHuman(ctx);
  const [cur] = await ctx.tx.select().from(studyPlanSlot).where(eq(studyPlanSlot.id, id));
  if (!cur) throw new NotFoundError(`study plan slot ${id}`);
  await assertPermitted(ctx, 'program:write', programScope(cur.programId));
  if (patch.concentrationId !== undefined) await assertConcentration(ctx, cur.programId, patch.concentrationId);
  if (patch.areaId !== undefined) await assertArea(ctx, patch.areaId);
  const set: Partial<typeof studyPlanSlot.$inferInsert> = {};
  if (patch.concentrationId !== undefined) set.concentrationId = patch.concentrationId;
  if (patch.block !== undefined) set.block = patch.block;
  if (patch.requirement !== undefined) set.requirement = patch.requirement;
  if (patch.areaId !== undefined) set.areaId = patch.areaId;
  if (patch.name !== undefined) set.name = nfc(patch.name);
  if (patch.rule !== undefined) set.rule = clean(patch.rule);
  if (patch.credits !== undefined) set.credits = String(patch.credits);
  if (patch.year !== undefined) set.year = patch.year;
  if (patch.term !== undefined) set.term = patch.term;
  if (!Object.keys(set).length) return toSlot(cur);
  const [row] = await ctx.tx.update(studyPlanSlot).set(set).where(eq(studyPlanSlot.id, id)).returning();
  return toSlot(row!);
}
export async function deleteStudySlot(ctx: Ctx, id: string): Promise<{ deleted: true }> {
  assertHuman(ctx);
  const [cur] = await ctx.tx.select().from(studyPlanSlot).where(eq(studyPlanSlot.id, id));
  if (!cur) throw new NotFoundError(`study plan slot ${id}`);
  await assertPermitted(ctx, 'program:write', programScope(cur.programId));
  await ctx.tx.delete(studyPlanSlot).where(eq(studyPlanSlot.id, id));
  return { deleted: true };
}

// ---- A program's requirements and their checks ---------------------------------------------------------------------------------------

const r1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => String(r1(n));

/**
 * What a program asks and what its study plan holds, and the checks: General Education equals the institution's credits and every area meets its
 * minimum; each block holds the credits asked of it; the common blocks plus any one concentration equal the program's credits. A minor has no
 * General Education. A service course counts as core. Flagged, never refused.
 */
export async function getProgramRequirements(ctx: Ctx, programId: string): Promise<ProgramRequirements> {
  const p = await loadProgram(ctx, programId);
  const [concentrations, blocks, slots, settings] = [await listConcentrations(ctx, programId), (await ctx.tx.select().from(programBlock).where(eq(programBlock.programId, programId))).map(toBlock),
    (await ctx.tx.select().from(studyPlanSlot).where(eq(studyPlanSlot.programId, programId)).orderBy(asc(studyPlanSlot.year), asc(studyPlanSlot.term), asc(studyPlanSlot.name))).map(toSlot), await getCatalogSettings(ctx)];
  const links = await ctx.tx.select({ cp: courseProgram, c: course }).from(courseProgram).innerJoin(course, eq(course.id, courseProgram.courseId)).where(eq(courseProgram.programId, programId));
  const areas = await ctx.tx.select().from(genedArea).where(eq(genedArea.active, true)).orderBy(asc(genedArea.displayOrder), asc(genedArea.code));
  const pools = areas.length ? await ctx.tx.select().from(genedAreaCourse) : [];
  const areaIdsOf = (courseId: string) => pools.filter((x) => x.courseId === courseId).map((x) => x.areaId);
  const concsOf = links.length ? await ctx.tx.select().from(courseProgramConcentration).where(inArray(courseProgramConcentration.courseProgramId, links.map((l) => l.cp.id))) : [];
  const courses = links.map(({ cp, c }) => ({
    courseId: c.id, code: c.code, titleEn: c.titleEn, credits: num(c.credits), role: cp.role, block: cp.block, concentrationIds: concsOf.filter((x) => x.courseProgramId === cp.id).map((x) => x.concentrationId), year: cp.year, term: cp.term, areaIds: areaIdsOf(c.id),
  })).sort((a, b) => (a.year ?? 99) - (b.year ?? 99) || (a.term ?? 99) - (b.term ?? 99) || a.code.localeCompare(b.code, 'en', { numeric: true }));

  // Planned credits per (concentration, block, requirement): courses (service counts as core) and slots.
  const key = (c: string | null, b: RequirementBlock, r: RequirementKind) => `${c ?? ''}|${b}|${r}`;
  const planned = new Map<string, number>();
  const add = (c: string | null, b: RequirementBlock | null, r: RequirementKind, credits: number) => { if (b) planned.set(key(c, b, r), (planned.get(key(c, b, r)) ?? 0) + credits); };
  // A course of several concentrations counts toward each (a student follows one); one of none counts for every student.
  for (const c of courses) for (const k of c.concentrationIds.length ? c.concentrationIds : [null]) add(k, c.block, c.role === 'elective' ? 'elective' : 'core', c.credits ?? 0);
  for (const s of slots) add(s.concentrationId, s.block, s.requirement, s.credits);
  const target = new Map(blocks.map((b) => [key(b.concentrationId, b.block, b.requirement), b.credits]));
  const keys = new Set([...planned.keys(), ...target.keys()]);
  const totals: BlockTotal[] = [...keys].map((k) => {
    const [c, b, r] = k.split('|') as [string, RequirementBlock, RequirementKind];
    return { concentrationId: c || null, block: b, requirement: r, target: target.get(k) ?? null, planned: r1(planned.get(k) ?? 0) };
  }).sort((a, b) => REQUIREMENT_BLOCKS.indexOf(a.block) - REQUIREMENT_BLOCKS.indexOf(b.block) || REQUIREMENT_KINDS.indexOf(a.requirement) - REQUIREMENT_KINDS.indexOf(b.requirement));

  const issues: RequirementIssue[] = [];
  const minor = p.programType === 'minor';
  const concName = (id: string | null) => (id ? concentrations.find((c) => c.id === id)?.nameEn ?? 'a concentration' : null);
  // Courses that sit in no block cannot be counted.
  const unplaced = courses.filter((c) => !c.block);
  if (unplaced.length) issues.push({ kind: 'unplaced_course', message: `${unplaced.length} course${unplaced.length === 1 ? ' is' : 's are'} in no block of the requirements (${unplaced.slice(0, 4).map((c) => c.code).join(', ')}${unplaced.length > 4 ? '…' : ''}): they are not counted.`, concentrationId: null, block: null });
  // Each block's credits against what is asked of it.
  for (const t of totals) {
    if (t.target !== null && r1(t.target) !== t.planned) issues.push({ kind: 'block_credits', message: `${t.concentrationId ? `${concName(t.concentrationId)}: ` : ''}${SHORT[t.block]} ${t.requirement} credits: ${fmt(t.planned)} planned, ${fmt(t.target)} asked.`, concentrationId: t.concentrationId, block: t.block });
  }
  // General Education and Free electives: the program's own credits, else the institution's; each area's minimum, the program's own else the institution's.
  const blockPlanned = (b: RequirementBlock) => (planned.get(key(null, b, 'core')) ?? 0) + (planned.get(key(null, b, 'elective')) ?? 0);
  const geTotal = blockPlanned('general_education');
  const genedOwn = p.genedCredits === null ? null : Number(p.genedCredits);
  const freeOwn = p.freeElectiveCredits === null ? null : Number(p.freeElectiveCredits);
  const genedCredits = genedOwn ?? settings.genedCredits;
  const freeElectiveCredits = freeOwn ?? settings.freeElectiveCredits;
  const who = (own: number | null) => (own !== null ? 'the program asks' : 'the institution asks');
  if (!minor && genedCredits !== null && (geTotal > 0 || courses.length) && r1(geTotal) !== r1(genedCredits)) issues.push({ kind: 'gened_total', message: `General education: ${fmt(geTotal)} credits planned, ${who(genedOwn)} ${fmt(genedCredits)}.`, concentrationId: null, block: 'general_education' });
  const freeTotal = blockPlanned('free_elective');
  if (!minor && freeElectiveCredits !== null && (freeTotal > 0 || courses.length) && r1(freeTotal) !== r1(freeElectiveCredits)) issues.push({ kind: 'free_elective_total', message: `Free electives: ${fmt(freeTotal)} credits planned, ${who(freeOwn)} ${fmt(freeElectiveCredits)}.`, concentrationId: null, block: 'free_elective' });
  const ownMin = new Map((await ctx.tx.select().from(programGenedArea).where(eq(programGenedArea.programId, programId))).map((x) => [x.areaId, Number(x.minCredits)]));
  const areaRows = areas.map((a) => {
    const fromCourses = courses.filter((c) => c.block === 'general_education' && c.areaIds.includes(a.id)).reduce((n, c) => n + (c.credits ?? 0), 0);
    const fromSlots = slots.filter((s) => s.block === 'general_education' && s.areaId === a.id).reduce((n, s) => n + s.credits, 0);
    const defaultMin = Number(a.minCredits);
    return { id: a.id, code: a.code, nameEn: a.nameEn, nameAr: a.nameAr, minCredits: ownMin.get(a.id) ?? defaultMin, defaultMin, overridden: ownMin.has(a.id), displayOrder: a.displayOrder, active: a.active, planned: r1(fromCourses + fromSlots) };
  });
  if (!minor) for (const a of areaRows) if (a.minCredits > 0 && a.planned < a.minCredits && (geTotal > 0 || courses.length)) issues.push({ kind: 'gened_area', message: `General education, ${a.nameEn}: ${fmt(a.planned)} credits planned, at least ${fmt(a.minCredits)} asked.`, concentrationId: null, block: 'general_education' });
  // The degree's credits: the common blocks plus any one concentration.
  if (p.credits !== null && (courses.length || slots.length)) {
    const common = totals.filter((t) => !t.concentrationId && t.block !== 'concentration').reduce((n, t) => n + t.planned, 0);
    const own = (id: string) => totals.filter((t) => t.concentrationId === id).reduce((n, t) => n + t.planned, 0);
    const active = concentrations.filter((c) => c.active);
    if (!active.length) { if (r1(common) !== p.credits) issues.push({ kind: 'total_credits', message: `The blocks add up to ${fmt(common)} credits, the program has ${p.credits}.`, concentrationId: null, block: null }); }
    for (const c of active) {
      if (own(c.id) === 0) issues.push({ kind: 'no_concentration_credits', message: `${c.nameEn} has no courses or credits of its own.`, concentrationId: c.id, block: 'concentration' });
      else if (r1(common + own(c.id)) !== p.credits) issues.push({ kind: 'total_credits', message: `With ${c.nameEn}, the blocks add up to ${fmt(common + own(c.id))} credits, the program has ${p.credits}.`, concentrationId: c.id, block: null });
    }
  }
  // Requisites: each prerequisite group needs one of its courses in this study plan, placed before the course; and no cycles.
  await requisiteIssues(ctx, courses, issues);
  return {
    programId, programType: p.programType, credits: p.credits,
    genedCredits, genedDefault: settings.genedCredits, genedOverridden: genedOwn !== null, freeElectiveCredits, freeElectiveDefault: settings.freeElectiveCredits, freeElectiveOverridden: freeOwn !== null,
    concentrations, blocks, slots, courses, areas: areaRows, totals, issues };
}

/** Throws unless the course is in the program's study plan (used where a block or a concentration is set for it). */
export async function assertInStudyPlan(ctx: Ctx, courseId: string, programId: string): Promise<void> {
  const [row] = await ctx.tx.select({ id: courseProgram.id }).from(courseProgram).where(and(eq(courseProgram.courseId, courseId), eq(courseProgram.programId, programId)));
  if (!row) throw new ConflictError('the course is not in this program\'s study plan');
}

type PlanRow = { courseId: string; code: string; year: number | null; term: number | null };

/** The prerequisites of the program's courses against its study plan (missing, not before) and the cycles among them. Flagged, never refused. */
async function requisiteIssues(ctx: Ctx, plan: PlanRow[], issues: RequirementIssue[]): Promise<void> {
  if (!plan.length) return;
  const rows = await ctx.tx.select().from(courseRequisite).where(eq(courseRequisite.kind, 'prerequisite'));
  if (!rows.length) return;
  const codes = new Map((await ctx.tx.select({ id: course.id, code: course.code }).from(course)).map((c) => [c.id, c.code]));
  const groupsOf = (courseId: string): string[][] => {
    const out: string[][] = []; const byNo = new Map<number, string[]>();
    for (const r of rows.filter((x) => x.courseId === courseId)) {
      if (r.groupNo === null) { out.push([r.requisiteId]); continue; }
      let g = byNo.get(r.groupNo); if (!g) { g = []; byNo.set(r.groupNo, g); out.push(g); }
      g.push(r.requisiteId);
    }
    return out;
  };
  const when = (r: PlanRow) => (r.year ?? 0) * 10 + (r.term ?? 0);
  const placed = (r: PlanRow) => r.year !== null;
  const byId = new Map(plan.map((p) => [p.courseId, p]));
  const names = (ids: string[]) => ids.map((id) => codes.get(id) ?? '?').join(' or ');
  for (const c of plan) {
    for (const g of groupsOf(c.courseId)) {
      const inPlan = g.map((id) => byId.get(id)).filter((x): x is PlanRow => !!x);
      if (!inPlan.length) { issues.push({ kind: 'requisite_missing', message: `${c.code} needs ${names(g)}, which ${g.length > 1 ? 'are' : 'is'} not in this study plan.`, concentrationId: null, block: null }); continue; }
      if (placed(c) && inPlan.every(placed) && !inPlan.some((r) => when(r) < when(c))) {
        issues.push({ kind: 'requisite_order', message: `${c.code} (year ${c.year}${c.term ? ` term ${c.term}` : ''}) needs ${names(g)} first, but ${inPlan.length > 1 ? 'they are' : `${inPlan[0]!.code} is`} not earlier in the plan.`, concentrationId: null, block: null });
      }
    }
  }
  // A cycle: a course that can be reached from itself through prerequisites.
  const next = (id: string) => rows.filter((r) => r.courseId === id).map((r) => r.requisiteId);
  const reported = new Set<string>();
  for (const c of plan) {
    const seen = new Set<string>(); const stack = next(c.courseId);
    while (stack.length) {
      const id = stack.pop()!;
      if (id === c.courseId) {
        if (!reported.has(c.code)) { reported.add(c.code); issues.push({ kind: 'requisite_cycle', message: `${c.code} is its own prerequisite, through a chain of prerequisites.`, concentrationId: null, block: null }); }
        break;
      }
      if (seen.has(id)) continue;
      seen.add(id); stack.push(...next(id));
    }
  }
}
