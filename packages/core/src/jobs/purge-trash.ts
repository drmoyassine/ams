import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { withIdentity } from '@ams/db';
import type { Ctx, JobQueue, ObjectStore } from '../ctx.js';
import { purgeExpiredTrash } from '../trash/trash.js';

const noQueue: JobQueue = { send: async () => { throw new Error('The Trash purge queues no jobs'); } };
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * The daily Trash purge (job type `purge_trash`, a pg-boss schedule in the general worker service, DEC-026). It has no
 * tenant of its own, so it first asks the one narrow question the database answers for it (which tenants have expired
 * Trash), then purges each tenant in a normal identity transaction under a system identity with the worker's database
 * role: that role can delete expired trash_item rows and nothing else. The stored files named by the rows go first.
 */
export async function purgeTrashTick(pool: pg.Pool, deps: { store?: ObjectStore } = {}): Promise<{ tenants: number; rows: number; files: number; failed: number }> {
  const asWorker = (institutionId: string) => ({ userId: null, institutionId, requestId: crypto.randomUUID(), actorType: 'system' as const, role: 'ams_worker' as const });
  const tenants = await withIdentity(pool, asWorker(NO_TENANT), async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`select trash_expired_institutions() as id`);
    return res.rows.map((r) => r.id);
  });
  const total = { tenants: 0, rows: 0, files: 0, failed: 0 };
  for (const institutionId of tenants) {
    const caller = asWorker(institutionId);
    const r = await withIdentity(pool, caller, (tx) => purgeExpiredTrash({
      tx, caller, queue: noQueue, afterCommit: () => undefined, ...(deps.store ? { store: deps.store } : {}),
    } as Ctx));
    total.tenants += 1; total.rows += r.rows; total.files += r.files; total.failed += r.failed;
  }
  return total;
}
