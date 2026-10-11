import { eq, sql } from 'drizzle-orm';
import { job } from '@ams/db';
import type { JobType } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { NotFoundError } from '../ctx.js';

/**
 * Records a job row as the caller (audited, RLS-scoped) and publishes it to the queue once the transaction commits,
 * so a rolled-back request never leaves work behind.
 */
export async function enqueueJob(ctx: Ctx, input: { type: JobType; payload: Record<string, unknown>; delaySeconds?: number }) {
  const [row] = await ctx.tx.insert(job).values({
    institutionId: ctx.caller.institutionId, type: input.type, payload: input.payload,
  }).returning();
  const created = row!;
  ctx.afterCommit(() => ctx.queue.send(input.type, {
    jobId: created.id,
    institutionId: ctx.caller.institutionId,
    userId: ctx.caller.userId,
    actorType: ctx.caller.actorType ?? (ctx.caller.userId ? 'user' : 'system'),
  }, input.delaySeconds ? { delaySeconds: input.delaySeconds } : undefined));
  return { id: created.id, status: created.status };
}

export async function getJob(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(job).where(eq(job.id, id));
  if (!row) throw new NotFoundError(`job ${id}`);
  return row;
}

export const markRunning = (ctx: Ctx, id: string) =>
  ctx.tx.update(job).set({ status: 'running', attempts: sql`${job.attempts} + 1`, error: null }).where(eq(job.id, id));
export const markSucceeded = (ctx: Ctx, id: string, result: unknown) =>
  ctx.tx.update(job).set({ status: 'succeeded', result }).where(eq(job.id, id));
/**
 * Written in its own transaction after the job's rolled back, so the attempt markRunning counted there is counted again
 * here: a job's attempts are its failures so far (plus one while it runs). Multi-step runs read it to stop retrying.
 */
export const markFailed = (ctx: Ctx, id: string, error: string) =>
  ctx.tx.update(job).set({ status: 'failed', error, attempts: sql`${job.attempts} + 1` }).where(eq(job.id, id));
