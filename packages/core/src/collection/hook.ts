// A new version of an evidence item supplies its oldest open collection run (TASK-090): the owner uploads or registers a file, saves data
// or adds form responses, and the period that was waiting for it is answered, whatever the method asked for. A person's own upload is
// the usual way a `manual` run is supplied; for the other methods it is a person stepping in. Runs the BI or a request supplies name
// their own run and do not come through here. Kept apart from the rest of the collection code so the evidence services can call it
// without a circular import.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { evidenceCollectionRun } from '@ams/db';
import type { Ctx } from '../ctx.js';

/** Marks the oldest pending, requested or late run of the item as supplied by this version; returns its id, or null when none is open. */
export async function supplyOldestOpenRun(ctx: Ctx, itemId: string, versionId: string, now: Date = new Date()): Promise<string | null> {
  const [run] = await ctx.tx.select({ id: evidenceCollectionRun.id }).from(evidenceCollectionRun)
    .where(and(eq(evidenceCollectionRun.evidenceItemId, itemId), inArray(evidenceCollectionRun.status, ['pending', 'requested', 'late'])))
    .orderBy(asc(evidenceCollectionRun.scheduledFor)).limit(1).for('update');
  if (!run) return null;
  await markRunSupplied(ctx, run.id, versionId, now, { source: 'version' });
  return run.id;
}

/** Marks one run supplied by a version of its item (the database checks that the version is the item's, and clears the BI's token). */
export async function markRunSupplied(ctx: Ctx, runId: string, versionId: string, now: Date, details: Record<string, unknown> = {}): Promise<void> {
  await ctx.tx.update(evidenceCollectionRun).set({
    status: 'supplied', versionId, respondedAt: now, lastError: null, nextAttemptAt: null,
    details: sql`${evidenceCollectionRun.details} || ${JSON.stringify(details)}::jsonb`,
  }).where(eq(evidenceCollectionRun.id, runId));
}
