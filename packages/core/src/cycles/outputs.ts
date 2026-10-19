// Outputs (the slots a stage fills) and picked inputs: notes, uploaded documents, report slots (a stub until the shared report
// engine, TASK-085), and approvals. An approval is decided only by its named approver; "returned" reopens the stage that
// produced what was reviewed. The wording of an approval is always "Internally approved" (DEC-005) - never met or compliant.
// Evidence files never go to a model: an uploaded document is stored and served back, nothing else (DEC-013).
import { and, eq, inArray } from 'drizzle-orm';
import { cycleInput, cycleOutput, cycleStage } from '@ams/db';
import type { CycleDetail, Decide, SetPick, UpdateOutput } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { assertPermitted } from '../permissions.js';
import { reportUndo } from '../trash/store.js';
import { MAX_UPLOAD_BYTES } from '../evidence/evidence.js';
import {
  assertActive, assertManage, assertPerson, assertWork, checkRef, loadCycle, loadInput, loadOutput, nfcOrNull, type OutputRow, type StageRow,
} from './common.js';
import { loadDetail } from './read.js';

const outputPath = (id: string) => `/api/cycle-outputs/${id}`;
const detailOf = async (ctx: Ctx, cycleId: string) => loadDetail(ctx, await loadCycle(ctx, cycleId));

/** An output can be filled while its cycle runs and its stage is in progress (and, for an approval, only by the approver). */
function assertFillable(c: { status: string }, stage: StageRow, o: OutputRow): void {
  assertActive(c as never, 'fill in outputs');
  if (stage.status !== 'in_progress') throw new ConflictError(`Start the stage "${stage.name}" before filling in "${o.name}".`);
  if (o.state === 'final') throw new ConflictError(`"${o.name}" is final. Reopen it to change it.`);
}

const safeName = (s: string) => [...s.normalize('NFC')].map((ch) => (ch === '/' || ch === '\\' || ch.charCodeAt(0) < 32 ? '_' : ch)).join('').slice(0, 200) || 'file';

/** The text of a `note` output. An empty note makes the output missing again. */
export async function setOutputNote(ctx: Ctx, outputId: string, input: { note: string }): Promise<CycleDetail> {
  assertHuman(ctx);
  const { output, stage, cycle: c } = await loadOutput(ctx, outputId);
  await assertWork(ctx, stage, c);
  if (output.kind !== 'note') throw new ConflictError(`"${output.name}" is not a note.`);
  assertFillable(c, stage, output);
  const note = input.note.normalize('NFC');
  const next = note.trim() ? note : null;
  if (next !== output.note) {
    await guardIntegrity(() => ctx.tx.update(cycleOutput).set({ note: next, state: next ? 'draft' : 'missing' }).where(eq(cycleOutput.id, outputId)));
    reportUndo(ctx, { label: `Wrote ${output.name}`, method: 'PUT', path: `${outputPath(outputId)}/note`, body: { note: output.note ?? '' } });
  }
  return detailOf(ctx, c.id);
}

/** Marks an output final. A document needs its file, a note its text; an approval is made final only by its approver's decision. */
export async function finalizeOutput(ctx: Ctx, outputId: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const { output, stage, cycle: c } = await loadOutput(ctx, outputId);
  if (output.kind === 'approval') throw new ConflictError('An approval is final when its approver decides it.');
  await assertWork(ctx, stage, c);
  assertFillable(c, stage, output);
  if (output.kind === 'document' && !output.fileKey) throw new ConflictError(`Upload the file for "${output.name}" first.`);
  if (output.kind === 'note' && !output.note?.trim()) throw new ConflictError(`Write "${output.name}" first.`);
  await guardIntegrity(() => ctx.tx.update(cycleOutput).set({ state: 'final' }).where(eq(cycleOutput.id, outputId)));
  reportUndo(ctx, { label: `Marked ${output.name} final`, method: 'POST', path: `${outputPath(outputId)}/reopen` });
  return detailOf(ctx, c.id);
}

/** Takes a final output back to a draft so it can change. An approval's decision is a recorded sign-off and is not reopened here. */
export async function reopenOutput(ctx: Ctx, outputId: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const { output, stage, cycle: c } = await loadOutput(ctx, outputId);
  if (output.kind === 'approval') throw new ConflictError('An approval that has been decided is not reopened; the approver decides again only if it is returned.');
  await assertWork(ctx, stage, c);
  assertActive(c, 'reopen an output');
  if (stage.status !== 'in_progress') throw new ConflictError(`Reopen the stage "${stage.name}" first.`);
  if (output.state !== 'final') throw new ConflictError(`"${output.name}" is not final.`);
  await guardIntegrity(() => ctx.tx.update(cycleOutput).set({ state: 'draft' }).where(eq(cycleOutput.id, outputId)));
  reportUndo(ctx, { label: `Reopened ${output.name}`, method: 'POST', path: `${outputPath(outputId)}/finalize` });
  return detailOf(ctx, c.id);
}

/** Who signs an approval (managers; not after it has been decided). */
export async function updateOutput(ctx: Ctx, outputId: string, patch: UpdateOutput): Promise<CycleDetail> {
  assertHuman(ctx);
  const { output, cycle: c } = await loadOutput(ctx, outputId);
  await assertManage(ctx, c.responsibleUnitId);
  if (c.status === 'completed' || c.status === 'cancelled') throw new ConflictError(`The cycle is ${c.status}; its outputs can no longer change.`);
  if (patch.note !== undefined) throw new ValidationError('use the note endpoint to write a note');
  if (patch.approverUserId !== undefined && patch.approverUserId !== output.approverUserId) {
    if (output.kind !== 'approval') throw new ConflictError(`"${output.name}" is not an approval.`);
    if (output.state === 'final') throw new ConflictError('This approval has been signed off; its approver does not change.');
    if (patch.approverUserId) await assertPerson(ctx, patch.approverUserId, 'The approver');
    await guardIntegrity(() => ctx.tx.update(cycleOutput).set({ approverUserId: patch.approverUserId, approverUnresolved: patch.approverUserId === null }).where(eq(cycleOutput.id, outputId)));
    reportUndo(ctx, { label: `Changed who signs ${output.name}`, method: 'PATCH', path: outputPath(outputId), body: { approverUserId: output.approverUserId } });
  }
  return detailOf(ctx, c.id);
}

// ---- Documents ---------------------------------------------------------------------------------------------------------------

export interface CycleFile { fileName: string; mime: string; bytes: Uint8Array }

/** Stores the file of a `document` output (the previous file is removed once this commits). */
export async function uploadOutputFile(ctx: Ctx, outputId: string, file: CycleFile): Promise<CycleDetail> {
  assertHuman(ctx);
  const { output, stage, cycle: c } = await loadOutput(ctx, outputId);
  await assertWork(ctx, stage, c);
  if (output.kind !== 'document') throw new ConflictError(`"${output.name}" is not a document.`);
  assertFillable(c, stage, output);
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  if (file.bytes.byteLength === 0) throw new ValidationError('the file is empty');
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB`);
  const fileName = safeName(file.fileName);
  const key = `${ctx.caller.institutionId}/cycles/${c.id}/${outputId}/${crypto.randomUUID()}/${fileName}`;
  let stored: { size: number };
  try {
    stored = await ctx.store.put(key, file.bytes, file.mime || 'application/octet-stream');
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'cycle output upload: storage refused the file', detail: (e as Error).message }));
    throw new ConflictError(`the file could not be stored (${(e as Error).message})`);
  }
  await guardIntegrity(() => ctx.tx.update(cycleOutput).set({ fileKey: key, fileName, fileMime: file.mime || 'application/octet-stream', fileSize: stored.size, state: 'draft' }).where(eq(cycleOutput.id, outputId)));
  const store = ctx.store;
  if (output.fileKey) { const old = output.fileKey; ctx.afterCommit(async () => { await store.delete(old); }); }
  // Taking back a first upload removes the file; replacing one cannot be taken back (the earlier file is gone).
  if (!output.fileKey) reportUndo(ctx, { label: `Uploaded ${fileName}`, method: 'DELETE', path: `${outputPath(outputId)}/file` });
  return detailOf(ctx, c.id);
}

/** Removes the file of a `document` output. */
export async function removeOutputFile(ctx: Ctx, outputId: string): Promise<CycleDetail> {
  assertHuman(ctx);
  const { output, stage, cycle: c } = await loadOutput(ctx, outputId);
  await assertWork(ctx, stage, c);
  if (output.kind !== 'document') throw new ConflictError(`"${output.name}" is not a document.`);
  assertFillable(c, stage, output);
  if (!output.fileKey) return detailOf(ctx, c.id);
  await guardIntegrity(() => ctx.tx.update(cycleOutput).set({ fileKey: null, fileName: null, fileMime: null, fileSize: null, state: 'missing' }).where(eq(cycleOutput.id, outputId)));
  const store = ctx.store;
  const old = output.fileKey;
  if (store) ctx.afterCommit(async () => { await store.delete(old); });
  return detailOf(ctx, c.id);
}

/** The stored file of a document output, for download. Anyone with cycle:read may read it (row-level security keeps tenants apart). */
export async function readOutputFile(ctx: Ctx, outputId: string): Promise<{ bytes: Uint8Array; mime: string; fileName: string }> {
  await assertPermitted(ctx, 'cycle:read', { type: 'any' });
  const { output } = await loadOutput(ctx, outputId);
  if (!output.fileKey) throw new NotFoundError('this output has no file');
  if (!ctx.store) throw new ConflictError('file storage is not configured');
  const obj = await ctx.store.get(output.fileKey);
  if (!obj) throw new NotFoundError('the stored file is missing');
  return { bytes: obj.body, mime: output.fileMime ?? obj.mime, fileName: output.fileName ?? 'file' };
}

// ---- Approvals ---------------------------------------------------------------------------------------------------------------

/**
 * The named approver decides: approved, approved with conditions, or returned (a comment is required for the last two). The labels
 * are "Internally approved" ... - an internal sign-off, never an official status (DEC-005). A return reopens the stage that produced
 * what the approval's stage reads (and puts the outputs it read back to draft) and leaves the approval undecided for next time.
 * Nobody else can decide it, whatever their permissions; the database enforces the same. A decision is not undone: it is
 * recorded, and "returned" is how it is changed.
 */
export async function decideApproval(ctx: Ctx, outputId: string, input: Decide): Promise<CycleDetail> {
  assertHuman(ctx);
  const { output, stage, cycle: c } = await loadOutput(ctx, outputId);
  if (output.kind !== 'approval') throw new ConflictError(`"${output.name}" is not an approval.`);
  if (!output.approverUserId || output.approverUserId !== ctx.caller.userId) throw new ForbiddenError('Only the named approver can decide this approval.');
  assertActive(c, 'decide an approval');
  if (stage.status !== 'in_progress') throw new ConflictError(`The stage "${stage.name}" has not been started, so there is nothing to decide yet.`);
  if (output.state === 'final') throw new ConflictError('This approval has been decided.');
  const comment = nfcOrNull(input.comment);
  if (input.decision !== 'approved' && !comment) throw new ValidationError(`A comment is required to ${input.decision === 'returned' ? 'return it' : 'approve with conditions'}.`);

  if (input.decision === 'returned') {
    // What did this stage read? The stages that produced it are where the work goes back to.
    const reads = await ctx.tx.select({ outputId: cycleInput.outputId }).from(cycleInput).where(and(eq(cycleInput.stageId, stage.id), eq(cycleInput.source, 'stage_output')));
    const readIds = reads.map((r) => r.outputId).filter((x): x is string => !!x);
    const producers = readIds.length
      ? await ctx.tx.select({ outputId: cycleOutput.id, stageId: cycleStage.id, order: cycleStage.displayOrder, status: cycleStage.status })
        .from(cycleOutput).innerJoin(cycleStage, eq(cycleStage.id, cycleOutput.stageId)).where(and(inArray(cycleOutput.id, readIds), eq(cycleStage.cycleId, c.id)))
      : [];
    const target = producers.filter((p) => p.status === 'completed' || p.status === 'in_progress').sort((a, b) => b.order - a.order)[0];
    if (!target) throw new ConflictError('There is no earlier stage to return this to: this stage reads no output of an earlier stage that has been worked on.');
    if (target.status === 'completed') await guardIntegrity(() => ctx.tx.update(cycleStage).set({ status: 'in_progress' }).where(eq(cycleStage.id, target.stageId)));
    const back = producers.filter((p) => p.stageId === target.stageId).map((p) => p.outputId);
    await guardIntegrity(() => ctx.tx.update(cycleOutput).set({ state: 'draft' }).where(and(inArray(cycleOutput.id, back), eq(cycleOutput.state, 'final'))));
  }
  await guardIntegrity(() => ctx.tx.update(cycleOutput).set({
    decision: input.decision, decisionComment: comment, state: input.decision === 'returned' ? 'draft' : 'final',
  }).where(eq(cycleOutput.id, outputId)));
  return detailOf(ctx, c.id);
}

// ---- Picked inputs -----------------------------------------------------------------------------------------------------------

const PICK_FITS: Record<string, readonly string[]> = { document: ['document'], evidence: ['evidence_item'], requirement: ['requirement'], any: ['document', 'evidence_item', 'requirement'] };

/** Fills (or clears) a picked input with a document, an evidence item or a standard of this institution. */
export async function setInputPick(ctx: Ctx, inputId: string, input: SetPick): Promise<CycleDetail> {
  assertHuman(ctx);
  const { input: inp, stage, cycle: c } = await loadInput(ctx, inputId);
  await assertWork(ctx, stage, c);
  assertActive(c, 'pick an input');
  if (stage.status === 'completed' || stage.status === 'skipped') throw new ConflictError(`The stage "${stage.name}" is ${stage.status}; reopen it first.`);
  if (inp.source !== 'pick') throw new ConflictError(`"${inp.name}" is read from an output; it is not picked.`);
  if (input.refKind) {
    if (!input.refId) throw new ValidationError('say which one');
    if (!PICK_FITS[inp.pickKind ?? 'any']!.includes(input.refKind)) throw new ValidationError(`"${inp.name}" takes ${inp.pickKind === 'evidence' ? 'an evidence item' : `a ${inp.pickKind}`}`);
    await checkRef(ctx, input.refKind, input.refId);
  }
  const next = input.refKind && input.refId ? { refKind: input.refKind, refId: input.refId } : { refKind: null, refId: null };
  await guardIntegrity(() => ctx.tx.update(cycleInput).set(next).where(eq(cycleInput.id, inputId)));
  reportUndo(ctx, { label: `${next.refId ? 'Picked' : 'Cleared'} ${inp.name}`, method: 'PUT', path: `/api/cycle-inputs/${inputId}/pick`, body: { refKind: inp.refKind, refId: inp.refId } });
  return detailOf(ctx, c.id);
}

