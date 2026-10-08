import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { ensureQueues, handlers, runJob, type ObjectStore } from '@ams/core';
import { JOB_TYPES } from '@ams/shared';

/** Subscribes to every job type that has a handler. Each job runs through runJob (identity-carrying transaction). */
export async function startWorker(boss: PgBoss, pool: pg.Pool, opts: { pollingIntervalSeconds?: number; store?: ObjectStore } = {}) {
  await ensureQueues(boss);
  for (const type of JOB_TYPES) {
    if (!handlers[type]) continue;
    await boss.work(type, { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 }, async (jobs) => {
      for (const j of jobs) await runJob(pool, type, j.data, handlers, opts.store ? { store: opts.store } : {});
    });
  }
}
