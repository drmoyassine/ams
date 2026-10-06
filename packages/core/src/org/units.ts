import { asc, eq } from 'drizzle-orm';
import { orgUnit, program } from '@ams/db';
import type { CreateOrgUnit, OrgUnit, Scope, UpdateOrgUnit } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';

type Row = typeof orgUnit.$inferSelect;
const toDto = (r: Row): OrgUnit => ({ id: r.id, parentId: r.parentId, type: r.type, nameEn: r.nameEn, nameAr: r.nameAr, active: r.active });
const scopeOf = (parentId: string | null): Scope => (parentId ? { type: 'org_unit', id: parentId } : { type: 'institution' });

/** The whole org chart as a flat list; the client builds the tree. Everyone in the institution can read it. */
export async function listOrgUnits(ctx: Ctx): Promise<OrgUnit[]> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const rows = await ctx.tx.select().from(orgUnit).orderBy(asc(orgUnit.nameEn));
  return rows.map(toDto);
}

async function load(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.tx.select().from(orgUnit).where(eq(orgUnit.id, id));
  if (!row) throw new NotFoundError(`org unit ${id}`);
  return row;
}

/** A unit is created under a parent (or at the top). Whoever may write there may add to it. */
export async function createOrgUnit(ctx: Ctx, input: CreateOrgUnit): Promise<OrgUnit> {
  assertHuman(ctx);
  if (input.parentId) {
    const parent = await load(ctx, input.parentId);
    if (!parent.active) throw new ConflictError('cannot add a unit under an inactive unit');
  }
  await assertPermitted(ctx, 'org:write', scopeOf(input.parentId));
  const [row] = await ctx.tx.insert(orgUnit).values({
    institutionId: ctx.caller.institutionId, parentId: input.parentId, type: input.type, nameEn: input.nameEn, nameAr: input.nameAr ?? null,
  }).returning();
  return toDto(row!);
}

/**
 * Rename, retype, move or deactivate. Moving needs write access at both the old and the new place and may not put a unit
 * under itself or one of its descendants. A unit with active sub-units or active programs cannot be deactivated.
 */
export async function updateOrgUnit(ctx: Ctx, id: string, patch: UpdateOrgUnit): Promise<OrgUnit> {
  assertHuman(ctx);
  const unit = await load(ctx, id);
  await assertPermitted(ctx, 'org:write', { type: 'org_unit', id });
  const set: Partial<typeof orgUnit.$inferInsert> = {};
  if (patch.nameEn !== undefined) set.nameEn = patch.nameEn;
  if (patch.nameAr !== undefined) set.nameAr = patch.nameAr || null;
  if (patch.type !== undefined) set.type = patch.type;

  if (patch.parentId !== undefined && patch.parentId !== unit.parentId) {
    if (patch.parentId) {
      const all = await ctx.tx.select().from(orgUnit);
      const byId = new Map(all.map((u) => [u.id, u]));
      if (!byId.has(patch.parentId)) throw new NotFoundError(`org unit ${patch.parentId}`);
      for (let p: string | null = patch.parentId; p; p = byId.get(p)?.parentId ?? null) {
        if (p === id) throw new ValidationError('a unit cannot be moved under itself or one of its own sub-units');
      }
      if (!byId.get(patch.parentId)!.active) throw new ConflictError('cannot move a unit under an inactive unit');
    }
    await assertPermitted(ctx, 'org:write', scopeOf(patch.parentId));
    set.parentId = patch.parentId;
  }

  if (patch.active === false && unit.active) {
    const children = (await ctx.tx.select().from(orgUnit).where(eq(orgUnit.parentId, id))).filter((c) => c.active);
    if (children.length) throw new ConflictError(`deactivate its sub-units first: ${children.map((c) => c.nameEn).join(', ')}`);
    const programs = (await ctx.tx.select().from(program).where(eq(program.orgUnitId, id))).filter((p) => p.active);
    if (programs.length) throw new ConflictError(`move or deactivate its programs first: ${programs.map((p) => p.nameEn).join(', ')}`);
    set.active = false;
  } else if (patch.active === true && !unit.active) {
    if (unit.parentId && !(await load(ctx, unit.parentId)).active) throw new ConflictError('reactivate its parent unit first');
    set.active = true;
  }
  if (Object.keys(set).length === 0) return toDto(unit);
  const [row] = await ctx.tx.update(orgUnit).set(set).where(eq(orgUnit.id, id)).returning();
  return toDto(row!);
}
