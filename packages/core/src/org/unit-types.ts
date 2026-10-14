// The kinds of unit an institution's org chart has (college, school, department ...), as data (TASK-072). Every institution
// starts with five (the database seeds them); the "Unit types" manager adds, renames, reorders and removes. A unit refers
// to its type by `key`, which never changes, so renaming a type renames it everywhere at once, and a type that is in use
// cannot be removed (the database enforces it with a foreign key; the service says it in words first).
import { asc, eq, sql } from 'drizzle-orm';
import { orgUnit, orgUnitType } from '@ams/db';
import type { CreateOrgUnitType, OrgUnitType, ReorderOrgUnitTypes, UpdateOrgUnitType } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { reportUndo } from '../trash/store.js';

type Row = typeof orgUnitType.$inferSelect;
const nfc = (s: string) => s.normalize('NFC').trim();

/** Types are changed by whoever may write the organization at the institution level (they are shared by every unit). */
const assertMayChangeTypes = (ctx: Ctx) => assertPermitted(ctx, 'org:write', { type: 'institution' });

async function counts(ctx: Ctx): Promise<Map<string, number>> {
  const res = await ctx.tx.execute<{ type: string; n: number }>(sql`select type, count(*)::int as n from org_unit group by type`);
  return new Map(res.rows.map((r) => [r.type, r.n]));
}

const toDto = (r: Row, n: number): OrgUnitType => ({ id: r.id, key: r.key, labelEn: r.labelEn, labelAr: r.labelAr, displayOrder: r.displayOrder, unitCount: n });

async function rows(ctx: Ctx): Promise<Row[]> {
  return ctx.tx.select().from(orgUnitType).orderBy(asc(orgUnitType.displayOrder), asc(orgUnitType.labelEn), asc(orgUnitType.id));
}

/** The institution's unit types in order, each with the number of units that use it. */
export async function listOrgUnitTypes(ctx: Ctx): Promise<OrgUnitType[]> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  const n = await counts(ctx);
  return (await rows(ctx)).map((r) => toDto(r, n.get(r.key) ?? 0));
}

async function load(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.tx.select().from(orgUnitType).where(eq(orgUnitType.id, id));
  if (!row) throw new NotFoundError(`unit type ${id}`);
  return row;
}

/** Sets display_order 0, 1, 2 ... in the order given (only the rows that change are written). */
async function renumber(ctx: Ctx, ordered: Row[]): Promise<void> {
  for (const [i, r] of ordered.entries()) {
    if (r.displayOrder !== i) await ctx.tx.update(orgUnitType).set({ displayOrder: i }).where(eq(orgUnitType.id, r.id));
  }
}

/** A key from the English label: letters and digits, lower case, underscores ("Research centre" -> research_centre). */
export function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '').slice(0, 40) || 'type';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

export async function createOrgUnitType(ctx: Ctx, input: CreateOrgUnitType): Promise<OrgUnitType> {
  assertHuman(ctx);
  await assertMayChangeTypes(ctx);
  const all = await rows(ctx);
  const labelEn = nfc(input.labelEn);
  if (all.some((t) => t.labelEn.toLowerCase() === labelEn.toLowerCase())) throw new ConflictError(`There is already a unit type called ${labelEn}.`);
  const taken = new Set(all.map((t) => t.key));
  if (input.key && taken.has(input.key)) throw new ConflictError(`There is already a unit type with the key ${input.key}.`);
  const key = input.key ?? keyFromLabel(labelEn, taken);
  const at = Math.min(input.index ?? all.length, all.length);
  const [row] = await guardIntegrity(() => ctx.tx.insert(orgUnitType).values({
    institutionId: ctx.caller.institutionId, key, labelEn, labelAr: input.labelAr ? nfc(input.labelAr) : null, displayOrder: at,
  }).returning());
  const ordered = [...all];
  ordered.splice(at, 0, row!);
  await renumber(ctx, ordered);
  // Undo removes it again (it is unused); its Redo adds it back with the same key.
  reportUndo(ctx, { label: `Added the unit type ${labelEn}`, method: 'DELETE', path: `/api/org-unit-types/${row!.id}` });
  return toDto({ ...row!, displayOrder: at }, 0);
}

/** Rename (English and Arabic label). The key never changes, so every unit shows the new name at once. */
export async function updateOrgUnitType(ctx: Ctx, id: string, patch: UpdateOrgUnitType): Promise<OrgUnitType> {
  assertHuman(ctx);
  await assertMayChangeTypes(ctx);
  const cur = await load(ctx, id);
  const set: Partial<typeof orgUnitType.$inferInsert> = {};
  if (patch.labelEn !== undefined && nfc(patch.labelEn) !== cur.labelEn) {
    const labelEn = nfc(patch.labelEn);
    if ((await rows(ctx)).some((t) => t.id !== id && t.labelEn.toLowerCase() === labelEn.toLowerCase())) throw new ConflictError(`There is already a unit type called ${labelEn}.`);
    set.labelEn = labelEn;
  }
  if (patch.labelAr !== undefined) {
    const labelAr = patch.labelAr ? nfc(patch.labelAr) : null;
    if (labelAr !== cur.labelAr) set.labelAr = labelAr;
  }
  const n = (await counts(ctx)).get(cur.key) ?? 0;
  if (Object.keys(set).length === 0) return toDto(cur, n);
  const [row] = await ctx.tx.update(orgUnitType).set(set).where(eq(orgUnitType.id, id)).returning();
  reportUndo(ctx, {
    label: `Renamed the unit type ${cur.labelEn}`, method: 'PATCH', path: `/api/org-unit-types/${id}`,
    body: { ...(set.labelEn !== undefined ? { labelEn: cur.labelEn } : {}), ...(set.labelAr !== undefined ? { labelAr: cur.labelAr } : {}) },
  });
  return toDto(row!, n);
}

/** Moves a type to a new place in the list: `ids` is the whole list in the new order. */
export async function reorderOrgUnitTypes(ctx: Ctx, input: ReorderOrgUnitTypes): Promise<OrgUnitType[]> {
  assertHuman(ctx);
  await assertMayChangeTypes(ctx);
  const all = await rows(ctx);
  const byId = new Map(all.map((t) => [t.id, t] as const));
  if (input.ids.length !== all.length || new Set(input.ids).size !== all.length || input.ids.some((i) => !byId.has(i))) {
    throw new ValidationError('give every unit type exactly once');
  }
  const ordered = input.ids.map((i) => byId.get(i)!);
  const changed = ordered.some((t, i) => t.displayOrder !== i) || all.some((t, i) => all[i]!.id !== ordered[i]!.id);
  if (changed) {
    await renumber(ctx, ordered);
    reportUndo(ctx, { label: 'Reordered the unit types', method: 'POST', path: '/api/org-unit-types/reorder', body: { ids: all.map((t) => t.id) } });
  }
  const n = await counts(ctx);
  return ordered.map((t, i) => toDto({ ...t, displayOrder: i }, n.get(t.key) ?? 0));
}

/** Removes a type that no unit uses. A type in use says how many units use it; the last type cannot be removed. */
export async function removeOrgUnitType(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await assertMayChangeTypes(ctx);
  const cur = await load(ctx, id);
  const all = await rows(ctx);
  if (all.length <= 1) throw new ConflictError('An organization needs at least one unit type, so the last one cannot be removed.');
  const used = (await counts(ctx)).get(cur.key) ?? 0;
  if (used > 0) {
    const names = (await ctx.tx.select({ n: orgUnit.nameEn }).from(orgUnit).where(eq(orgUnit.type, cur.key)).orderBy(asc(orgUnit.nameEn)).limit(3)).map((r) => r.n);
    throw new ConflictError(`${cur.labelEn} is used by ${used} unit${used === 1 ? '' : 's'} (${names.join(', ')}${used > names.length ? ', ...' : ''}). Change their type first; a type can be removed only when no unit uses it.`,
      { code: 'type_in_use', units: used });
  }
  await guardIntegrity(() => ctx.tx.delete(orgUnitType).where(eq(orgUnitType.id, id)));
  await renumber(ctx, all.filter((t) => t.id !== id));
  reportUndo(ctx, {
    label: `Removed the unit type ${cur.labelEn}`, method: 'POST', path: '/api/org-unit-types',
    body: { key: cur.key, labelEn: cur.labelEn, ...(cur.labelAr ? { labelAr: cur.labelAr } : {}), index: cur.displayOrder },
  });
}
