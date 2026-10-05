import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { sql } from 'drizzle-orm';

export type Tx = NodePgDatabase;

/** Who is acting. `userId` is null only for named system identities. */
export interface Identity {
  userId: string | null;
  institutionId: string;
  requestId: string;
  actorType?: 'user' | 'system' | 'ai';
  /** Database role for the transaction: the API uses ams_app, the worker ams_worker. */
  role?: 'ams_app' | 'ams_worker';
}

/**
 * The only way to reach the database (DEC-010). Opens a transaction, drops to a non-owner role so row-level
 * security applies, and sets the identity settings that RLS policies and the audit trigger read.
 * Commits when `fn` resolves, rolls back when it throws.
 */
export async function withIdentity<T>(pool: pg.Pool, identity: Identity, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tx = drizzle(client);
    await tx.execute(sql.raw(`set local role ${identity.role ?? 'ams_app'}`));
    await tx.execute(sql`select
      set_config('app.user_id', ${identity.userId ?? ''}, true),
      set_config('app.institution_id', ${identity.institutionId}, true),
      set_config('app.request_id', ${identity.requestId}, true),
      set_config('app.actor_type', ${identity.actorType ?? (identity.userId ? 'user' : 'system')}, true)`);
    const out = await fn(tx);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
