import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob, pgBossQueue, runJob, type Ctx, type JobHandler } from '@ams/core';
import { withIdentity } from '@ams/db';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { startWorker } from './worker.js';

let db: TestDb;
let pool: pg.Pool;
let boss: PgBoss;
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []) {
  return (await db.su.query(sql, params)).rows[0].id as string;
}

/** Runs fn as the API would: an identity transaction, then the afterCommit hooks. */
async function asUser<T>(userId: string, institutionId: string, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const hooks: (() => Promise<void>)[] = [];
  const caller = { userId, institutionId, requestId: crypto.randomUUID() };
  const out = await withIdentity(pool, caller, (tx) => fn({ tx, caller, queue: pgBossQueue(boss), afterCommit: (f) => { hooks.push(f); } }));
  for (const h of hooks) await h();
  return out;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  db = await createTestDb('worker');
  pool = new pg.Pool({ connectionString: db.url });
  boss = new PgBoss(db.url);
  await boss.start();
  await startWorker(boss, pool, { pollingIntervalSeconds: 0.5 });
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('V') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'Queuer', 'q@x.org') returning id`, [ids.inst]);
}, 30000);
afterAll(async () => { await boss.stop({ graceful: false }); await pool.end(); await db.close(); }, 30000);

describe('worker', () => {
  it('runs a queued job end to end as the user who queued it', async () => {
    const queued = await asUser(ids.user!, ids.inst!, (ctx) => enqueueJob(ctx, { type: 'notify', payload: { message: 'hello' } }));
    expect(queued.status).toBe('queued');

    const row = await waitFor(async () => {
      const { rows } = await db.su.query(`select status, attempts, result, created_by from job where id = $1`, [queued.id]);
      return rows[0]?.status === 'succeeded' ? rows[0] : undefined;
    });
    expect(row.result).toEqual({ delivered: false, echoed: 'hello' });
    expect(row.attempts).toBe(1);
    expect(row.created_by).toBe(ids.user);

    // RLS and audit applied inside the job: every event is attributed to the queuing user; status writes are updates.
    const { rows: events } = await db.su.query(
      `select action, actor_id, actor_type, institution_id from audit_event where target_id = $1 order by at, id`, [queued.id]);
    expect(events.map((e) => e.action)).toEqual(['insert', 'update', 'update']);
    expect(events.every((e) => e.actor_id === ids.user && e.actor_type === 'user' && e.institution_id === ids.inst)).toBe(true);
  });

  it('does not publish when the request rolls back', async () => {
    const before = (await db.su.query(`select count(*)::int n from job`)).rows[0].n;
    await expect(asUser(ids.user!, ids.inst!, async (ctx) => {
      await enqueueJob(ctx, { type: 'notify', payload: {} });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await db.su.query(`select count(*)::int n from job`)).rows[0].n).toBe(before);
  });

  it('records failures and rethrows so the queue can retry', async () => {
    const queued = await asUser(ids.user!, ids.inst!, (ctx) => enqueueJob(ctx, { type: 'export', payload: {} }));
    const failing: JobHandler = async () => { throw new Error('exploded'); };
    const envelope = { jobId: queued.id, institutionId: ids.inst, userId: ids.user, actorType: 'user' };
    await expect(runJob(pool, 'export', envelope, { export: failing })).rejects.toThrow('exploded');
    const { rows } = await db.su.query(`select status, error from job where id = $1`, [queued.id]);
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'exploded' });
  });

  it('refuses an envelope for another tenant or another user', async () => {
    const queued = await asUser(ids.user!, ids.inst!, (ctx) => enqueueJob(ctx, { type: 'notify', payload: {} }));
    const noop: JobHandler = async () => 'ok';
    await expect(runJob(pool, 'notify', { jobId: queued.id, institutionId: ids.other, userId: null, actorType: 'system' }, { notify: noop }))
      .rejects.toThrow(/job/);
    await expect(runJob(pool, 'notify', { jobId: queued.id, institutionId: ids.inst, userId: null, actorType: 'system' }, { notify: noop }))
      .rejects.toThrow(/does not match/);
  });

  it('a named system identity (no user) is recorded as a system actor', async () => {
    const jobId = await one(`insert into job (institution_id, type) values ($1, 'notify') returning id`, [ids.inst]);
    await runJob(pool, 'notify', { jobId, institutionId: ids.inst, userId: null, actorType: 'system' });
    const { rows } = await db.su.query(`select actor_id, actor_type from audit_event where target_id = $1 and action = 'update' limit 1`, [jobId]);
    expect(rows[0]).toEqual({ actor_id: null, actor_type: 'system' });
  });
});
