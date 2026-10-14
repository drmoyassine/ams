// Deleting org units to the Trash and putting them back (DEC-026, TASK-072). A delete snapshots the unit and everything
// under it (`trash_item`, kind `org_unit`, original ids) and deletes the rows, in one transaction. The rules:
//  * a unit that still has programs attached (or has a sub-unit that does) is NOT deleted: the refusal lists the programs and
//    says to move or reassign them first (programs are the thing accreditation hangs from; they are never deleted as a side effect);
//  * evidence items that name a deleted unit as their owner lose that owner (a foreign key would otherwise stop the delete);
//    the snapshot remembers it and a restore gives it back;
//  * role assignments scoped to a deleted unit are left alone (they have no foreign key); they cover nothing while the unit
//    is gone and work again when it comes back;
//  * restore brings the subtree back with the same ids. A missing parent is not guessed at: a 409 with the choice (under the
//    nearest ancestor that still exists, or at the top level). Names may repeat (no uniqueness), so nothing is ever renamed.
//    A unit type removed in the meantime is added back from the snapshot. The unit returns to its old place in the list
//    (or last, when it is put somewhere else), and the lists are renumbered gap-free.
import { sql } from 'drizzle-orm';
import { orgUnitType } from '@ams/db';
import { descendantIds, plural, topmostIds, treeOrder, type DeletePreview, type DeleteResult, type RestoreChoice, type RestoreOptions } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';
import { deleteRows, emptyPayload, existing, idsOf, insertRows, readRows, uuids, type Row, type TrashPayload, type TrashRef } from '../trash/rows.js';
import { reportUndo, restoreUndo, TRASH_RETENTION_DAYS, writeTrash, type NewTrashItem } from '../trash/store.js';
import { closeGaps, renumberChildren } from './unit-order.js';
import { scopeOf } from './units.js';

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const short = (names: string[], n = 5) => `${names.slice(0, n).join(', ')}${names.length > n ? ` and ${names.length - n} more` : ''}`;

interface RootPlan {
  rootId: string; parentId: string | null; displayOrder: number; sortKey: number; ids: string[]; name: string; parentName: string | null;
  ancestors: { id: string; name: string }[]; typeKeys: string[];
}
interface Plan { roots: RootPlan[]; subUnits: number }

/** What deleting these units would remove; refuses (nothing is written) when programs are still attached or the caller may not. */
async function planDelete(ctx: Ctx, rawIds: string[]): Promise<Plan> {
  const ids = [...new Set(rawIds)];
  if (!ids.length) throw new ValidationError('choose what to delete');
  const all = await readRows(ctx, 'org_unit', (await ctx.tx.execute<{ id: string }>(sql`select id from org_unit`)).rows.map((r) => r.id));
  const tree = all.map((r) => ({ id: text(r.id), parentId: typeof r.parent_id === 'string' ? r.parent_id : null, displayOrder: Number(r.display_order), code: text(r.name_en) }));
  const byId = new Map(all.map((r) => [text(r.id), r] as const));
  const missing = ids.find((i) => !byId.has(i));
  if (missing) throw new NotFoundError(`org unit ${missing}`);
  const order = treeOrder(tree);
  const roots: RootPlan[] = [];
  for (const rootId of topmostIds(tree, ids)) {
    await assertPermitted(ctx, 'org:write', { type: 'org_unit', id: rootId });
    const root = byId.get(rootId)!;
    const sub = new Set(descendantIds(tree, rootId));
    const idsInOrder = [rootId, ...order.filter((i) => sub.has(i))];
    const ancestors: { id: string; name: string }[] = [];
    for (let p = typeof root.parent_id === 'string' ? root.parent_id : null, n = 0; p && n < 50; p = typeof byId.get(p)?.parent_id === 'string' ? (byId.get(p)!.parent_id as string) : null, n += 1) {
      ancestors.push({ id: p, name: text(byId.get(p)?.name_en) });
    }
    roots.push({
      rootId, parentId: typeof root.parent_id === 'string' ? root.parent_id : null, displayOrder: Number(root.display_order), sortKey: order.indexOf(rootId),
      ids: idsInOrder, name: text(root.name_en), parentName: ancestors[0]?.name ?? null, ancestors, typeKeys: [...new Set(idsInOrder.map((i) => text(byId.get(i)!.type)))],
    });
  }
  // Programs are never deleted with a unit: list them and stop.
  const everyId = roots.flatMap((r) => r.ids);
  const programs = (await ctx.tx.execute<{ id: string; name_en: string; unit_id: string; unit_name: string }>(sql`
    select p.id, p.name_en, p.org_unit_id as unit_id, u.name_en as unit_name from program p join org_unit u on u.id = p.org_unit_id
    where p.org_unit_id = any(${uuids(everyId)}) order by u.name_en, p.name_en`)).rows;
  if (programs.length) {
    const names = programs.map((p) => `${p.name_en} (in ${p.unit_name})`);
    const subject = roots.length === 1 ? roots[0]!.name : plural(roots.length, 'unit');
    throw new ConflictError(
      `Cannot delete ${subject}: ${plural(programs.length, 'program')} ${programs.length === 1 ? 'is' : 'are'} still attached to it or its sub-units: ${short(names)}. Move or reassign ${programs.length === 1 ? 'it' : 'them'} to another unit first.`,
      { code: 'has_programs', programs: programs.map((p) => ({ id: p.id, nameEn: p.name_en, unitId: p.unit_id, unitName: p.unit_name })) },
    );
  }
  return { roots, subUnits: roots.reduce((n, r) => n + r.ids.length - 1, 0) };
}

const nameOf = (plan: Plan) => (plan.roots.length === 1 ? plan.roots[0]!.name : plan.roots.map((r) => r.name).join(', ').length <= 40 ? plan.roots.map((r) => r.name).join(', ') : plural(plan.roots.length, 'unit'));

/** The question for the confirm dialog (the same words on every screen). Refuses, with the reason, when the delete would be refused. */
export async function previewDeleteOrgUnits(ctx: Ctx, input: { ids: string[] }): Promise<DeletePreview> {
  assertHuman(ctx);
  const plan = await planDelete(ctx, input.ids);
  const name = nameOf(plan);
  const inside = plan.subUnits ? ` and ${plan.roots.length === 1 ? 'its' : 'their'} ${plural(plan.subUnits, 'sub-unit')}` : '';
  return {
    roots: plan.roots.length, counts: { items: plan.roots.length, subItems: plan.subUnits },
    message: `Delete ${name}${inside}? You can restore ${plan.subUnits || plan.roots.length > 1 ? 'them' : 'it'} from the Trash for ${TRASH_RETENTION_DAYS} days.`,
    label: `Deleted ${name}${plan.subUnits ? ` and ${plural(plan.subUnits, 'sub-unit')}` : ''}`,
  };
}

/**
 * Deletes org units with everything under them to the Trash, in one action: one transaction, one Trash group (one item per
 * top-level unit; a unit inside another selected unit's subtree is not counted twice), one Undo. Refused while programs
 * are attached (see above).
 */
export async function deleteOrgUnits(ctx: Ctx, input: { ids: string[] }): Promise<DeleteResult> {
  assertHuman(ctx);
  const plan = await planDelete(ctx, input.ids);
  const everyId = plan.roots.flatMap((r) => r.ids);
  const owned = (await ctx.tx.execute<{ id: string; owner_unit_id: string }>(sql`select id, owner_unit_id from evidence_item where owner_unit_id = any(${uuids(everyId)})`)).rows;
  const types = await ctx.tx.select().from(orgUnitType);
  const items: NewTrashItem[] = [];
  for (const r of plan.roots) {
    const rows = await readRows(ctx, 'org_unit', r.ids);
    const mine = new Set(r.ids);
    const refs: TrashRef[] = owned.filter((o) => mine.has(o.owner_unit_id)).map((o) => ({ table: 'evidence_item', id: o.id, column: 'owner_unit_id', value: o.owner_unit_id }));
    const payload: TrashPayload = {
      ...emptyPayload({ rootIds: [r.rootId], parentId: r.parentId, displayOrder: r.displayOrder, sortKey: r.sortKey, ancestors: r.ancestors, name: r.name }),
      tables: { org_unit: rows }, refs,
      meta: { types: types.filter((t) => r.typeKeys.includes(t.key)).map((t) => ({ key: t.key, labelEn: t.labelEn, labelAr: t.labelAr })) },
    };
    items.push({
      kind: 'org_unit', label: r.name, context: r.parentName ? `Org chart / ${r.parentName}` : 'Org chart', payload,
      counts: { items: 1, subItems: r.ids.length - 1, ...(refs.length ? { evidenceOwners: refs.length } : {}) },
    });
  }
  if (owned.length) await ctx.tx.execute(sql`update evidence_item set owner_unit_id = null where id = any(${uuids(owned.map((o) => o.id))})`);
  await deleteRows(ctx, 'org_unit', everyId);
  for (const parent of new Set(plan.roots.map((r) => r.parentId))) await closeGaps(ctx, parent);
  const groupId = await writeTrash(ctx, items);
  const label = `Deleted ${nameOf(plan)}${plan.subUnits ? ` and ${plural(plan.subUnits, 'sub-unit')}` : ''}`;
  reportUndo(ctx, restoreUndo(groupId, label));
  return { groupId, label, counts: { items: plan.roots.length, subItems: plan.subUnits }, items: items.length };
}

// ---- Restore ---------------------------------------------------------------------------------------------------------

export interface UnitRestoreOutcome { restored: Record<string, number>; notes: string[]; placedUnder: string | null }

export async function restoreOrgUnits(
  ctx: Ctx, item: { id: string }, payload: TrashPayload, opts: RestoreOptions,
): Promise<UnitRestoreOutcome> {
  assertHuman(ctx);
  const out: UnitRestoreOutcome = { restored: {}, notes: [], placedUnder: null };
  const root = payload.root as { rootIds: string[]; parentId: string | null; displayOrder: number; ancestors?: { id: string; name: string }[] };
  const rows: Row[] = (payload.tables.org_unit ?? []).map((r) => ({ ...r }));
  const rootRow = rows.find((r) => root.rootIds.includes(text(r.id)));
  if (!rootRow) throw new ConflictError('Cannot restore: the snapshot is empty.');
  const inPayload = new Set(idsOf(rows));

  // Where does the root go?
  let parentId: string | null = typeof rootRow.parent_id === 'string' ? rootRow.parent_id : null;
  let placed = false;
  if (parentId && !inPayload.has(parentId) && !(await existing(ctx, 'org_unit', [parentId])).has(parentId)) {
    const ancestors = root.ancestors ?? [];
    const alive = await existing(ctx, 'org_unit', ancestors.map((a) => a.id));
    const nearest = ancestors.find((a) => alive.has(a.id)) ?? null;
    if (opts.placeParentId) {
      if (!(await existing(ctx, 'org_unit', [opts.placeParentId])).has(opts.placeParentId)) throw new ConflictError('Cannot restore: the unit chosen to put it under no longer exists.');
      parentId = opts.placeParentId;
      const [p] = (await ctx.tx.execute<{ name_en: string }>(sql`select name_en from org_unit where id = ${parentId}::uuid`)).rows;
      out.placedUnder = p?.name_en ?? null;
      placed = true;
    } else if (opts.atTopLevel) {
      parentId = null; out.placedUnder = 'the top level'; placed = true;
    } else {
      const parentLabel = ancestors[0]?.name ?? null;
      const choice: RestoreChoice = { code: 'parent_missing', itemId: item.id, parentLabel, nearestAncestor: nearest ? { id: nearest.id, label: nearest.name } : null };
      throw new ConflictError(
        `Cannot restore ${text(rootRow.name_en)}: ${parentLabel ?? 'the unit it sat under'} no longer exists. Restore that from the Trash first, or choose ${nearest ? `to put it under ${nearest.name}` : 'to put it at the top level'}.`,
        choice as unknown as Record<string, unknown>,
      );
    }
    rootRow.parent_id = parentId;
  }
  await assertPermitted(ctx, 'org:write', scopeOf(parentId));

  // A unit type removed in the meantime comes back from the snapshot (units cannot name a type that does not exist).
  const have = new Set((await ctx.tx.select({ key: orgUnitType.key }).from(orgUnitType)).map((t) => t.key));
  const meta = (payload.meta?.types as { key: string; labelEn: string; labelAr: string | null }[] | undefined) ?? [];
  const needed = [...new Set(rows.map((r) => text(r.type)))].filter((k) => !have.has(k));
  if (needed.length) {
    let next = have.size;
    for (const key of needed) {
      const m = meta.find((t) => t.key === key);
      await ctx.tx.insert(orgUnitType).values({ institutionId: ctx.caller.institutionId, key, labelEn: m?.labelEn ?? key, labelAr: m?.labelAr ?? null, displayOrder: next });
      next += 1;
    }
    out.notes.push(`the unit type${needed.length === 1 ? '' : 's'} ${needed.map((k) => meta.find((t) => t.key === k)?.labelEn ?? k).join(', ')} ${needed.length === 1 ? 'was' : 'were'} removed in the meantime and ${needed.length === 1 ? 'has' : 'have'} been added back`);
  }

  await insertRows(ctx, 'org_unit', rows);
  out.restored.units = rows.length;

  // Back in the list: at its old place when it returns under the same parent, else last; numbered gap-free.
  const siblings = (await ctx.tx.execute<{ id: string }>(sql`
    select id from org_unit where parent_id is not distinct from ${parentId}::uuid and id <> ${text(rootRow.id)}::uuid order by display_order, lower(name_en), id`)).rows.map((r) => r.id);
  const at = placed ? siblings.length : Math.min(Math.max(0, Number(root.displayOrder) || 0), siblings.length);
  await renumberChildren(ctx, parentId, [...siblings.slice(0, at), text(rootRow.id), ...siblings.slice(at)]);

  // Evidence owned by these units gets its owner back (only where it is still empty).
  for (const ref of payload.refs) {
    if (ref.table !== 'evidence_item') continue;
    await ctx.tx.execute(sql`update evidence_item set owner_unit_id = ${ref.value}::uuid where id = ${ref.id}::uuid and owner_unit_id is null and exists (select 1 from org_unit where id = ${ref.value}::uuid)`);
  }
  return out;
}

/** The delete that undoes a restore (its Redo): one request naming the roots. */
export const redeleteOrgUnitsBody = (payloads: TrashPayload[]) => ({ ids: payloads.flatMap((p) => (p.root as { rootIds?: string[] }).rootIds ?? []) });
