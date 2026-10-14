import { sql } from 'drizzle-orm';
import type { Ctx } from '../ctx.js';
import { guardIntegrity } from '../framework/errors.js';

export const uuidArray = (xs: readonly (string | null)[]) => (xs.length ? sql`array[${sql.join(xs.map((i) => sql`${i}::uuid`), sql`, `)}]::uuid[]` : sql`'{}'::uuid[]`);
export const intArray = (xs: readonly number[]) => (xs.length ? sql`array[${sql.join(xs.map((i) => sql`${i}::int`), sql`, `)}]::int[]` : sql`'{}'::int[]`);

/** Gives the children of `parentId` the display order 0, 1, 2 ... in the order given. Writes only the rows whose number changes. */
export async function renumberChildren(ctx: Ctx, parentId: string | null, orderedIds: readonly string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  await guardIntegrity(() => ctx.tx.execute(sql`
    update org_unit u set display_order = v.ord
    from (select unnest(${uuidArray(orderedIds)}) as id, generate_series(0, ${orderedIds.length - 1}) as ord) v
    where u.id = v.id and u.display_order <> v.ord and u.parent_id is not distinct from ${parentId}::uuid`));
}

/** Closes the gaps under `parentId` after something left (a delete): the remaining children keep their order, numbered 0, 1, 2 ... */
export async function closeGaps(ctx: Ctx, parentId: string | null): Promise<void> {
  const res = await ctx.tx.execute<{ id: string }>(sql`select id from org_unit where parent_id is not distinct from ${parentId}::uuid order by display_order, lower(name_en), id`);
  await renumberChildren(ctx, parentId, res.rows.map((r) => r.id));
}
