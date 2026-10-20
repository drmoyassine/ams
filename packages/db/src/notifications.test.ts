// In-app notifications in the database (TASK-088, migration 0063): a person sees, marks read and dismisses only their own rows
// (administrators included), anyone of the institution may notify a colleague of the same institution but never another
// institution's people, the kind is checked, only "read" can change, the worker reads and never writes, and the audit trail.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const q = (sql: string, p: unknown[] = []) => db.su.query(sql, p);
const as = (who: 'ua1' | 'ua2' | 'ub', inst: 'a' | 'b' = who === 'ub' ? 'b' : 'a', role: 'ams_app' | 'ams_worker' = 'ams_app') => ({
  get userId() { return ids[who]!; }, get institutionId() { return ids[inst]!; }, role,
});
const notify = (c: { query: (s: string, p?: unknown[]) => Promise<unknown> }, to: string, inst: string, kind = 'link_rejected') => c.query(
  `insert into notification (institution_id, user_id, kind, title, body, ref_kind, ref_id) values ($1, $2, $3, 'Your link was rejected', 'Because', 'evidence_link', gen_random_uuid())`, [inst, to, kind]);

beforeAll(async () => {
  db = await createTestDb('notifications');
  ids.a = await one(`insert into institution (name_en) values ('A') returning id`);
  ids.b = await one(`insert into institution (name_en) values ('B') returning id`);
  ids.ua1 = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ua1', 'ua1') returning id`, [ids.a]);
  ids.ua2 = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ua2', 'ua2') returning id`, [ids.a]);
  ids.ub = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ub', 'ub') returning id`, [ids.b]);
  await q(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.a, ids.ua2]);
}, 60000);
afterAll(async () => { await db.close(); });

describe('notification', () => {
  it('lets one person notify another of the same institution, and each sees only their own', async () => {
    await db.as(as('ua2'), (c) => notify(c, ids.ua1!, ids.a!));           // a reviewer tells the proposer
    await db.as(as('ua2'), (c) => notify(c, ids.ua2!, ids.a!, 'link_approved'));
    await db.as(as('ub'), (c) => notify(c, ids.ub!, ids.b!));
    expect((await db.as(as('ua1'), (c) => c.query(`select user_id from notification`))).rows.map((r) => r.user_id)).toEqual([ids.ua1]);
    // Not even the administrator (who wrote one of them) reads another person's; and never another institution's.
    expect((await db.as(as('ua2'), (c) => c.query(`select user_id from notification`))).rows.map((r) => r.user_id)).toEqual([ids.ua2]);
    expect((await db.as(as('ub'), (c) => c.query(`select user_id from notification`))).rows.map((r) => r.user_id)).toEqual([ids.ub]);
  });

  it('lets a person mark read and dismiss only their own', async () => {
    const mine = (await q(`select id from notification where user_id = $1`, [ids.ua1])).rows[0].id;
    expect((await db.as(as('ua2'), (c) => c.query(`update notification set read_at = now() where id = $1`, [mine]))).rowCount).toBe(0);
    expect((await db.as(as('ua2'), (c) => c.query(`delete from notification where id = $1`, [mine]))).rowCount).toBe(0);
    expect((await db.as(as('ua1'), (c) => c.query(`update notification set read_at = now() where id = $1`, [mine]))).rowCount).toBe(1);
    await expect(db.as(as('ua1'), (c) => c.query(`update notification set body = 'changed' where id = $1`, [mine]))).rejects.toThrow(/can only be marked read/);
    await expect(db.as(as('ua1'), (c) => c.query(`update notification set user_id = $2 where id = $1`, [mine, ids.ua2]))).rejects.toThrow();
    expect((await db.as(as('ua1'), (c) => c.query(`delete from notification where id = $1`, [mine]))).rowCount).toBe(1);
  });

  it('refuses a recipient of another institution, a forged institution and an unknown kind', async () => {
    await expect(db.as(as('ua2'), (c) => notify(c, ids.ub!, ids.a!))).rejects.toThrow(/same institution/);
    await expect(db.as(as('ua2'), (c) => notify(c, ids.ua1!, ids.b!))).rejects.toThrow();
    await expect(q(`insert into notification (institution_id, user_id, kind, title, body) values ($1, $2, 'link_exploded', 't', 'b')`, [ids.a, ids.ua1])).rejects.toThrow(/notification_kind_check/);
    await expect(q(`insert into notification (institution_id, user_id, kind, title, body, ref_kind) values ($1, $2, 'link_rejected', 't', 'b', 'evidence_link')`, [ids.a, ids.ua1])).rejects.toThrow(/notification_ref_pair_check/);
  });

  it('is read by the worker and never written by it', async () => {
    const worker = as('ua2', 'a', 'ams_worker');
    expect((await db.as(worker, (c) => c.query(`select count(*)::int as n from notification`))).rows[0].n).toBeGreaterThan(0);
    await expect(db.as(worker, (c) => notify(c, ids.ua1!, ids.a!))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker, (c) => c.query(`update notification set read_at = now()`))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker, (c) => c.query(`delete from notification`))).rejects.toThrow(/permission denied/);
  });

  it('is audited', async () => {
    const actions = (await q(`select action from audit_event where target_type = 'notification' order by created_at`)).rows.map((r) => r.action);
    expect(actions).toContain('insert');
    expect(actions).toContain('update');
    expect(actions).toContain('delete');
    expect((await q(`select created_by from notification where user_id = $1`, [ids.ua2])).rows[0].created_by).toBe(ids.ua2);
  });
});
