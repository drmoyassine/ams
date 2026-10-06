import { asc, eq } from 'drizzle-orm';
import { orgUnit, program } from '@ams/db';
import type { CreateProgram, Program, UpdateProgram } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';

const toProgram = (r: typeof program.$inferSelect): Program => ({
  id: r.id, orgUnitId: r.orgUnitId, nameEn: r.nameEn, nameAr: r.nameAr, degreeLevel: r.degreeLevel,
  discipline: r.discipline, tags: r.tags, active: r.active,
});

/** Row-level security returns only the programs the caller's roles cover. */
export async function listPrograms(ctx: Ctx): Promise<Program[]> {
  const rows = await ctx.tx.select().from(program).orderBy(asc(program.nameEn));
  return rows.map(toProgram);
}

export async function createProgram(ctx: Ctx, input: CreateProgram): Promise<Program> {
  await assertPermitted(ctx, 'program:write', { type: 'org_unit', id: input.orgUnitId });
  const [row] = await ctx.tx.insert(program).values({
    institutionId: ctx.caller.institutionId,
    orgUnitId: input.orgUnitId,
    nameEn: input.nameEn,
    nameAr: input.nameAr,
    degreeLevel: input.degreeLevel,
    discipline: input.discipline,
    tags: input.tags,
  }).returning();
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
  if (Object.keys(set).length === 0) return toProgram(current);
  const [row] = await ctx.tx.update(program).set(set).where(eq(program.id, id)).returning();
  return toProgram(row!);
}
