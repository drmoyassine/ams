import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { withIdentity } from '@ams/db';
import type { Ctx, JobQueue, ObjectStore } from '../ctx.js';
import type { BiRuntime } from './bi-client.js';
import { beginRun, callBi, createDueRuns, executableRunIds, failRun, finishRun, markLateRuns } from './execute.js';

const noQueue: JobQueue = { send: async () => { throw new Error('The collection tick queues no jobs'); } };
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

export interface CollectTickDeps {
  bi: BiRuntime;
  store?: ObjectStore;
  /** The clock; tests pass a fake one. */
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}
export interface CollectTickResult { tenants: number; created: number; executed: number; late: number; failed: number }

/**
 * The evidence collection tick (job type `collect_tick`, a pg-boss schedule every 15 minutes in the general worker service, TASK-090).
 * It has no tenant of its own, so it first asks the one narrow question the database answers for it (which institutions have a scheduled
 * item or a run waiting), then works each institution in normal identity transactions under a system identity with the worker's database
 * role, which may make and move runs, add the version the BI supplied, send a run's request, open its form and tell the owner, and nothing else.
 *
 * Per institution: make the due runs (one per item and period, whatever the retries), carry out each new or retryable run by its item's
 * method (the BI call is made between two transactions, so no transaction is held open while the BI thinks), then mark late the runs that
 * are past their due time. A failure of one run never stops the others, and none stops the tick: it is logged and kept on the run.
 * Safe to run twice: every step is idempotent.
 */
export async function collectTick(pool: pg.Pool, deps: CollectTickDeps): Promise<CollectTickResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const asWorker = (institutionId: string) => ({ userId: null, institutionId, requestId: crypto.randomUUID(), actorType: 'system' as const, role: 'ams_worker' as const });
  const run = <T>(institutionId: string, fn: (ctx: Ctx) => Promise<T>) => {
    const caller = asWorker(institutionId);
    return withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: noQueue, afterCommit: () => undefined, ...(deps.store ? { store: deps.store } : {}) } as Ctx));
  };
  const tenants = await withIdentity(pool, asWorker(NO_TENANT), async (tx) => (await tx.execute<{ id: string }>(sql`select collection_institutions() as id`)).rows.map((r) => r.id));
  const total: CollectTickResult = { tenants: 0, created: 0, executed: 0, late: 0, failed: 0 };
  for (const institutionId of tenants) {
    total.tenants += 1;
    try {
      const { created, ids } = await run(institutionId, async (ctx) => {
        const made = await createDueRuns(ctx, now());
        return { created: made.created, ids: await executableRunIds(ctx, now()) };
      });
      total.created += created;
      for (const id of ids) {
        try {
          const plan = await run(institutionId, (ctx) => beginRun(ctx, id, now(), deps.bi));
          if (plan.kind === 'bi') {
            const outcome = await callBi(plan, deps.bi); // no transaction is open while the BI answers
            await run(institutionId, (ctx) => finishRun(ctx, id, outcome, now()));
          }
          total.executed += 1;
        } catch (e) {
          // Whatever went wrong is kept on the run (visible on the item), and the next run is still carried out.
          total.failed += 1;
          const message = e instanceof Error ? e.message : String(e);
          log({ level: 'error', msg: 'collection run failed', runId: id, err: message });
          await run(institutionId, (ctx) => failRun(ctx, id, message, true, now())).catch((e2: unknown) => log({ level: 'error', msg: 'collection run failure could not be kept', runId: id, err: String(e2) }));
        }
      }
      total.late += await run(institutionId, (ctx) => markLateRuns(ctx, now()));
    } catch (e) {
      log({ level: 'error', msg: 'collection tick failed for an institution', institutionId, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return total;
}
