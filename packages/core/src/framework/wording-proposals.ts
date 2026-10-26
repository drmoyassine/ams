// Wording proposals (TASK-107): the analysis proposes replacing an existing item's wording, quoting the passage it
// based the proposal on; a person accepts or declines. Accepting edits the draft's requirement (one edit, undoable like
// any other); declining closes the proposal. Nothing is ever applied by itself (DEC-006), and a published version is
// never touched — the requirement's edit path refuses it on its own.
import { and, desc, eq, ne } from 'drizzle-orm';
import { requirement, wordingProposal } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { assertHuman, getRequirement, getVersion, require_ } from './common.js';
import { updateRequirement } from './requirements.js';

/** The proposal with its item's code as it is now — the shape the API returns. */
const withCode = {
  id: wordingProposal.id, frameworkVersionId: wordingProposal.frameworkVersionId, requirementId: wordingProposal.requirementId,
  requirementCode: requirement.code, analysisRunId: wordingProposal.analysisRunId, sourceDocumentId: wordingProposal.sourceDocumentId,
  sourcePage: wordingProposal.sourcePage, sourceQuote: wordingProposal.sourceQuote, currentText: wordingProposal.currentText,
  proposedText: wordingProposal.proposedText, reason: wordingProposal.reason, status: wordingProposal.status,
  decidedBy: wordingProposal.decidedBy, decidedAt: wordingProposal.decidedAt, createdAt: wordingProposal.createdAt,
};

/** A version's wording proposals, newest first. */
export async function listWordingProposals(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:read');
  await getVersion(ctx, versionId);
  return ctx.tx.select(withCode).from(wordingProposal)
    .innerJoin(requirement, eq(requirement.id, wordingProposal.requirementId))
    .where(eq(wordingProposal.frameworkVersionId, versionId))
    .orderBy(desc(wordingProposal.createdAt));
}

export const DecideWordingSchema = z.object({ accept: z.boolean() }).strict();

/**
 * Decides one pending proposal. Accepting writes the proposed wording onto the requirement (which sends it back to
 * review and reports the undo, as any edit does), and declines the item's other pending proposals — they were written
 * against wording that is no longer there, and exactly one wording can be in force. Refuses when the requirement's
 * wording has changed since the proposal was made: the diff a person would be accepting is not the diff it shows.
 */
export async function decideWordingProposal(ctx: Ctx, id: string, input: z.input<typeof DecideWordingSchema>) {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const { accept } = DecideWordingSchema.parse(input);
  const [row] = await ctx.tx.select().from(wordingProposal).where(eq(wordingProposal.id, id));
  if (!row) throw new NotFoundError(`wording proposal ${id}`);
  if (row.status !== 'pending') throw new ConflictError(`this proposal has already been ${row.status}`);
  const req = await getRequirement(ctx, row.requirementId);
  await getVersion(ctx, req.frameworkVersionId); // an accepted proposal edits the draft; a published version is immutable
  const decided = { status: accept ? ('accepted' as const) : ('declined' as const), decidedBy: ctx.caller.userId!, decidedAt: new Date() };

  if (accept) {
    if ((req.officialText ?? '').trim() !== row.currentText.trim()) {
      throw new ConflictError('this item\'s wording has changed since the proposal was made; look at it again and analyse once more if needed');
    }
    await updateRequirement(ctx, req.id, { officialText: row.proposedText });
    // The siblings were proposals for the same wording; with one accepted they no longer apply to what is there.
    await ctx.tx.update(wordingProposal).set({ status: 'declined', decidedBy: ctx.caller.userId!, decidedAt: decided.decidedAt })
      .where(and(eq(wordingProposal.requirementId, req.id), eq(wordingProposal.status, 'pending'), ne(wordingProposal.id, id)));
  }
  const [out] = await ctx.tx.update(wordingProposal).set(decided).where(eq(wordingProposal.id, id)).returning({ id: wordingProposal.id });
  const [proposal] = await ctx.tx.select(withCode).from(wordingProposal)
    .innerJoin(requirement, eq(requirement.id, wordingProposal.requirementId))
    .where(eq(wordingProposal.id, out!.id));
  return proposal!;
}
