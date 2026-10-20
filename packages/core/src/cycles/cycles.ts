// Cycle-level operations: edit, start (activate), take back to draft, cancel. Stages are in stages.ts, outputs in outputs.ts.
// Every mutation reports how to take it back (`reportUndo`) where taking it back makes sense; a cancellation is a recorded
// decision and is not undone. All of it is audited by the database (audit_row).
import { and, eq, sql } from 'drizzle-orm';
import { cycle, cycleStage } from '@ams/db';
import type { CancelCycle, CycleDetail, UpdateCycle } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { reportUndo } from '../trash/store.js';
import { addDays, assertManage, assertPerson, assertUnit, loadCycle, nfc, nfcOrNull, stagesOf } from './common.js';
import { loadDetail } from './read.js';

/** Edits title, owner, responsible unit, dates and period label. Dates of the stages follow a changed start while it is a draft. */
export async function updateCycle(ctx: Ctx, id: string, patch: UpdateCycle): Promise<CycleDetail> {
  assertHuman(ctx);
  const c = await loadCycle(ctx, id);
  await assertManage(ctx, c.responsibleUnitId);
  if (c.status === 'completed' || c.status === 'cancelled') throw new ConflictError(`The cycle is ${c.status}; it can no longer be edited.`);
  const set: Partial<typeof cycle.$inferInsert> = {};
  const before: Record<string, unknown> = {};
  let cascadeTo: string | null = null;
  if (patch.title !== undefined && nfc(patch.title) !== c.title) { set.title = nfc(patch.title); before.title = c.title; }
  if (patch.periodLabel !== undefined && nfcOrNull(patch.periodLabel) !== c.periodLabel) { set.periodLabel = nfcOrNull(patch.periodLabel); before.periodLabel = c.periodLabel; }
  if (patch.endDate !== undefined && patch.endDate !== c.endDate) { set.endDate = patch.endDate; before.endDate = c.endDate; }
  if (patch.leadUserId !== undefined && patch.leadUserId !== c.leadUserId) {
    await assertPerson(ctx, patch.leadUserId, 'The owner of the cycle');
    set.leadUserId = patch.leadUserId; before.leadUserId = c.leadUserId;
    cascadeTo = patch.leadUserId;
  }
  if (patch.responsibleUnitId !== undefined && patch.responsibleUnitId !== c.responsibleUnitId) {
    await assertUnit(ctx, patch.responsibleUnitId, 'The responsible unit');
    await assertManage(ctx, patch.responsibleUnitId);
    set.responsibleUnitId = patch.responsibleUnitId; before.responsibleUnitId = c.responsibleUnitId;
  }
  let shift = 0;
  if (patch.startDate !== undefined && patch.startDate !== c.startDate) {
    if (c.status !== 'draft') throw new ConflictError('The start date of a running cycle does not change; change the dates of its stages instead.');
    shift = Math.round((Date.parse(`${patch.startDate}T00:00:00Z`) - Date.parse(`${c.startDate}T00:00:00Z`)) / 86400000);
    set.startDate = patch.startDate; before.startDate = c.startDate;
    if (c.endDate && patch.endDate === undefined) { set.endDate = addDays(c.endDate, shift); before.endDate = c.endDate; }
  }
  if (Object.keys(set).length === 0) return loadDetail(ctx, c);
  // Moving the start moves the stages with it (in one statement, so the date checks see the whole shift at once).
  if (shift !== 0) {
    await guardIntegrity(() => ctx.tx.update(cycle).set(set).where(eq(cycle.id, id)));
    await ctx.tx.execute(sql`update cycle_stage set start_date = start_date + ${shift}::int, end_date = end_date + ${shift}::int where cycle_id = ${id}::uuid`);
  } else {
    await guardIntegrity(() => ctx.tx.update(cycle).set(set).where(eq(cycle.id, id)));
  }
  // One owner for the whole cycle (DEC-030): a stage that was following the old owner follows the new one; a stage given its own owner
  // keeps it, and a finished stage keeps the person who did it.
  if (cascadeTo) {
    await ctx.tx.execute(sql`update cycle_stage set owner_user_id = ${cascadeTo}::uuid, owner_unresolved = false
      where cycle_id = ${id}::uuid and owner_user_id = ${c.leadUserId}::uuid and status in ('not_started', 'in_progress')`);
  }
  reportUndo(ctx, { label: `Edited the cycle ${c.title}`, method: 'PATCH', path: `/api/cycles/${id}`, body: before });
  return loadDetail(ctx, await loadCycle(ctx, id));
}

/** Launches a draft: it becomes active and its stages can be started. Stages whose owner is not settled may still be chosen later. */
export async function activateCycle(ctx: Ctx, id: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const c = await loadCycle(ctx, id);
  // The owner of a cycle a plan proposed starts it without cycle:manage (it is the run they were asked to do).
  if (!(c.planId && c.leadUserId === ctx.caller.userId && c.status === 'draft')) await assertManage(ctx, c.responsibleUnitId);
  if (c.status !== 'draft') throw new ConflictError(`The cycle is already ${c.status}.`);
  if ((await stagesOf(ctx, id)).length === 0) throw new ConflictError('Add at least one stage before launching the cycle.');
  await guardIntegrity(() => ctx.tx.update(cycle).set({ status: 'active' }).where(eq(cycle.id, id)));
  reportUndo(ctx, { label: `Launched the cycle ${c.title}`, method: 'POST', path: `/api/cycles/${id}/revert-to-draft` });
  return loadDetail(ctx, await loadCycle(ctx, id));
}

/** Takes a launched cycle back to a draft, while no stage has started. */
export async function revertCycleToDraft(ctx: Ctx, id: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const c = await loadCycle(ctx, id);
  await assertManage(ctx, c.responsibleUnitId);
  if (c.status !== 'active') throw new ConflictError(`Only a running cycle goes back to a draft (this one is ${c.status}).`);
  const started = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(cycleStage).where(and(eq(cycleStage.cycleId, id), sql`${cycleStage.status} <> 'not_started'`));
  if ((started[0]?.n ?? 0) > 0) throw new ConflictError('A stage has already started, so the cycle cannot go back to a draft. Cancel it instead.');
  await guardIntegrity(() => ctx.tx.update(cycle).set({ status: 'draft' }).where(eq(cycle.id, id)));
  reportUndo(ctx, { label: `Took the cycle ${c.title} back to a draft`, method: 'POST', path: `/api/cycles/${id}/activate` });
  return loadDetail(ctx, await loadCycle(ctx, id));
}

/** Cancels a started cycle with a reason. A draft is deleted (to the Trash), not cancelled. A cancellation is not undone. */
export async function cancelCycle(ctx: Ctx, id: string, input: CancelCycle): Promise<CycleDetail> {
  assertHuman(ctx);
  const c = await loadCycle(ctx, id);
  await assertManage(ctx, c.responsibleUnitId);
  if (c.status === 'draft') throw new ConflictError('A draft cycle is deleted, not cancelled.');
  if (c.status === 'cancelled') throw new ConflictError('The cycle is already cancelled.');
  const reason = nfc(input.reason);
  if (!reason) throw new ConflictError('Give the reason for cancelling.');
  await guardIntegrity(() => ctx.tx.update(cycle).set({ status: 'cancelled', cancelReason: reason }).where(eq(cycle.id, id)));
  return loadDetail(ctx, await loadCycle(ctx, id));
}

/**
 * After a stage finishes (completed or skipped) the cycle completes when no stage is left; after one is reopened a completed
 * cycle is running again. Called by the stage services, inside their transaction.
 */
export async function syncCycleStatus(ctx: Ctx, cycleId: string): Promise<void> {
  const c = await loadCycle(ctx, cycleId);
  if (c.status !== 'active') return;
  const [left] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(cycleStage).where(and(eq(cycleStage.cycleId, cycleId), sql`${cycleStage.status} in ('not_started', 'in_progress')`));
  if ((left?.n ?? 0) === 0) await guardIntegrity(() => ctx.tx.update(cycle).set({ status: 'completed' }).where(eq(cycle.id, cycleId)));
}
