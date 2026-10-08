import type pg from 'pg';
import { withIdentity } from '@ams/db';
import { JobEnvelopeSchema, type JobType } from '@ams/shared';
import type { Ctx, JobQueue, ObjectStore } from '../ctx.js';
import { getJob, markFailed, markRunning, markSucceeded } from './jobs.js';
import { handlers, type JobHandler } from './handlers.js';

const noQueue: JobQueue = { send: async () => { throw new Error('Workers do not publish jobs from inside a job'); } };

/**
 * Runs one queued job inside the same identity-carrying transaction helper the API uses, as the user who queued it
 * (or the named system identity), with the restricted worker database role. Throws on failure so the queue retries.
 */
export async function runJob(
  pool: pg.Pool,
  type: JobType,
  rawEnvelope: unknown,
  registry: Partial<Record<JobType, JobHandler>> = handlers,
  deps: { store?: ObjectStore } = {},
): Promise<void> {
  const env = JobEnvelopeSchema.parse(rawEnvelope);
  const handler = registry[type];
  if (!handler) throw new Error(`No handler for job type ${type}`);
  const identity = {
    userId: env.userId, institutionId: env.institutionId, requestId: env.jobId, actorType: env.actorType, role: 'ams_worker' as const,
  };
  const ctxFor = (tx: Ctx['tx']): Ctx => ({ tx, caller: identity, queue: noQueue, afterCommit: () => { throw new Error('afterCommit is not available in jobs'); }, ...(deps.store ? { store: deps.store } : {}) });

  try {
    await withIdentity(pool, identity, async (tx) => {
      const ctx = ctxFor(tx);
      const row = await getJob(ctx, env.jobId); // RLS hides other tenants' rows
      if (row.type !== type || row.createdBy !== env.userId) throw new Error('Job envelope does not match its record');
      await markRunning(ctx, env.jobId);
      const result = await handler(ctx, row.payload as Record<string, unknown>);
      await markSucceeded(ctx, env.jobId, result);
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await withIdentity(pool, identity, (tx) => markFailed(ctxFor(tx), env.jobId, message)).catch(() => undefined);
    throw e;
  }
}
