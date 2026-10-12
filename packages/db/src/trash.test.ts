// Trash (0046, DEC-026): tenant isolation, what the worker may do (delete expired trash rows, nothing else), the audit
// event without the payload, the frozen-version trigger on restore, and the dismissal being cleared when a row comes back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const app = () => ({ userId: ids.user, institutionId: ids.inst });
const worker = () => ({ userId: undefined, institutionId: ids.inst, role: 'ams_worker' as const });

const trash = (institution: string, expires: string, label = 'x') => one(
  `insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'note', $2, '{"v":1,"tables":{},"files":[],"refs":[],"root":{}}', ${expires}) returning id`, [institution, label]);

beforeAll(async () => {
  db = await createTestDb('trash');
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('V') returning id`);
  ids.user = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'A', 'a@x.org') returning id`, [ids.inst]);
  ids.otherUser = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'B', 'b@x.org') returning id`, [ids.other]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'institution') returning id`, [ids.inst, acc]);
});
afterAll(() => db.close());

describe('trash_item', () => {
  it('is isolated per institution for the app and for the worker', async () => {
    const mine = await trash(ids.inst!, `now() + interval '30 days'`);
    await trash(ids.other!, `now() + interval '30 days'`);
    expect(await db.as(app(), async (c) => (await c.query(`select id from trash_item`)).rows.map((r) => r.id))).toEqual([mine]);
    expect(await db.as({ userId: ids.otherUser, institutionId: ids.other }, async (c) => (await c.query(`select id from trash_item`)).rowCount)).toBe(1);
    expect(await db.as(worker(), async (c) => (await c.query(`select id from trash_item`)).rowCount)).toBe(1);
    // A row cannot be written for another tenant.
    await expect(db.as(app(), (c) => c.query(`insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'note', 'x', '{}', now())`, [ids.other]))).rejects.toThrow(/row-level security/);
    await expect(db.as(app(), (c) => c.query(`insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'bogus', 'x', '{}', now())`, [ids.inst]))).rejects.toThrow(/trash_item_kind_check/);
  });

  it('lets the worker delete expired rows of its own tenant and nothing else', async () => {
    const fresh = await trash(ids.inst!, `now() + interval '5 days'`, 'fresh');
    const old = await trash(ids.inst!, `now() - interval '1 hour'`, 'old');
    const otherOld = await trash(ids.other!, `now() - interval '1 hour'`, 'other old');
    // Only expired rows, only its tenant: the others are silently out of reach.
    const gone = await db.as(worker(), async (c) => (await c.query(`delete from trash_item where id = any($1) returning id`, [[fresh, old, otherOld]])).rows.map((r) => r.id));
    expect(gone).toEqual([old]);
    expect((await db.su.query(`select id from trash_item where id = any($1) order by label`, [[fresh, otherOld]])).rowCount).toBe(2);
    // No inserts or updates, and no way to touch anything else.
    await expect(db.as(worker(), (c) => c.query(`insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'note', 'x', '{}', now())`, [ids.inst]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker(), (c) => c.query(`update trash_item set label = 'y' where id = $1`, [fresh]))).rejects.toThrow(/permission denied/);
    for (const table of ['requirement', 'requirement_note', 'source_document', 'source_page', 'framework_version', 'framework', 'requirement_mapping', 'analysis_dismissal', 'evidence_link', 'milestone']) {
      await expect(db.as(worker(), (c) => c.query(`delete from ${table}`)), table).rejects.toThrow(/permission denied/);
    }
  });

  it('answers "which tenants have expired items" only to the worker, and only with ids', async () => {
    await trash(ids.inst!, `now() - interval '2 days'`);
    const tenants = await db.as(worker(), async (c) => (await c.query(`select trash_expired_institutions() as id`)).rows.map((r) => r.id));
    expect(tenants).toContain(ids.inst);
    await expect(db.as(app(), (c) => c.query(`select trash_expired_institutions()`))).rejects.toThrow(/permission denied/);
  });

  it('writes an audit event for each change, without the payload', async () => {
    const id = await db.as(app(), async (c) => (await c.query(
      `insert into trash_item (institution_id, group_id, kind, label, payload, expires_at) values ($1, gen_random_uuid(), 'note', 'audited', '{"big":"payload"}', now() + interval '30 days') returning id`, [ids.inst])).rows[0].id as string);
    await db.as(app(), (c) => c.query(`update trash_item set restored_at = now() where id = $1`, [id]));
    await db.as(app(), (c) => c.query(`delete from trash_item where id = $1`, [id]));
    const ev = (await db.su.query(`select action, actor_id, before, after from audit_event where target_type = 'trash_item' and target_id = $1 order by at, id`, [id])).rows;
    expect(ev.map((e) => e.action)).toEqual(['insert', 'update', 'delete']);
    expect(ev.every((e) => e.actor_id === ids.user)).toBe(true);
    expect(JSON.stringify(ev)).not.toContain('payload');
    expect(ev[0].after.label).toBe('audited');
  });
});

describe('what a restore may and may not do', () => {
  it('cannot put anything back into a published version (the frozen-version trigger still applies)', async () => {
    const v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'frozen') returning id`, [ids.inst, ids.fw]);
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [v]);
    await db.su.query(`update framework_version set status = 'published', published_by = $2, published_at = now() where id = $1`, [v, ids.user]);
    const row = JSON.stringify([{ id: crypto.randomUUID(), institution_id: ids.inst, framework_version_id: v, code: 'X', level_label: 'S', title: 't', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
    await expect(db.as(app(), (c) => c.query(`insert into requirement select * from jsonb_populate_recordset(null::requirement, $1::jsonb)`, [row]))).rejects.toThrow(/immutable/);
    // And a published version cannot be deleted either.
    await expect(db.as(app(), (c) => c.query(`delete from framework_version where id = $1`, [v]))).rejects.toThrow(/immutable/);
  });

  it('clears the analysis\'s memory of a deleted AI row when it is put back, but not for the worker\'s own rows', async () => {
    const v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'dismissal') returning id`, [ids.inst, ids.fw]);
    const req = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, origin) values ($1, $2, 'D1', 'S', 't', 'ai') returning id`, [ids.inst, v]);
    const snapshot = (await db.su.query(`select to_jsonb(r) as r from requirement r where id = $1`, [req])).rows[0].r;
    await db.as(app(), (c) => c.query(`delete from requirement where id = $1`, [req]));
    expect((await db.su.query(`select code from analysis_dismissal where framework_version_id = $1`, [v])).rows).toEqual([{ code: 'D1' }]);
    await db.as(app(), (c) => c.query(`insert into requirement select * from jsonb_populate_recordset(null::requirement, $1::jsonb)`, [JSON.stringify([snapshot])]));
    expect((await db.su.query(`select id from analysis_dismissal where framework_version_id = $1`, [v])).rowCount).toBe(0);
    // The app cannot delete dismissals directly; only the narrow functions can, inside the caller's own tenant.
    await expect(db.as(app(), (c) => c.query(`delete from analysis_dismissal`))).rejects.toThrow(/permission denied/);
    await expect(db.as({ userId: ids.otherUser, institutionId: ids.other }, (c) => c.query(`select trash_drop_dismissals($1)`, [v]))).rejects.toThrow(/draft version of your own institution/);
    await expect(db.as(worker(), (c) => c.query(`select forget_ai_dismissal($1, 'requirement', 'D1', null)`, [v]))).rejects.toThrow(/permission denied/);
  });
});
