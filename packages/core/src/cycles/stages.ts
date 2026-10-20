// Stages of a cycle: working them (start, complete, skip, reopen, checklist), editing owners, units and dates, and - while the cycle
// is a draft - building them by hand for a blank cycle. The database insists on the rules that matter (a stage completes only
// when its required outputs are final; the cycle completes when its stages are done); these services say them in plain words
// first. Every service answers with the whole cycle, because one action can change several stages.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { cycle, cycleInput, cycleOutput, cycleStage } from '@ams/db';
import type { AddInput, AddOutput, AddStage, CycleDetail, UpdateStage } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { reportUndo } from '../trash/store.js';
import {
  assertActive, assertDraft, assertManage, assertPerson, assertUnit, assertWork, keyFrom, loadCycle, loadOutput, loadStage, nfc, nfcOrNull, stagesOf,
} from './common.js';
import { syncCycleStatus } from './cycles.js';
import { loadDetail } from './read.js';

const detailOf = async (ctx: Ctx, cycleId: string) => loadDetail(ctx, await loadCycle(ctx, cycleId));
const stagePath = (id: string) => `/api/cycle-stages/${id}`;

// ---- Working a stage ---------------------------------------------------------------------------------------------------------

export async function startStage(ctx: Ctx, stageId: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const { stage, cycle: c } = await loadStage(ctx, stageId);
  await assertWork(ctx, stage, c);
  assertActive(c, 'start a stage');
  if (stage.status !== 'not_started') throw new ConflictError(`The stage "${stage.name}" is ${stage.status.replace('_', ' ')}; only a stage that has not started can be started.`);
  await guardIntegrity(() => ctx.tx.update(cycleStage).set({ status: 'in_progress' }).where(eq(cycleStage.id, stageId)));
  reportUndo(ctx, { label: `Started ${stage.name}`, method: 'POST', path: `${stagePath(stageId)}/reset` });
  return detailOf(ctx, c.id);
}

/** Puts a started stage back to "not started", while nothing in it has been filled. This is the Undo of starting it. */
export async function resetStage(ctx: Ctx, stageId: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const { stage, cycle: c } = await loadStage(ctx, stageId);
  await assertWork(ctx, stage, c);
  assertActive(c, 'change a stage');
  if (stage.status !== 'in_progress') throw new ConflictError(`The stage "${stage.name}" is not in progress.`);
  const [filled] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(cycleOutput).where(and(eq(cycleOutput.stageId, stageId), sql`${cycleOutput.state} <> 'missing'`));
  if ((filled?.n ?? 0) > 0) throw new ConflictError(`Something in "${stage.name}" has been filled in already; it cannot go back to not started.`);
  await guardIntegrity(() => ctx.tx.update(cycleStage).set({ status: 'not_started' }).where(eq(cycleStage.id, stageId)));
  reportUndo(ctx, { label: `Put ${stage.name} back to not started`, method: 'POST', path: `${stagePath(stageId)}/start` });
  return detailOf(ctx, c.id);
}

/** Completes a stage: every required output must be final. The cycle completes with its last stage. */
export async function completeStage(ctx: Ctx, stageId: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const { stage, cycle: c } = await loadStage(ctx, stageId);
  await assertWork(ctx, stage, c);
  assertActive(c, 'complete a stage');
  if (stage.status !== 'in_progress') throw new ConflictError(`The stage "${stage.name}" is ${stage.status.replace('_', ' ')}; start it before completing it.`);
  const open = await ctx.tx.select({ name: cycleOutput.name }).from(cycleOutput).where(and(eq(cycleOutput.stageId, stageId), eq(cycleOutput.required, true), sql`${cycleOutput.state} <> 'final'`)).orderBy(asc(cycleOutput.createdAt));
  if (open.length) throw new ConflictError(`"${stage.name}" cannot be completed yet. These required outputs are not final: ${open.map((o) => o.name).join(', ')}.`, { code: 'outputs_not_final', outputs: open.map((o) => o.name) });
  await guardIntegrity(() => ctx.tx.update(cycleStage).set({ status: 'completed' }).where(eq(cycleStage.id, stageId)));
  await syncCycleStatus(ctx, c.id);
  reportUndo(ctx, { label: `Completed ${stage.name}`, method: 'POST', path: `${stagePath(stageId)}/reopen` });
  return detailOf(ctx, c.id);
}

/** Skips a stage that does not apply, with a reason that is kept. */
export async function skipStage(ctx: Ctx, stageId: string, input: { reason: string }): Promise<CycleDetail> {
  assertHuman(ctx);
  const { stage, cycle: c } = await loadStage(ctx, stageId);
  await assertWork(ctx, stage, c);
  assertActive(c, 'skip a stage');
  if (stage.status !== 'not_started' && stage.status !== 'in_progress') throw new ConflictError(`The stage "${stage.name}" is ${stage.status}; only an open stage can be skipped.`);
  const reason = nfc(input.reason);
  if (!reason) throw new ConflictError('Give the reason for skipping the stage.');
  await guardIntegrity(() => ctx.tx.update(cycleStage).set({ status: 'skipped', skipReason: reason }).where(eq(cycleStage.id, stageId)));
  await syncCycleStatus(ctx, c.id);
  reportUndo(ctx, { label: `Skipped ${stage.name}`, method: 'POST', path: `${stagePath(stageId)}/reopen` });
  return detailOf(ctx, c.id);
}

/** Reopens a completed stage (back to in progress; a completed cycle runs again) or a skipped one (back to not started). */
export async function reopenStage(ctx: Ctx, stageId: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const { stage, cycle: c } = await loadStage(ctx, stageId);
  await assertWork(ctx, stage, c);
  if (c.status === 'cancelled' || c.status === 'draft') assertActive(c, 'reopen a stage');
  if (stage.status !== 'completed' && stage.status !== 'skipped') throw new ConflictError(`The stage "${stage.name}" is ${stage.status.replace('_', ' ')}; only a completed or skipped stage can be reopened.`);
  if (c.status === 'completed') await guardIntegrity(() => ctx.tx.update(cycle).set({ status: 'active' }).where(eq(cycle.id, c.id)));
  const wasSkipped = stage.status === 'skipped';
  await guardIntegrity(() => ctx.tx.update(cycleStage).set({ status: wasSkipped ? 'not_started' : 'in_progress' }).where(eq(cycleStage.id, stageId)));
  reportUndo(ctx, wasSkipped
    ? { label: `Reopened ${stage.name}`, method: 'POST', path: `${stagePath(stageId)}/skip`, body: { reason: stage.skipReason ?? 'Skipped' } }
    : { label: `Reopened ${stage.name}`, method: 'POST', path: `${stagePath(stageId)}/complete` });
  return detailOf(ctx, c.id);
}

/** Ticks or unticks one item of a stage's checklist. */
export async function toggleChecklist(ctx: Ctx, stageId: string, input: { index: number; done: boolean }): Promise<CycleDetail> {
  assertHuman(ctx);
  const { stage, cycle: c } = await loadStage(ctx, stageId);
  await assertWork(ctx, stage, c);
  assertActive(c, 'tick a checklist');
  if (stage.status === 'completed' || stage.status === 'skipped') throw new ConflictError(`The stage "${stage.name}" is ${stage.status}; reopen it to change its checklist.`);
  const list = (stage.checklist as { text: string; done: boolean; doneBy: string | null; doneAt: string | null }[]).map((i) => ({ ...i }));
  const item = list[input.index];
  if (!item) throw new NotFoundError(`checklist item ${input.index}`);
  if (item.done !== input.done) {
    item.done = input.done; item.doneBy = input.done ? ctx.caller.userId : null; item.doneAt = input.done ? new Date().toISOString() : null;
    await guardIntegrity(() => ctx.tx.update(cycleStage).set({ checklist: list }).where(eq(cycleStage.id, stageId)));
    reportUndo(ctx, { label: `${input.done ? 'Ticked' : 'Unticked'} "${item.text.slice(0, 60)}"`, method: 'POST', path: `${stagePath(stageId)}/checklist`, body: { index: input.index, done: !input.done } });
  }
  return detailOf(ctx, c.id);
}

// ---- Editing a stage ---------------------------------------------------------------------------------------------------------

/** Name, instructions, responsible unit, owner and dates of a stage (managers; a completed or cancelled cycle no longer changes). */
export async function updateStage(ctx: Ctx, stageId: string, patch: UpdateStage): Promise<CycleDetail> {
  assertHuman(ctx);
  const { stage, cycle: c } = await loadStage(ctx, stageId);
  await assertManage(ctx, c.responsibleUnitId);
  if (c.status === 'completed' || c.status === 'cancelled') throw new ConflictError(`The cycle is ${c.status}; its stages can no longer change.`);
  const set: Partial<typeof cycleStage.$inferInsert> = {};
  const before: Record<string, unknown> = {};
  if (patch.name !== undefined && nfc(patch.name) !== stage.name) { set.name = nfc(patch.name); before.name = stage.name; }
  if (patch.nameAr !== undefined && nfcOrNull(patch.nameAr) !== stage.nameAr) { set.nameAr = nfcOrNull(patch.nameAr); before.nameAr = stage.nameAr; }
  if (patch.process !== undefined && patch.process.normalize('NFC') !== stage.process) { set.process = patch.process.normalize('NFC'); before.process = stage.process; }
  if (patch.responsibleUnitId !== undefined && patch.responsibleUnitId !== stage.responsibleUnitId) {
    await assertUnit(ctx, patch.responsibleUnitId, 'The responsible unit');
    set.responsibleUnitId = patch.responsibleUnitId; set.unitUnresolved = false; before.responsibleUnitId = stage.responsibleUnitId;
  }
  if (patch.ownerUserId !== undefined && patch.ownerUserId !== stage.ownerUserId) {
    if (patch.ownerUserId) await assertPerson(ctx, patch.ownerUserId, 'The owner of the stage');
    set.ownerUserId = patch.ownerUserId; set.ownerUnresolved = patch.ownerUserId === null; before.ownerUserId = stage.ownerUserId;
  }
  if (patch.startDate !== undefined && patch.startDate !== stage.startDate) { set.startDate = patch.startDate; before.startDate = stage.startDate; }
  if (patch.endDate !== undefined && patch.endDate !== stage.endDate) { set.endDate = patch.endDate; before.endDate = stage.endDate; }
  if (Object.keys(set).length) {
    await guardIntegrity(() => ctx.tx.update(cycleStage).set(set).where(eq(cycleStage.id, stageId)));
    reportUndo(ctx, { label: `Edited ${stage.name}`, method: 'PATCH', path: stagePath(stageId), body: before });
  }
  return detailOf(ctx, c.id);
}

// ---- Building a blank cycle (draft only) -------------------------------------------------------------------------------------

export async function addStage(ctx: Ctx, cycleId: string, input: AddStage): Promise<CycleDetail> {
  assertHuman(ctx);
  const c = await loadCycle(ctx, cycleId);
  await assertManage(ctx, c.responsibleUnitId);
  assertDraft(c, 'Stages are added');
  const existing = await stagesOf(ctx, cycleId);
  if (input.responsibleUnitId) await assertUnit(ctx, input.responsibleUnitId, 'The responsible unit');
  // A stage follows the cycle's owner unless it is given its own (DEC-030); an explicit null leaves it for someone to choose.
  const owner = input.ownerUserId === undefined ? c.leadUserId : input.ownerUserId;
  if (input.ownerUserId) await assertPerson(ctx, input.ownerUserId, 'The owner of the stage');
  const key = keyFrom(input.name, new Set(existing.map((s) => s.key)), input.key);
  const [row] = await guardIntegrity(() => ctx.tx.insert(cycleStage).values({
    institutionId: c.institutionId, cycleId, key, name: nfc(input.name), nameAr: nfcOrNull(input.nameAr), process: (input.process ?? '').normalize('NFC'),
    checklist: (input.checklist ?? []).map((text) => ({ text: nfc(text), done: false, doneBy: null, doneAt: null })), displayOrder: existing.length,
    responsibleUnitId: input.responsibleUnitId ?? c.responsibleUnitId, unitUnresolved: false,
    ownerUserId: owner, ownerUnresolved: !owner, startDate: input.startDate ?? null, endDate: input.endDate ?? null,
  }).returning());
  reportUndo(ctx, { label: `Added the stage ${row!.name}`, method: 'DELETE', path: stagePath(row!.id) });
  return detailOf(ctx, cycleId);
}

/** Removes a stage (with its outputs and inputs) from a draft cycle, unless another stage reads one of its outputs. */
export async function deleteStage(ctx: Ctx, stageId: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const { cycle: c } = await loadStage(ctx, stageId);
  await assertManage(ctx, c.responsibleUnitId);
  assertDraft(c, 'Stages are removed');
  const outs = await ctx.tx.select({ id: cycleOutput.id }).from(cycleOutput).where(eq(cycleOutput.stageId, stageId));
  await assertNotRead(ctx, outs.map((o) => o.id), stageId);
  await ctx.tx.delete(cycleInput).where(eq(cycleInput.stageId, stageId));
  await ctx.tx.delete(cycleOutput).where(eq(cycleOutput.stageId, stageId));
  await guardIntegrity(() => ctx.tx.delete(cycleStage).where(eq(cycleStage.id, stageId)));
  const rest = await stagesOf(ctx, c.id);
  for (const [i, s] of rest.entries()) if (s.displayOrder !== i) await ctx.tx.update(cycleStage).set({ displayOrder: i }).where(eq(cycleStage.id, s.id));
  return detailOf(ctx, c.id);
}

/** Refuses when an input of another stage reads one of these outputs (naming it), so nothing is left pointing at nothing. */
async function assertNotRead(ctx: Ctx, outputIds: string[], exceptStageId: string): Promise<void> {
  if (!outputIds.length) return;
  const readers = await ctx.tx.select({ input: cycleInput.name, stage: cycleStage.name }).from(cycleInput).innerJoin(cycleStage, eq(cycleStage.id, cycleInput.stageId))
    .where(and(inArray(cycleInput.outputId, outputIds), sql`${cycleInput.stageId} <> ${exceptStageId}::uuid`));
  if (readers.length) throw new ConflictError(`Another stage reads this: ${readers.map((r) => `"${r.input}" in ${r.stage}`).join(', ')}. Remove those inputs first.`);
}

export async function addOutput(ctx: Ctx, stageId: string, input: AddOutput): Promise<CycleDetail> {
  assertHuman(ctx);
  const { stage, cycle: c } = await loadStage(ctx, stageId);
  await assertManage(ctx, c.responsibleUnitId);
  assertDraft(c, 'Outputs are added');
  if (input.kind !== 'approval' && input.approverUserId) throw new ValidationError('only an approval has an approver');
  if (input.kind !== 'report' && input.reportTemplateKey) throw new ValidationError('only a report has a report template');
  if (input.approverUserId) await assertPerson(ctx, input.approverUserId, 'The approver');
  const existing = await ctx.tx.select({ key: cycleOutput.key }).from(cycleOutput).where(eq(cycleOutput.stageId, stageId));
  const taken = new Set(existing.map((o) => o.key));
  const [row] = await guardIntegrity(() => ctx.tx.insert(cycleOutput).values({
    institutionId: c.institutionId, stageId, key: keyFrom(input.name, taken, input.key), name: nfc(input.name), kind: input.kind, required: input.required ?? true, displayOrder: existing.length,
    reportTemplateKey: input.reportTemplateKey ?? null, approverUserId: input.approverUserId ?? null, approverUnresolved: input.kind === 'approval' && !input.approverUserId,
  }).returning());
  reportUndo(ctx, { label: `Added the output ${row!.name} to ${stage.name}`, method: 'DELETE', path: `/api/cycle-outputs/${row!.id}` });
  return detailOf(ctx, c.id);
}

export async function deleteOutput(ctx: Ctx, outputId: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const { stage, cycle: c } = await loadOutput(ctx, outputId);
  await assertManage(ctx, c.responsibleUnitId);
  assertDraft(c, 'Outputs are removed');
  await assertNotRead(ctx, [outputId], stage.id);
  const sameStage = await ctx.tx.select({ input: cycleInput.name }).from(cycleInput).where(eq(cycleInput.outputId, outputId));
  if (sameStage.length) throw new ConflictError(`An input reads this: ${sameStage.map((r) => `"${r.input}"`).join(', ')}. Remove it first.`);
  await guardIntegrity(() => ctx.tx.delete(cycleOutput).where(eq(cycleOutput.id, outputId)));
  return detailOf(ctx, c.id);
}

/** Adds an input to a stage of a draft cycle: an output of an EARLIER stage, the previous run's output, or a pick. */
export async function addInput(ctx: Ctx, stageId: string, input: AddInput): Promise<CycleDetail> {
  assertHuman(ctx);
  const { stage, cycle: c } = await loadStage(ctx, stageId);
  await assertManage(ctx, c.responsibleUnitId);
  assertDraft(c, 'Inputs are added');
  const given = [input.fromOutputId, input.previousCycle, input.pick].filter((v) => v !== undefined).length;
  if (given !== 1) throw new ValidationError('give exactly one of: an output of an earlier stage, the previous cycle\'s output, or something to pick');
  let outputId: string | null = null;
  let source: 'stage_output' | 'previous_cycle' | 'pick' = 'pick';
  if (input.fromOutputId) {
    const { stage: from } = await loadOutput(ctx, input.fromOutputId);
    if (from.cycleId !== c.id) throw new ValidationError('that output is not in this cycle');
    if (from.displayOrder >= stage.displayOrder) throw new ValidationError('an input can only read an output of an earlier stage');
    outputId = input.fromOutputId; source = 'stage_output';
  } else if (input.previousCycle) {
    source = 'previous_cycle';
    if (c.previousCycleId) {
      const [o] = (await ctx.tx.execute<{ id: string }>(sql`select o.id from cycle_output o join cycle_stage s on s.id = o.stage_id
        where s.cycle_id = ${c.previousCycleId}::uuid and s.key = ${input.previousCycle.stage} and o.key = ${input.previousCycle.output}`)).rows;
      outputId = o?.id ?? null;
    }
  }
  const existing = await ctx.tx.select({ key: cycleInput.key }).from(cycleInput).where(eq(cycleInput.stageId, stageId));
  const taken = new Set(existing.map((o) => o.key));
  const [row] = await guardIntegrity(() => ctx.tx.insert(cycleInput).values({
    institutionId: c.institutionId, stageId, key: keyFrom(input.name, taken, input.key), name: nfc(input.name), source, outputId, displayOrder: existing.length,
    pickKind: source === 'pick' ? input.pick! : null, required: input.required ?? true,
  }).returning());
  reportUndo(ctx, { label: `Added the input ${row!.name} to ${stage.name}`, method: 'DELETE', path: `/api/cycle-inputs/${row!.id}` });
  return detailOf(ctx, c.id);
}

export async function deleteInput(ctx: Ctx, inputId: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const [row] = await ctx.tx.select().from(cycleInput).where(eq(cycleInput.id, inputId));
  if (!row) throw new NotFoundError(`input ${inputId}`);
  const { cycle: c } = await loadStage(ctx, row.stageId);
  await assertManage(ctx, c.responsibleUnitId);
  assertDraft(c, 'Inputs are removed');
  await guardIntegrity(() => ctx.tx.delete(cycleInput).where(eq(cycleInput.id, inputId)));
  return detailOf(ctx, c.id);
}
