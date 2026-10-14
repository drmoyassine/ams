// Moving org units (drag and drop in the tree, the keyboard, Undo): the same rules and the same code as the standards tree
// (`planMoves` / `planPlacements` in @ams/shared) over the org_unit table. One request, one transaction, one Undo: a refusal
// (a unit under itself or its own sub-units, too deep, an inactive target, no permission) applies nothing, and the display
// order of every list that changed is renumbered 0, 1, 2 ... in the same transaction.
import { sql } from 'drizzle-orm';
import { orgUnit } from '@ams/db';
import { MoveManyInputSchema, ORG_MAX_DEPTH, planMoves, planPlacements, type DepthLimits, type MoveManyInput, type Plan } from '@ams/shared';
import type { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { reportUndo } from '../trash/store.js';
import { intArray, uuidArray } from './unit-order.js';
import { scopeOf } from './units.js';

export { MoveManyInputSchema };

export const ORG_LIMITS: DepthLimits = { maxLevels: ORG_MAX_DEPTH, noun: 'unit' };

export interface MoveUnitsResult {
  /** How many units were named. */
  moved: number;
  /** How many rows changed parent or position (the moved ones and the siblings they shifted). */
  changed: number;
  /** True when everything was already where it was dropped. */
  unchanged: boolean;
}

function wording(names: string[], parentName: string | null | undefined, sameParent: boolean): string {
  const what = names.length === 1 ? names[0]! : names.length <= 3 ? names.join(', ') : `${names.length} units`;
  if (sameParent) return `Reordered ${what}`;
  return parentName === undefined ? `Moved ${what}` : parentName === null ? `Moved ${what} to the top level` : `Moved ${what} under ${parentName}`;
}

/**
 * Moves org units: `moves` ([{ id, parentId, index }]: the positions count the parent's list with every moved unit taken
 * out, and the units go in in the order given) or `placements` (runs to put back after a sibling: what Undo sends).
 * Needs `org:write` where each unit is now and where it goes. Atomic.
 */
export async function moveOrgUnits(ctx: Ctx, input: z.input<typeof MoveManyInputSchema>): Promise<MoveUnitsResult> {
  assertHuman(ctx);
  const parsed = MoveManyInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError('cannot move', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const data: MoveManyInput = parsed.data;
  if (!!data.moves === !!data.placements) throw new ValidationError('give either moves or placements');

  const rows = await ctx.tx.select({ id: orgUnit.id, parentId: orgUnit.parentId, displayOrder: orgUnit.displayOrder, code: orgUnit.nameEn, active: orgUnit.active }).from(orgUnit);
  const nameOf = new Map(rows.map((r) => [r.id, r.code] as const));
  const label = (id: string) => nameOf.get(id) ?? 'a unit';
  const plan: Plan = data.moves ? planMoves(rows, data.moves, label, ORG_LIMITS) : planPlacements(rows, data.placements!, label, ORG_LIMITS);
  if (!plan.ok) throw plan.code === 'unknown' ? new ValidationError(plan.message) : new ConflictError(plan.message);

  // Permission: at each moved unit (where it is now) and at each place it is going to. Checked for the units that really move.
  const before = new Map(rows.map((r) => [r.id, r.parentId ?? null] as const));
  const active = new Map(rows.map((r) => [r.id, r.active] as const));
  const movedParents = new Set<string | null>();
  for (const u of plan.updates) if (plan.movedIds.includes(u.id) && before.get(u.id) !== u.parentId) { movedParents.add(u.parentId); }
  const checked = new Set<string>();
  for (const id of plan.movedIds) {
    if (checked.has(id)) continue;
    checked.add(id);
    await assertPermitted(ctx, 'org:write', { type: 'org_unit', id });
  }
  for (const p of movedParents) {
    if (p && active.get(p) === false) throw new ConflictError(`cannot move a unit under ${label(p)}, which is inactive`);
    await assertPermitted(ctx, 'org:write', scopeOf(p));
  }
  // Reordering inside one parent needs write access there too (the siblings are renumbered).
  for (const u of plan.updates) {
    if (!plan.movedIds.includes(u.id) && !checked.has(`p:${u.parentId}`)) { checked.add(`p:${u.parentId}`); await assertPermitted(ctx, 'org:write', scopeOf(u.parentId)); }
  }

  if (plan.updates.length > 0) {
    await guardIntegrity(() => ctx.tx.execute(sql`
      update org_unit u set parent_id = v.parent_id, display_order = v.ord
      from (select unnest(${uuidArray(plan.updates.map((u) => u.id))}) as id, unnest(${uuidArray(plan.updates.map((u) => u.parentId))}) as parent_id,
                   unnest(${intArray(plan.updates.map((u) => u.displayOrder))}) as ord) v
      where u.id = v.id`));
  }

  if (!plan.unchanged) {
    const parents = new Set((data.moves ?? []).map((m) => m.parentId ?? null));
    const sameParent = !!data.moves && data.moves.every((m) => before.get(m.id) === (m.parentId ?? null));
    const only = parents.size === 1 ? [...parents][0]! : undefined;
    const parentName = data.moves && parents.size === 1 ? (only === null || only === undefined ? null : nameOf.get(only)) : undefined;
    const text = data.moves ? wording(plan.movedIds.map(label), parentName, sameParent) : `Undid the move of ${plan.movedIds.length === 1 ? label(plan.movedIds[0]!) : `${plan.movedIds.length} units`}`;
    // Undo = put every moved unit back after the sibling it followed (parent and position), in one more call of this service.
    reportUndo(ctx, { label: text, method: 'POST', path: '/api/org-units/move-many', body: { placements: plan.undo } });
  }
  return { moved: plan.movedIds.length, changed: plan.updates.length, unchanged: plan.unchanged };
}
