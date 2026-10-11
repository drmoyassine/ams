import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { ensureQueues, handlers, pgBossQueue, runJob, type ObjectStore } from '@ams/core';
import { JOB_TYPES, type JobType } from '@ams/shared';

export interface WorkerOptions {
  pollingIntervalSeconds?: number;
  store?: ObjectStore;
  /** The job types this process takes (WORKER_QUEUES, DEC-024). Default: every type that has a handler. */
  queues?: readonly JobType[];
}

/**
 * Subscribes to the job types this process is responsible for (every type by default). Each job runs through runJob
 * (identity-carrying transaction). Returns the types actually subscribed to.
 */
export async function startWorker(boss: PgBoss, pool: pg.Pool, opts: WorkerOptions = {}): Promise<JobType[]> {
  await ensureQueues(boss); // every queue exists whichever service starts first, so a job can be sent to any of them
  // A job may queue a follow-up (each step of a framework analysis queues the next), published after it commits.
  const queue = pgBossQueue(boss);
  const wanted = opts.queues ?? JOB_TYPES;
  const subscribed: JobType[] = [];
  for (const type of wanted) {
    if (!handlers[type]) continue;
    await boss.work(type, { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 }, async (jobs) => {
      for (const j of jobs) await runJob(pool, type, j.data, handlers, { queue, ...(opts.store ? { store: opts.store } : {}) });
    });
    subscribed.push(type);
  }
  return subscribed;
}
