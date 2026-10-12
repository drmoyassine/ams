// Moving several requirements in one action (drag and drop, DEC-026 follow-up). One request, one transaction, one Undo:
// the plan is made by the shared pure rules (`planMoves`, in @ams/shared; the screens use the same ones for feedback), and
// everything is applied or nothing is. A person's move marks the rows it touches as edited by a person (the database
// trigger does that on any update by a non-worker), so a later analysis run leaves them where they are.
//
// Codes are not touched: a requirement keeps its code wherever it is moved (an accreditor's numbering is official; the
// institution's own is the person's).
import { eq, sql } from 'drizzle-orm';
import { requirement } from '@ams/db';
import { DEFAULT_LIMITS, MoveManyInputSchema, limitsFor, planMoves, planPlacements, type MoveManyInput, type Plan } from '@ams/shared';
import type { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { assertHuman, getDraftVersion, isInternalVersion, require_ } from './common.js';
import { guardIntegrity } from './errors.js';
import { relabelByDepth } from './requirements.js';
import { reportUndo } from '../trash/store.js';

export { MoveManyInputSchema };

export interface MoveManyResult {
  /** How many items were named. */
  moved: number;
  /** How many rows changed parent or position (the moved ones and the siblings they shifted). */
  changed: number;
  /** True when everything was already where it was dropped. */
  unchanged: boolean;
}

const uuidArray = (xs: readonly (string | null)[]) => (xs.length ? sql`array[${sql.join(xs.map((i) => sql`${i}::uuid`), sql`, `)}]::uuid[]` : sql`'{}'::uuid[]`);
const intArray = (xs: readonly number[]) => (xs.length ? sql`array[${sql.join(xs.map((i) => sql`${i}::int`), sql`, `)}]::int[]` : sql`'{}'::int[]`);

/** "Moved 2.3 under 2", "Moved 3 items to the top level", "Reordered 2.3" (the words the Undo toast shows). */
function wording(codes: string[], parentCode: string | null | undefined, sameParent: boolean): string {
  const what = codes.length === 1 ? codes[0]! : codes.length <= 3 ? codes.join(', ') : `${codes.length} items`;
  if (sameParent) return `Reordered ${what}`;
  return parentCode === undefined ? `Moved ${what}` : parentCode === null ? `Moved ${what} to the top level` : `Moved ${what} under ${parentCode}`;
}

/**
 * Moves requirements of one version. Give `moves` ([{ id, parentId, index }]: the positions count the parent's list with every
 * moved item taken out, and the items go in in the order given) or `placements` (runs to put back after a sibling: what Undo
 * sends). Atomic: a refusal (a move under itself, deeper than the levels allow, a version that is no longer a draft) applies nothing. Display order
 * of every changed list is renumbered 0, 1, 2 ... in the same transaction. Codes never change.
 */
export async function moveMany(ctx: Ctx, versionId: string, input: z.input<typeof MoveManyInputSchema>): Promise<MoveManyResult> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const parsed = MoveManyInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError('cannot move', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const data: MoveManyInput = parsed.data;
  if (!!data.moves === !!data.placements) throw new ValidationError('give either moves or placements');
  const version = await getDraftVersion(ctx, versionId);
  // The institution's own framework goes as deep as it has named levels; an external standard as deep as the general cap.
  const limits = limitsFor({ internal: await isInternalVersion(ctx, versionId), levelLabels: version.levelLabels });

  const rows = await ctx.tx.select({ id: requirement.id, parentId: requirement.parentId, displayOrder: requirement.displayOrder, code: requirement.code })
    .from(requirement).where(eq(requirement.frameworkVersionId, versionId));
  const codeOf = new Map(rows.map((r) => [r.id, r.code] as const));
  const names = (id: string) => codeOf.get(id) ?? 'an item';
  const plan: Plan = data.moves ? planMoves(rows, data.moves, names, limits) : planPlacements(rows, data.placements!, names, DEFAULT_LIMITS);
  if (!plan.ok) throw plan.code === 'unknown' ? new ValidationError(plan.message) : new ConflictError(plan.message);
  if (plan.updates.length > 0) {
    await guardIntegrity(() => ctx.tx.execute(sql`
      update requirement r set parent_id = v.parent_id, display_order = v.ord
      from (select unnest(${uuidArray(plan.updates.map((u) => u.id))}) as id, unnest(${uuidArray(plan.updates.map((u) => u.parentId))}) as parent_id,
                   unnest(${intArray(plan.updates.map((u) => u.displayOrder))}) as ord) v
      where r.id = v.id and r.framework_version_id = ${versionId}`));
    await relabelByDepth(ctx, versionId);
  }

  const parents = new Set((data.moves ?? []).map((m) => m.parentId ?? null));
  const before = new Map(rows.map((r) => [r.id, r.parentId ?? null] as const));
  const sameParent = !!data.moves && data.moves.every((m) => before.get(m.id) === (m.parentId ?? null));
  const only = parents.size === 1 ? [...parents][0]! : undefined;
  const parentCode = data.moves && parents.size === 1 ? (only === null || only === undefined ? null : codeOf.get(only)) : undefined;
  const label = data.moves
    ? wording(plan.movedIds.map(names), parentCode, sameParent)
    : `Undid the move of ${plan.movedIds.length === 1 ? names(plan.movedIds[0]!) : `${plan.movedIds.length} items`}`;
  if (!plan.unchanged) {
    // Undo = put every moved item back after the sibling it followed (parent and position), in one more call of this service.
    reportUndo(ctx, { label, method: 'POST', path: `/api/framework-versions/${versionId}/requirements/move-many`, body: { placements: plan.undo } });
  }
  return { moved: plan.movedIds.length, changed: plan.updates.length, unchanged: plan.unchanged };
}
