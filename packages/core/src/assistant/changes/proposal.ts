// The proposal, its confirmation and its application (DEC-027 Phase 2).
//
//   propose  (the model's job, read-only)   operations -> plan -> a `change_proposal` part in the assistant message. NOTHING is written
//                                            besides the part, and the model has no way to do more.
//   confirm  (the person's "Do it" press)    re-plans on the data as it is now, dry-runs it through the services (rolled back), and only
//                                            then issues a one-time token tied to the person, the message part and the hash of this
//                                            exact change set. A changed proposal has another hash and needs a new confirmation.
//   apply    (the same press, with the token) consumes the token atomically, re-plans, and applies ALL operations in ONE transaction as
//                                            the person through the core services; reports ONE undo descriptor.
//   undo / redo                               replay the stored descriptors the services reported (see execute.ts).
//
// Everything here runs in the API request of a signed-in person, in the five-step chain; none of it runs in a job.
import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { assistantChangeSet, assistantConfirmation, assistantMessage, assistantWrittenText, requirement } from '@ams/db';
import {
  CONFIRMATION_MINUTES, ChangeProposalPartSchema, ChangeSetInputSchema, type ChangeProposalPart, type ChangeSetInput, type Operation, type WrittenText,
} from '@ams/shared';
import type { Ctx } from '../../ctx.js';
import { ConflictError, NotFoundError } from '../../ctx.js';
import { assertHuman, require_ } from '../../framework/common.js';
import { updateRequirement } from '../../framework/requirements.js';
import { reportUndo } from '../../trash/store.js';
import { dryRunPlan, executePlan, inSavepoint, reasonOf, replay } from './execute.js';
import { hashOf, hashToken } from './hash.js';
import { planChangeSet } from './plan.js';
import { countUnreviewedWrittenTexts } from './marks.js';
import type { Plan } from './types.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The hash the confirmation is tied to: the version and the exact operations. */
export const changeSetHashOf = (versionId: string, operations: readonly Operation[]): string => hashOf({ versionId, operations });

/** What the person sees when a change was applied. */
export function appliedMessage(plan: Plan): string {
  if (plan.newDraft) return `Started the draft ${plan.newDraft.edition} from ${plan.versionLabel}`;
  const skipped = plan.skippedCount ? ` · ${plural(plan.skippedCount, 'item')} skipped` : '';
  return `Changed ${plural(plan.items, 'item')} in ${plan.versionLabel}${skipped}`;
}
const undoLabel = (plan: Plan) => (plan.newDraft ? `Started the draft ${plan.newDraft.edition}` : `Changed ${plural(plan.items, 'item')} in ${plan.versionLabel}`);

/** The part the chat shows. `dryRun.ok` here means the in-memory simulation found nothing in the way; the services re-check at confirm time. */
export function buildProposalPart(id: string, input: ChangeSetInput, plan: Plan): ChangeProposalPart {
  return ChangeProposalPartSchema.parse({
    id, type: 'change_proposal', status: 'pending', versionId: input.versionId, versionLabel: plan.versionLabel, summary: input.summary, operations: input.operations,
    changeSetHash: changeSetHashOf(input.versionId, input.operations), planHash: plan.planHash, counts: plan.counts, examples: plan.examples, skipped: plan.skipped,
    skippedCount: plan.skippedCount, deletes: plan.deletes, deletesCount: plan.deletesCount, warnings: plan.warnings, dryRun: { ok: plan.problems.length === 0, problems: plan.problems },
    remaining: plan.remaining, newDraft: plan.newDraft, result: null, error: null,
  });
}

const inputOf = (part: ChangeProposalPart): ChangeSetInput => ChangeSetInputSchema.parse({ versionId: part.versionId, summary: part.summary, operations: part.operations });

// ---- Reading and writing the part ------------------------------------------------------------------------------------------------
interface Loaded { messageId: string; status: string | null; raw: unknown[]; index: number; part: ChangeProposalPart }

async function loadProposal(ctx: Ctx, messageId: string, partId: string): Promise<Loaded> {
  // Row-level security keeps this to messages of the person's own conversations: someone else's message is simply not found.
  const [msg] = await ctx.tx.select().from(assistantMessage).where(eq(assistantMessage.id, messageId));
  if (!msg || msg.role !== 'assistant') throw new NotFoundError('that message does not exist');
  const raw = Array.isArray(msg.parts) ? (msg.parts as unknown[]) : [];
  const index = raw.findIndex((p) => (p as { id?: string; type?: string })?.id === partId && (p as { type?: string }).type === 'change_proposal');
  if (index < 0) throw new NotFoundError('that proposal does not exist');
  const parsed = ChangeProposalPartSchema.safeParse(raw[index]);
  if (!parsed.success) throw new ConflictError('this proposal cannot be read any more; ask the assistant again');
  return { messageId, status: msg.status, raw, index, part: parsed.data };
}

async function savePart(ctx: Ctx, l: Loaded, patch: Partial<ChangeProposalPart>): Promise<ChangeProposalPart> {
  const next = ChangeProposalPartSchema.parse({ ...l.part, ...patch });
  const raw = [...l.raw];
  raw[l.index] = next;
  await ctx.tx.update(assistantMessage).set({ parts: raw }).where(eq(assistantMessage.id, l.messageId));
  return next;
}

const statusSentence: Record<string, string> = {
  applied: 'This change was already made.', failed: 'This proposal could not be applied. Ask the assistant again.', cancelled: 'This proposal was cancelled.',
  superseded: 'This proposal was replaced by a newer one.', stale: 'This proposal changed or expired: ask the assistant again.',
};

/** When the person writes again, proposals they have not answered are replaced: a new request needs a new proposal and a new confirmation. */
export async function supersedePendingProposals(ctx: Ctx, conversationId: string): Promise<number> {
  const rows = await ctx.tx.select({ id: assistantMessage.id, parts: assistantMessage.parts }).from(assistantMessage)
    .where(and(eq(assistantMessage.conversationId, conversationId), eq(assistantMessage.role, 'assistant')));
  let n = 0;
  for (const m of rows) {
    const parts = Array.isArray(m.parts) ? (m.parts as { type?: string; status?: string }[]) : [];
    if (!parts.some((p) => p?.type === 'change_proposal' && p.status === 'pending')) continue;
    const next = parts.map((p) => (p?.type === 'change_proposal' && p.status === 'pending' ? (n++, { ...p, status: 'superseded' }) : p));
    await ctx.tx.update(assistantMessage).set({ parts: next }).where(eq(assistantMessage.id, m.id));
  }
  return n;
}

// ---- Confirm ---------------------------------------------------------------------------------------------------------------------------
export interface ConfirmResult { status: 'ready' | 'stale'; message: string | null; token: string | null; expiresAt: string | null; changeSetHash: string; part: ChangeProposalPart }

/**
 * The "Do it" press. Only a signed-in person's request gets here (the route is the five-step chain and this asserts a human), only for
 * a proposal in their own conversation that is still pending and whose turn has finished. It re-plans on the data as it is now and
 * dry-runs it through the real services; a proposal that no longer holds is marked stale instead of getting a token.
 */
export async function confirmChangeProposal(ctx: Ctx, messageId: string, partId: string): Promise<ConfirmResult> {
  assertHuman(ctx);
  await require_(ctx, 'framework:write');
  const l = await loadProposal(ctx, messageId, partId);
  if (l.status !== 'done') throw new ConflictError('The assistant is still working on this answer. Wait for it to finish.');
  if (l.part.status !== 'pending') throw new ConflictError(statusSentence[l.part.status] ?? 'This proposal can no longer be applied.');
  const stale = async (message: string): Promise<ConfirmResult> => {
    const part = await savePart(ctx, l, { status: 'stale', error: message });
    return { status: 'stale', message, token: null, expiresAt: null, changeSetHash: l.part.changeSetHash, part };
  };
  if (changeSetHashOf(l.part.versionId, l.part.operations) !== l.part.changeSetHash) return stale('This proposal changed after it was made. Ask the assistant again.');
  const plan = await planChangeSet(ctx, inputOf(l.part));
  if (plan.problems.length) return stale(plan.problems[0]!);
  if (plan.planHash !== l.part.planHash) return stale('The standards changed since this was proposed, so the result would not be what I described. Ask the assistant again.');
  const dry = await dryRunPlan(ctx, plan);
  if (!dry.ok) return stale(dry.reason);

  // Only one live token per proposal: an earlier one is retired.
  await ctx.tx.update(assistantConfirmation).set({ consumedAt: sql`now()`, consumedResult: 'superseded' })
    .where(and(eq(assistantConfirmation.messageId, messageId), eq(assistantConfirmation.partId, partId), isNull(assistantConfirmation.consumedAt)));
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CONFIRMATION_MINUTES * 60_000);
  await ctx.tx.insert(assistantConfirmation).values({
    institutionId: ctx.caller.institutionId, userId: ctx.caller.userId!, messageId, partId, changeSetHash: l.part.changeSetHash, planHash: plan.planHash,
    tokenHash: hashToken(token), expiresAt,
  });
  return { status: 'ready', message: null, token, expiresAt: expiresAt.toISOString(), changeSetHash: l.part.changeSetHash, part: l.part };
}

// ---- Apply -----------------------------------------------------------------------------------------------------------------------------
export interface ApplyResult { status: 'applied' | 'failed' | 'stale'; message: string; part: ChangeProposalPart }

/**
 * Applies a confirmed proposal. The token is consumed first, atomically and once; whatever happens afterwards the token is spent. The
 * operations are planned again on the data as it is NOW: if the result is not exactly what was confirmed, nothing is changed and the
 * proposal is marked stale (a new confirmation is needed). Otherwise every step runs in ONE transaction as the person, through the
 * core services; one failing step rolls back all of them.
 */
export async function applyChangeProposal(ctx: Ctx, messageId: string, partId: string, token: string): Promise<ApplyResult> {
  assertHuman(ctx);
  await require_(ctx, 'framework:write');
  const l = await loadProposal(ctx, messageId, partId);
  if (l.part.status !== 'pending') throw new ConflictError(statusSentence[l.part.status] ?? 'This proposal can no longer be applied.');
  const consumed = await ctx.tx.update(assistantConfirmation).set({ consumedAt: sql`now()`, consumedResult: 'consuming' }).where(and(
    eq(assistantConfirmation.tokenHash, hashToken(token)), eq(assistantConfirmation.userId, ctx.caller.userId!), eq(assistantConfirmation.messageId, messageId),
    eq(assistantConfirmation.partId, partId), isNull(assistantConfirmation.consumedAt), gt(assistantConfirmation.expiresAt, sql`now()`),
  )).returning();
  const conf = consumed[0];
  if (!conf) throw new ConflictError('This confirmation was already used, has expired or is not valid. Press Do it again.', { code: 'confirmation' });

  const finish = async (status: ApplyResult['status'], message: string, patch: Partial<ChangeProposalPart>): Promise<ApplyResult> => {
    await ctx.tx.update(assistantConfirmation).set({ consumedResult: status }).where(eq(assistantConfirmation.id, conf.id));
    const part = await savePart(ctx, l, patch);
    return { status, message, part };
  };
  const hash = changeSetHashOf(l.part.versionId, l.part.operations);
  if (hash !== conf.changeSetHash || hash !== l.part.changeSetHash) {
    return finish('stale', 'This proposal changed after you confirmed it. Nothing was changed; ask the assistant again.', { status: 'stale', error: 'This proposal changed after it was confirmed.' });
  }
  const input = inputOf(l.part);
  const plan = await planChangeSet(ctx, input);
  if (plan.problems.length || plan.planHash !== conf.planHash) {
    const why = plan.problems[0] ?? 'The standards changed since this was proposed, so the result would not be what I described.';
    return finish('stale', `Nothing was changed. ${why} Ask the assistant again.`, { status: 'stale', error: why });
  }
  const run = await inSavepoint(ctx, 'assistant_apply', () => executePlan(ctx, plan));
  if (!run.ok) {
    const why = reasonOf(run.error);
    return finish('failed', `Nothing was changed. ${why}`, { status: 'failed', error: why });
  }

  const label = undoLabel(plan);
  const [set] = await ctx.tx.insert(assistantChangeSet).values({
    institutionId: ctx.caller.institutionId, userId: ctx.caller.userId!, messageId, partId, versionId: plan.versionId, summary: input.summary,
    changeSetHash: hash, operations: input.operations, counts: { ...plan.counts, skipped: plan.skippedCount, label, steps: plan.steps.length }, inverse: run.value.inverse,
  }).returning();
  if (plan.written.length) {
    await ctx.tx.insert(assistantWrittenText).values(plan.written.map((w) => ({
      institutionId: ctx.caller.institutionId, changeSetId: set!.id, versionId: plan.versionId, requirementId: w.requirementId, field: w.field, text: w.text, previous: w.previous,
    })));
  }
  const message = appliedMessage(plan);
  const result = await finish('applied', message, {
    status: 'applied', error: null,
    result: { changeSetId: set!.id, state: 'applied', message, items: plan.items, appliedAt: set!.appliedAt.toISOString(), newVersionId: run.value.newVersionId },
  });
  // ONE descriptor for the whole group: small enough for the header, however many rows changed.
  reportUndo(ctx, { label, method: 'POST', path: `/api/assistant/changes/${set!.id}/undo` });
  return result;
}

/** "Cancel": the proposal is closed; nothing was changed and nothing can apply it any more. */
export async function declineChangeProposal(ctx: Ctx, messageId: string, partId: string): Promise<ChangeProposalPart> {
  assertHuman(ctx);
  const l = await loadProposal(ctx, messageId, partId);
  if (l.part.status !== 'pending') return l.part;
  await ctx.tx.update(assistantConfirmation).set({ consumedAt: sql`now()`, consumedResult: 'superseded' })
    .where(and(eq(assistantConfirmation.messageId, messageId), eq(assistantConfirmation.partId, partId), isNull(assistantConfirmation.consumedAt)));
  return savePart(ctx, l, { status: 'cancelled' });
}

// ---- Undo and redo ---------------------------------------------------------------------------------------------------------------------
export interface ChangeSetState { id: string; state: 'applied' | 'undone'; message: string; items: number; versionId: string; part: ChangeProposalPart | null }

async function ownChangeSet(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(assistantChangeSet).where(eq(assistantChangeSet.id, id));
  if (!row) throw new NotFoundError('that change does not exist');
  return row;
}

async function syncPart(ctx: Ctx, row: typeof assistantChangeSet.$inferSelect, state: 'applied' | 'undone'): Promise<ChangeProposalPart | null> {
  if (!row.messageId || !row.partId) return null;
  try {
    const l = await loadProposal(ctx, row.messageId, row.partId);
    if (!l.part.result) return l.part;
    return await savePart(ctx, l, { result: { ...l.part.result, state } });
  } catch { return null; }
}

const countsOf = (row: typeof assistantChangeSet.$inferSelect) => {
  const c = row.counts as { items?: number; label?: string };
  return { items: c.items ?? 0, label: c.label ?? 'the change' };
};

/** Takes the whole change set back in one transaction: the stored descriptors run in order; what they report becomes the redo. */
export async function undoChangeSet(ctx: Ctx, id: string): Promise<ChangeSetState> {
  assertHuman(ctx);
  await require_(ctx, 'framework:write');
  const row = await ownChangeSet(ctx, id);
  if (row.state !== 'applied') throw new ConflictError('This change was already undone.');
  let captured;
  try { captured = await replay(ctx, row.inverse as unknown[]); } catch (e) { throw new ConflictError(`Cannot undo: ${reasonOf(e)}`); }
  const [next] = await ctx.tx.update(assistantChangeSet).set({ state: 'undone', inverse: captured, undoneAt: new Date() }).where(eq(assistantChangeSet.id, id)).returning();
  const part = await syncPart(ctx, next!, 'undone');
  const { items, label } = countsOf(row);
  reportUndo(ctx, { label, method: 'POST', path: `/api/assistant/changes/${id}/redo` });
  return { id, state: 'undone', message: `Undone: ${label}`, items, versionId: row.versionId, part };
}

/** Re-applies an undone change set: the same steps, run again through the services with their checks (a version published meanwhile refuses it). */
export async function redoChangeSet(ctx: Ctx, id: string): Promise<ChangeSetState> {
  assertHuman(ctx);
  await require_(ctx, 'framework:write');
  const row = await ownChangeSet(ctx, id);
  if (row.state !== 'undone') throw new ConflictError('This change is already in place.');
  let captured;
  try { captured = await replay(ctx, row.inverse as unknown[]); } catch (e) { throw new ConflictError(`Cannot redo: ${reasonOf(e)}`); }
  const [next] = await ctx.tx.update(assistantChangeSet).set({ state: 'applied', inverse: captured, undoneAt: null }).where(eq(assistantChangeSet.id, id)).returning();
  const part = await syncPart(ctx, next!, 'applied');
  const { items, label } = countsOf(row);
  reportUndo(ctx, { label, method: 'POST', path: `/api/assistant/changes/${id}/undo` });
  return { id, state: 'applied', message: `Done again: ${label}`, items, versionId: row.versionId, part };
}

export async function listChangeSets(ctx: Ctx, limit = 20) {
  const rows = await ctx.tx.select().from(assistantChangeSet).orderBy(desc(assistantChangeSet.appliedAt)).limit(limit);
  return rows.map((r) => ({ id: r.id, state: r.state, appliedAt: r.appliedAt.toISOString(), versionId: r.versionId, ...countsOf(r) }));
}

// ---- Texts the assistant wrote ---------------------------------------------------------------------------------------------------------
type WrittenRow = typeof assistantWrittenText.$inferSelect;

const currentValue = (r: typeof requirement.$inferSelect, field: string) => (field === 'title' ? r.title : field === 'officialText' ? r.officialText : r.translationEn);

/** Pending markers of a version whose field still holds exactly the text the assistant wrote. */
export async function listWrittenTexts(ctx: Ctx, versionId: string): Promise<WrittenText[]> {
  await require_(ctx, 'framework:read');
  const rows = await ctx.tx.select({ w: assistantWrittenText, r: requirement }).from(assistantWrittenText)
    .innerJoin(requirement, eq(requirement.id, assistantWrittenText.requirementId))
    .where(and(eq(assistantWrittenText.versionId, versionId), eq(assistantWrittenText.state, 'pending')));
  return rows.filter(({ w, r }) => currentValue(r, w.field) === w.text).map(({ w }) => ({
    id: w.id, requirementId: w.requirementId, field: w.field as WrittenText['field'], changeSetId: w.changeSetId, hasPrevious: w.previous !== null, writtenAt: w.createdAt.toISOString(),
  }));
}

async function ownWritten(ctx: Ctx, id: string): Promise<WrittenRow> {
  const [row] = await ctx.tx.select().from(assistantWrittenText).where(eq(assistantWrittenText.id, id));
  if (!row) throw new NotFoundError('that marker does not exist');
  return row;
}

/** "Keep": the person has read the text and accepts it; the marker goes. */
export async function keepWrittenText(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await require_(ctx, 'framework:write');
  const row = await ownWritten(ctx, id);
  if (row.state !== 'pending') return;
  await ctx.tx.update(assistantWrittenText).set({ state: 'kept', decidedBy: ctx.caller.userId, decidedAt: new Date() }).where(eq(assistantWrittenText.id, id));
}

/** "Revert": the earlier value comes back through the normal edit (so it is undoable like any edit), and the marker goes. */
export async function revertWrittenText(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await require_(ctx, 'framework:write');
  const row = await ownWritten(ctx, id);
  if (row.state !== 'pending') throw new ConflictError('This text was already reviewed.');
  const [req] = await ctx.tx.select().from(requirement).where(eq(requirement.id, row.requirementId));
  if (!req) throw new NotFoundError('that item no longer exists');
  if (currentValue(req, row.field) !== row.text) throw new ConflictError('This text was changed after the assistant wrote it, so there is nothing of the assistant\'s to revert.');
  if (row.field === 'title' && !row.previous) throw new ConflictError('The earlier title is not available.');
  await updateRequirement(ctx, req.id, { [row.field]: row.previous } as { title?: string; officialText?: string | null; translationEn?: string | null });
  await ctx.tx.update(assistantWrittenText).set({ state: 'reverted', decidedBy: ctx.caller.userId, decidedAt: new Date() }).where(eq(assistantWrittenText.id, id));
}


export { countUnreviewedWrittenTexts };
