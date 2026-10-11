import type { PgBoss } from 'pg-boss';
import { JOB_TYPES } from '@ams/shared';
import type { JobQueue } from '../ctx.js';

/** The single place the queue library is used. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const type of JOB_TYPES) await boss.createQueue(type);
}

export const pgBossQueue = (boss: PgBoss): JobQueue => ({
  async send(type, envelope, opts) {
    await boss.send(type, envelope, { retryLimit: 3, retryBackoff: true, ...(opts?.delaySeconds ? { startAfter: opts.delaySeconds } : {}) });
  },
});
