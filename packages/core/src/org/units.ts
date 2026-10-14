// The org chart (TASK-072, docs/organization-plan.md E.1): units in a tree, each with a name in both languages, a type (one of
// the institution's own, see unit-types.ts), a head, a description, the programs that sit in it and a source (manual, image,
// directory) with a lock. Reading, creating and editing live here; moving is in unit-move.ts, deleting (to the Trash) and
// restoring in unit-trash.ts. Every mutation reports how to take it back (`reportUndo`), and the API sends it as X-Undo.
import { asc, eq, sql } from 'drizzle-orm';
import { appUser, orgUnit, orgUnitType, program } from '@ams/db';
import { depthUnder, ORG_MAX_DEPTH, treeOrder, type CreateOrgUnit, type OrgChart, type OrgUnit, type OrgUnitType, type Scope, type UpdateOrgUnit } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { reportUndo } from '../trash/store.js';
import { renumberChildren } from './unit-order.js';

export type UnitRow = typeof orgUnit.$inferSelect;
export const nfc = (s: string) => s.normalize('NFC').trim();
export const scopeOf = (parentId: string | null): Scope => (parentId ? { type: 'org_unit', id: parentId } : { type: 'institution' });

/** Everyone in the institution can read the org chart: units in tree order, with their programs and counts, and the unit types. */
export async function getOrgChart(ctx: Ctx): Promise<OrgChart> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const [units, typeRows, people, programs, members] = await Promise.all([
    ctx.tx.select().from(orgUnit),
    ctx.tx.select().from(orgUnitType).orderBy(asc(orgUnitType.displayOrder), asc(orgUnitType.labelEn), asc(orgUnitType.id)),
    ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser),
    ctx.tx.select({ id: program.id, unitId: program.orgUnitId, nameEn: program.nameEn, nameAr: program.nameAr, degreeLevel: program.degreeLevel, active: program.active }).from(program).orderBy(asc(program.nameEn)),
    // People who hold a role for exactly this unit (a role for a unit above it covers it too, but is not counted here).
    ctx.tx.execute<{ unit_id: string; n: number }>(sql`select scope_id as unit_id, count(distinct user_id)::int as n from role_assignment
      where scope_type = 'org_unit' and (expires_at is null or expires_at > now()) group by scope_id`),
  ]);
  const nameOf = new Map(people.map((p) => [p.id, p.name] as const));
  const memberOf = new Map(members.rows.map((m) => [m.unit_id, m.n] as const));
  const programsOf = new Map<string, typeof programs>();
  for (const p of programs) programsOf.set(p.unitId, [...(programsOf.get(p.unitId) ?? []), p]);
  const byId = new Map(units.map((u) => [u.id, u] as const));
  const order = treeOrder(units.map((u) => ({ id: u.id, parentId: u.parentId, displayOrder: u.displayOrder, code: u.nameEn })));
  const typeCount = new Map<string, number>();
  for (const u of units) typeCount.set(u.type, (typeCount.get(u.type) ?? 0) + 1);
  return {
    units: order.map((id) => {
      const u = byId.get(id)!;
      const ps = programsOf.get(id) ?? [];
      return {
        id: u.id, parentId: u.parentId, type: u.type, nameEn: u.nameEn, nameAr: u.nameAr, description: u.description, active: u.active,
        source: u.source, locked: u.locked, editedByPerson: u.editedByPerson, displayOrder: u.displayOrder,
        headUserId: u.headUserId, headName: u.headName, headUserName: u.headUserId ? (nameOf.get(u.headUserId) ?? null) : null,
        programCount: ps.length, memberCount: memberOf.get(u.id) ?? 0,
        programs: ps.map((p) => ({ id: p.id, nameEn: p.nameEn, nameAr: p.nameAr, degreeLevel: p.degreeLevel, active: p.active })),
      } satisfies OrgUnit;
    }),
    types: typeRows.map((t): OrgUnitType => ({ id: t.id, key: t.key, labelEn: t.labelEn, labelAr: t.labelAr, displayOrder: t.displayOrder, unitCount: typeCount.get(t.key) ?? 0 })),
  };
}

/** The units alone, in tree order (pickers elsewhere in the application use this). */
export async function listOrgUnits(ctx: Ctx): Promise<OrgUnit[]> {
  return (await getOrgChart(ctx)).units;
}

export async function loadUnit(ctx: Ctx, id: string): Promise<UnitRow> {
  const [row] = await ctx.tx.select().from(orgUnit).where(eq(orgUnit.id, id));
  if (!row) throw new NotFoundError(`org unit ${id}`);
  return row;
}

async function assertType(ctx: Ctx, key: string): Promise<void> {
  const [t] = await ctx.tx.select({ id: orgUnitType.id }).from(orgUnitType).where(eq(orgUnitType.key, key));
  if (!t) throw new ValidationError(`unknown unit type "${key}"; add it under Unit types first`);
}

async function assertPerson(ctx: Ctx, userId: string): Promise<void> {
  const [p] = await ctx.tx.select({ id: appUser.id, active: appUser.active }).from(appUser).where(eq(appUser.id, userId));
  if (!p) throw new ValidationError('the head must be a person of this institution');
  if (!p.active) throw new ConflictError('that person is inactive and cannot be made a head');
}

/**
 * A unit is created under a parent (or at the top), last among its siblings unless `index` says otherwise. Whoever may write
 * there may add to it. `source` is for imports and sync (they call this directly); a person's units are manual.
 */
export async function createOrgUnit(ctx: Ctx, input: CreateOrgUnit & { source?: 'manual' | 'image' | 'directory' }): Promise<OrgUnit> {
  assertHuman(ctx);
  const parent = input.parentId ? await loadUnit(ctx, input.parentId) : null;
  if (parent && !parent.active) throw new ConflictError('cannot add a unit under an inactive unit');
  await assertPermitted(ctx, 'org:write', scopeOf(input.parentId));
  await assertType(ctx, input.type);
  if (input.headUserId && input.headName) throw new ValidationError('give the head as a person or as a name, not both');
  if (input.headUserId) await assertPerson(ctx, input.headUserId);
  const all = await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, displayOrder: orgUnit.displayOrder, code: orgUnit.nameEn }).from(orgUnit);
  if (depthUnder(all, input.parentId) + 1 > ORG_MAX_DEPTH) throw new ConflictError(`The org chart can be at most ${ORG_MAX_DEPTH} levels deep.`);
  const siblings = all.filter((u) => (u.parentId ?? null) === input.parentId).sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
  const at = Math.min(input.index ?? siblings.length, siblings.length);
  const [row] = await guardIntegrity(() => ctx.tx.insert(orgUnit).values({
    institutionId: ctx.caller.institutionId, parentId: input.parentId, type: input.type, nameEn: nfc(input.nameEn), nameAr: input.nameAr ? nfc(input.nameAr) : null,
    description: input.description ? nfc(input.description) : null, headUserId: input.headUserId ?? null, headName: input.headName ? nfc(input.headName) : null,
    source: input.source ?? 'manual', displayOrder: at,
  }).returning());
  if (at < siblings.length) await renumberChildren(ctx, input.parentId, [...siblings.slice(0, at).map((s) => s.id), row!.id, ...siblings.slice(at).map((s) => s.id)]);
  reportUndo(ctx, { label: `Added ${row!.nameEn}`, method: 'DELETE', path: `/api/org-units/${row!.id}` });
  const chart = await getOrgChart(ctx);
  return chart.units.find((u) => u.id === row!.id)!;
}

/**
 * Edits a unit: names, type, description, head (a person, or a name when the head is not a user), lock and active. Moving
 * is `moveOrgUnits`, deleting goes to the Trash. A unit with active sub-units or active programs cannot be deactivated.
 * Reports an Undo that puts the earlier values back, so every field below has the same one.
 */
export async function updateOrgUnit(ctx: Ctx, id: string, patch: UpdateOrgUnit): Promise<OrgUnit> {
  assertHuman(ctx);
  const unit = await loadUnit(ctx, id);
  await assertPermitted(ctx, 'org:write', { type: 'org_unit', id });
  const set: Partial<typeof orgUnit.$inferInsert> = {};
  const before: Record<string, unknown> = {};
  const change = <K extends keyof UpdateOrgUnit & keyof UnitRow>(key: K, next: UnitRow[K]) => {
    if (next !== unit[key]) { (set as Record<string, unknown>)[key] = next; before[key] = unit[key]; }
  };
  if (patch.nameEn !== undefined) change('nameEn', nfc(patch.nameEn));
  if (patch.nameAr !== undefined) change('nameAr', patch.nameAr ? nfc(patch.nameAr) : null);
  if (patch.description !== undefined) change('description', patch.description ? nfc(patch.description) : null);
  if (patch.locked !== undefined) change('locked', patch.locked);
  if (patch.type !== undefined && patch.type !== unit.type) { await assertType(ctx, patch.type); change('type', patch.type); }

  // The head: a person or a name, never both. Setting one clears the other; null for both clears it.
  if (patch.headUserId !== undefined || patch.headName !== undefined) {
    let userId = patch.headUserId === undefined ? unit.headUserId : patch.headUserId;
    let name = patch.headName === undefined ? unit.headName : (patch.headName ? nfc(patch.headName) : null);
    if (patch.headUserId && patch.headName) throw new ValidationError('give the head as a person or as a name, not both');
    if (patch.headUserId) name = null;
    else if (patch.headName) userId = null;
    if (userId && userId !== unit.headUserId) await assertPerson(ctx, userId);
    change('headUserId', userId);
    change('headName', name);
    if ('headUserId' in set || 'headName' in set) { before.headUserId = unit.headUserId; before.headName = unit.headName; set.headUserId = userId; set.headName = name; }
  }

  if (patch.active === false && unit.active) {
    const children = (await ctx.tx.select().from(orgUnit).where(eq(orgUnit.parentId, id))).filter((c) => c.active);
    if (children.length) throw new ConflictError(`deactivate its sub-units first: ${children.map((c) => c.nameEn).join(', ')}`);
    const programs = (await ctx.tx.select().from(program).where(eq(program.orgUnitId, id))).filter((p) => p.active);
    if (programs.length) throw new ConflictError(`move or deactivate its programs first: ${programs.map((p) => p.nameEn).join(', ')}`);
    change('active', false);
  } else if (patch.active === true && !unit.active) {
    if (unit.parentId && !(await loadUnit(ctx, unit.parentId)).active) throw new ConflictError('reactivate its parent unit first');
    change('active', true);
  }

  if (Object.keys(set).length > 0) {
    await guardIntegrity(() => ctx.tx.update(orgUnit).set(set).where(eq(orgUnit.id, id)));
    const keys = Object.keys(set);
    const label = keys.length === 1 && keys[0] === 'locked' ? `${set.locked ? 'Locked' : 'Unlocked'} ${unit.nameEn}`
      : keys.every((k) => k === 'headUserId' || k === 'headName') ? `Changed the head of ${unit.nameEn}`
      : keys.length === 1 && keys[0] === 'type' ? `Changed the type of ${unit.nameEn}`
      : keys.length === 1 && keys[0] === 'active' ? `${set.active ? 'Reactivated' : 'Deactivated'} ${unit.nameEn}`
      : `Edited ${unit.nameEn}`;
    reportUndo(ctx, { label, method: 'PATCH', path: `/api/org-units/${id}`, body: before });
  }
  const chart = await getOrgChart(ctx);
  return chart.units.find((u) => u.id === id)!;
}
