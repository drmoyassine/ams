import { asc } from 'drizzle-orm';
import { program } from '@ams/db';
import type { CreateProgram, Program } from '@ams/shared';
import type { Ctx } from '../ctx.js';
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
