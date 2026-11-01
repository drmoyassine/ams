import { asc, eq } from 'drizzle-orm';
import { orgUnit, program } from '@ams/db';
import type { CreateProgram, Program, UpdateProgram } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';

export const toProgram = (r: typeof program.$inferSelect): Program => ({
  id: r.id, orgUnitId: r.orgUnitId, nameEn: r.nameEn, nameAr: r.nameAr, degreeLevel: r.degreeLevel,
  discipline: r.discipline, tags: r.tags, active: r.active,
  code: r.code, externalId: r.externalId, mission: r.mission, vision: r.vision, description: r.description, mode: r.mode,
  durationYears: r.durationYears === null ? null : Number(r.durationYears), credits: r.credits, languageOfInstruction: r.languageOfInstruction,
  campus: r.campus, startYear: r.startYear,
});

const FACTS = ['code', 'externalId', 'mission', 'vision', 'description', 'mode', 'durationYears', 'credits', 'languageOfInstruction', 'campus', 'startYear'] as const;
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
  return rows.map(toProgram);
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
  return toProgram(row!);
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
  if (Object.keys(set).length === 0) return toProgram(current);
  const [row] = await guardIntegrity(() => ctx.tx.update(program).set(set).where(eq(program.id, id)).returning());
  return toProgram(row!);
}
