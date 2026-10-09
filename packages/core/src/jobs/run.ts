import type pg from 'pg';
import { withIdentity } from '@ams/db';
import { JobEnvelopeSchema, type JobType } from '@ams/shared';
import type { Ctx, JobQueue, ObjectStore } from '../ctx.js';
import { runInAiScope } from '../ai/index.js';
import { getJob, markFailed, markRunning, markSucceeded } from './jobs.js';
import { handlers, type JobHandler } from './handlers.js';

const noQueue: JobQueue = { send: async () => { throw new Error('This worker has no queue to publish follow-up jobs to'); } };

/**
 * Runs one queued job inside the same identity-carrying transaction helper the API uses, as the user who queued it
 * (or the named system identity), with the restricted worker database role. Throws on failure so the queue retries.
 */
export async function runJob(
  pool: pg.Pool,
  type: JobType,
  rawEnvelope: unknown,
  registry: Partial<Record<JobType, JobHandler>> = handlers,
  deps: { store?: ObjectStore; queue?: JobQueue } = {},
): Promise<void> {
  const env = JobEnvelopeSchema.parse(rawEnvelope);
  const handler = registry[type];
  if (!handler) throw new Error(`No handler for job type ${type}`);
  const identity = {
    userId: env.userId, institutionId: env.institutionId, requestId: env.jobId, actorType: env.actorType, role: 'ams_worker' as const,
  };
  // A handler may queue a follow-up job (a multi-step run queues its next step): the job row is written in this job's
  // transaction and published to the queue only after it commits, exactly as from the API.
  let hooks: (() => Promise<void>)[] = [];
  const ctxFor = (tx: Ctx['tx']): Ctx => ({
    tx, caller: identity, queue: deps.queue ?? noQueue, afterCommit: (fn) => { hooks.push(fn); }, ...(deps.store ? { store: deps.store } : {}),
  });

  try {
    await withIdentity(pool, identity, async (tx) => {
      hooks = [];
      const ctx = ctxFor(tx);
      const row = await getJob(ctx, env.jobId); // RLS hides other tenants' rows
      if (row.type !== type || row.createdBy !== env.userId) throw new Error('Job envelope does not match its record');
      await markRunning(ctx, env.jobId);
      // The only place model calls are allowed besides the settings connection test (DEC-012).
      const result = await runInAiScope('job', () => handler(ctx, row.payload as Record<string, unknown>));
      await markSucceeded(ctx, env.jobId, result);
    });
  } catch (e) {
    hooks = [];
    const message = e instanceof Error ? e.message : String(e);
    await withIdentity(pool, identity, (tx) => markFailed(ctxFor(tx), env.jobId, message)).catch(() => undefined);
    throw e;
  }
  for (const fn of hooks) await fn();
}
