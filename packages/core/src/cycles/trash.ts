// Deleting a DRAFT cycle to the Trash and putting it back (DEC-026, TASK-078). A draft is the only cycle that is deleted: it
// goes with its stages, outputs and inputs, as one Trash item (kind `cycle`), and comes back with the same ids. A cycle that
// has started is cancelled instead (cycles.ts), because other cycles build on it and its history must stay.
import { sql } from 'drizzle-orm';
import type { DeleteResult } from '@ams/shared';
import { plural } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { deleteRows, emptyPayload, existing, idsOf, insertRows, readRows, readWhere, uuids, type Row, type TrashPayload } from '../trash/rows.js';
import { reportUndo, restoreUndo, writeTrash } from '../trash/store.js';
import { assertManage, loadCycle } from './common.js';
import { anchorNames } from './read.js';

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** Deletes a draft cycle to the Trash. */
export async function deleteCycle(ctx: Ctx, input: { id: string }): Promise<DeleteResult> {
  assertHuman(ctx);
  const c = await loadCycle(ctx, input.id);
  await assertManage(ctx, c.responsibleUnitId);
  if (c.status !== 'draft') throw new ConflictError(`A ${c.status} cycle is not deleted${c.status === 'cancelled' ? '' : '; cancel it instead'}. Only a draft can be deleted.`);
  const [dependent] = (await ctx.tx.execute<{ title: string }>(sql`select title from cycle where previous_cycle_id = ${c.id}::uuid or parent_cycle_id = ${c.id}::uuid limit 1`)).rows;
  if (dependent) throw new ConflictError(`Another cycle builds on this one ("${dependent.title}"), so it cannot be deleted.`);

  const [cycleRow] = await readRows(ctx, 'cycle', [c.id]);
  const stages = await readWhere(ctx, 'cycle_stage', sql`t.cycle_id = ${c.id}::uuid`);
  const stageIds = idsOf(stages);
  const outputs = await readWhere(ctx, 'cycle_output', sql`t.stage_id = any(${uuids(stageIds)})`);
  const inputs = await readWhere(ctx, 'cycle_input', sql`t.stage_id = any(${uuids(stageIds)})`);
  const files = outputs.map((o) => o.file_key).filter((k): k is string => typeof k === 'string');
  const anchor = (await anchorNames(ctx, [{ kind: c.anchorKind, id: c.anchorId }])).get(`${c.anchorKind}:${c.anchorId}`);

  const payload: TrashPayload = {
    ...emptyPayload({ cycleId: c.id, unitId: c.responsibleUnitId, name: c.title }),
    tables: { cycle: [cycleRow!], cycle_stage: stages, cycle_output: outputs, cycle_input: inputs }, files,
  };
  // Children first: the database lets stages, outputs and inputs go only while the cycle is a draft, and the cycle last.
  await deleteRows(ctx, 'cycle_input', idsOf(inputs));
  await deleteRows(ctx, 'cycle_output', idsOf(outputs));
  await deleteRows(ctx, 'cycle_stage', stageIds);
  await deleteRows(ctx, 'cycle', [c.id]);
  const groupId = await writeTrash(ctx, [{
    kind: 'cycle', label: c.title, context: anchor ? `Quality Management / ${anchor}` : 'Quality Management', payload,
    counts: { items: 1, stages: stages.length, outputs: outputs.length, inputs: inputs.length },
  }]);
  const label = `Deleted the cycle ${c.title}${stages.length ? ` and its ${plural(stages.length, 'stage')}` : ''}`;
  reportUndo(ctx, restoreUndo(groupId, label));
  return { groupId, label, counts: { items: 1, stages: stages.length }, items: 1 };
}

/** Puts a deleted draft cycle back, all or nothing. A unit or template that is gone in the meantime stops it, with the reason. */
export async function restoreCycle(ctx: Ctx, payload: TrashPayload): Promise<{ restored: Record<string, number> }> {
  assertHuman(ctx);
  const [row] = (payload.tables.cycle ?? []) as Row[];
  if (!row) throw new ConflictError('Cannot restore: the snapshot is empty.');
  await assertManage(ctx, text(row.responsible_unit_id));
  const stages = payload.tables.cycle_stage ?? [];
  const units = [...new Set([text(row.responsible_unit_id), ...stages.map((s) => text(s.responsible_unit_id))])];
  const alive = await existing(ctx, 'org_unit', units);
  const gone = units.find((u) => !alive.has(u));
  if (gone) throw new ConflictError('Cannot restore: a unit this cycle names no longer exists. Restore that unit from the Trash first.');
  if (typeof row.template_id === 'string') {
    const [t] = (await ctx.tx.execute<{ id: string }>(sql`select id from cycle_template where id = ${row.template_id}::uuid`)).rows;
    if (!t) throw new ConflictError('Cannot restore: the template this cycle was made from no longer exists.');
  }
  await insertRows(ctx, 'cycle', [row]);
  await insertRows(ctx, 'cycle_stage', stages);
  await insertRows(ctx, 'cycle_output', payload.tables.cycle_output ?? []);
  await insertRows(ctx, 'cycle_input', payload.tables.cycle_input ?? []);
  return { restored: { cycles: 1, stages: stages.length, outputs: (payload.tables.cycle_output ?? []).length, inputs: (payload.tables.cycle_input ?? []).length } };
}

/** The delete that undoes a restore (its Redo). */
export const redeleteCycleBody = (payload: TrashPayload) => ({ id: text((payload.root as { cycleId?: unknown }).cycleId) });
