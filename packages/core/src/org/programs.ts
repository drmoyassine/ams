import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { learningOutcome, orgUnit, program } from '@ams/db';
import { programMissing, type CreateProgram, type Program, type UpdateProgram } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';

type Counts = Map<string, { peos: number; plos: number }>;
/** How many PEOs and PLOs (not retired) each program has, for what the record still lacks. */
async function outcomeCounts(ctx: Ctx, ids: string[]): Promise<Counts> {
  const out: Counts = new Map(ids.map((id) => [id, { peos: 0, plos: 0 }]));
  if (!ids.length) return out;
  const rows = await ctx.tx.select({ programId: learningOutcome.programId, kind: learningOutcome.kind, n: sql<number>`count(*)::int` }).from(learningOutcome)
    .where(and(inArray(learningOutcome.programId, ids), inArray(learningOutcome.kind, ['peo', 'plo']), sql`${learningOutcome.status} <> 'retired'`))
    .groupBy(learningOutcome.programId, learningOutcome.kind);
  for (const r of rows) { const c = out.get(r.programId!)!; if (r.kind === 'peo') c.peos = r.n; else c.plos = r.n; }
  return out;
}
async function withMissing(ctx: Ctx, rows: (typeof program.$inferSelect)[]): Promise<Program[]> {
  const counts = await outcomeCounts(ctx, rows.map((r) => r.id));
  return rows.map((r) => toProgram(r, counts.get(r.id)));
}

export const toProgram = (r: typeof program.$inferSelect, counts?: { peos: number; plos: number }): Program => {
  const p = {
  id: r.id, orgUnitId: r.orgUnitId, nameEn: r.nameEn, nameAr: r.nameAr, degreeLevel: r.degreeLevel,
  discipline: r.discipline, tags: r.tags, active: r.active,
  code: r.code, externalId: r.externalId, mission: r.mission, vision: r.vision, description: r.description, mode: r.mode,
  durationYears: r.durationYears === null ? null : Number(r.durationYears), credits: r.credits, languageOfInstruction: r.languageOfInstruction,
  campus: r.campus, startYear: r.startYear, contactHours: r.contactHours,
  };
  return { ...p, missing: counts ? programMissing(p, counts) : [] };
};

const FACTS = ['code', 'externalId', 'mission', 'vision', 'description', 'mode', 'durationYears', 'credits', 'contactHours', 'languageOfInstruction', 'campus', 'startYear'] as const;
/** The program-record fields of an input, NFC and trimmed; an empty string or null clears one. Only the keys present are returned. */
function factsOf(input: Partial<Record<(typeof FACTS)[number], unknown>>): Partial<typeof program.$inferInsert> {
  const set: Record<string, unknown> = {};
  for (const k of FACTS) {
    if (!(k in input) || input[k] === undefined) continue;
    const v = input[k];
    if (v === null || v === '') set[k] = null;
    else if (typeof v === 'string') set[k] = v.normalize('NFC').trim();
    else if (k === 'durationYears') set[k] = String(v);
    else set[k] = v;
  }
  return set as Partial<typeof program.$inferInsert>;
}

/** Row-level security returns only the programs the caller's roles cover. */
export async function listPrograms(ctx: Ctx): Promise<Program[]> {
  const rows = await ctx.tx.select().from(program).orderBy(asc(program.nameEn));
  return withMissing(ctx, rows);
}

/** One program (row-level security decides whether the caller sees it). */
export async function getProgram(ctx: Ctx, id: string): Promise<Program> {
  const [row] = await ctx.tx.select().from(program).where(eq(program.id, id));
  if (!row) throw new NotFoundError(`program ${id}`);
  return (await withMissing(ctx, [row]))[0]!;
}

/**
 * Deleting a program deactivates it: engagements, assessment results and the audit trail refer to it, so the record stays and can be
 * reactivated (the API's DELETE).
 */
export async function deleteProgram(ctx: Ctx, id: string): Promise<Program> {
  return updateProgram(ctx, id, { active: false });
}

export async function createProgram(ctx: Ctx, input: CreateProgram): Promise<Program> {
  await assertPermitted(ctx, 'program:write', { type: 'org_unit', id: input.orgUnitId });
  const [row] = await guardIntegrity(() => ctx.tx.insert(program).values({
    institutionId: ctx.caller.institutionId,
    orgUnitId: input.orgUnitId,
    nameEn: input.nameEn,
    nameAr: input.nameAr,
    degreeLevel: input.degreeLevel,
    discipline: input.discipline,
    tags: input.tags,
    ...factsOf(input),
  }).returning());
  return (await withMissing(ctx, [row!]))[0]!;
}

/**
 * Edits a program. Moving it to another org unit needs write access at the old and the new unit; a program cannot sit in,
 * or be reactivated under, an inactive unit.
 */
export async function updateProgram(ctx: Ctx, id: string, patch: UpdateProgram): Promise<Program> {
  assertHuman(ctx);
  const [current] = await ctx.tx.select().from(program).where(eq(program.id, id));
  if (!current) throw new NotFoundError(`program ${id}`);
  await assertPermitted(ctx, 'program:write', { type: 'program', id });
  const targetUnit = patch.orgUnitId ?? current.orgUnitId;
  if (patch.orgUnitId && patch.orgUnitId !== current.orgUnitId) await assertPermitted(ctx, 'program:write', { type: 'org_unit', id: patch.orgUnitId });
  if (patch.orgUnitId || patch.active === true) {
    const [unit] = await ctx.tx.select().from(orgUnit).where(eq(orgUnit.id, targetUnit));
    if (!unit) throw new NotFoundError(`org unit ${targetUnit}`);
    if (!unit.active) throw new ConflictError('a program cannot sit in an inactive unit');
  }
  const set: Partial<typeof program.$inferInsert> = {};
  if (patch.orgUnitId !== undefined) set.orgUnitId = patch.orgUnitId;
  if (patch.nameEn !== undefined) set.nameEn = patch.nameEn;
  if (patch.nameAr !== undefined) set.nameAr = patch.nameAr || null;
  if (patch.degreeLevel !== undefined) set.degreeLevel = patch.degreeLevel;
  if (patch.discipline !== undefined) set.discipline = patch.discipline || null;
  if (patch.tags !== undefined) set.tags = [...new Set(patch.tags)];
  if (patch.active !== undefined) set.active = patch.active;
  Object.assign(set, factsOf(patch));
  if (Object.keys(set).length === 0) return (await withMissing(ctx, [current]))[0]!;
  const [row] = await guardIntegrity(() => ctx.tx.update(program).set(set).where(eq(program.id, id)).returning());
  return (await withMissing(ctx, [row!]))[0]!;
}
