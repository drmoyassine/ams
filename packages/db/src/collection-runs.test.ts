// Evidence collection runs in the database (TASK-090, migration 0065): one run per item and period, how a status may move, the BI's one-time
// token (cleared when the run is supplied, skipped or failed), the same-institution rules, tenant isolation, and exactly what the worker
// (the scheduler and executor) may do: make and move runs, add the version the BI supplied, send a run's request, open its form, tell the
// owner, keep the item's next-due bookkeeping, and never skip a run, approve, publish or change anything else.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const q = (sql: string, p: unknown[] = []) => db.su.query(sql, p);
const app = (who: 'ua' | 'ub' = 'ua') => ({ userId: ids[who]!, institutionId: who === 'ua' ? ids.a! : ids.b!, role: 'ams_app' as const });
const worker = (inst: 'a' | 'b' = 'a') => ({ userId: undefined, institutionId: ids[inst]!, role: 'ams_worker' as const });
let day = 0;
const newRun = (item = ids.doc!, inst = ids.a!, extra = '') => {
  day += 1;
  return one(`insert into evidence_collection_run (institution_id, evidence_item_id, period_label, scheduled_for, due_at ${extra ? ', ' + extra.split('=')[0] : ''})
    values ($1, $2, 'P', '2030-01-01'::date + $3::int, now() + interval '2 days' ${extra ? ', ' + extra.split('=')[1] : ''}) returning id`, [inst, item, day]);
};
const status = async (id: string) => (await q(`select * from evidence_collection_run where id = $1`, [id])).rows[0];

beforeAll(async () => {
  db = await createTestDb('collectionruns');
  ids.a = await one(`insert into institution (name_en) values ('A') returning id`);
  ids.b = await one(`insert into institution (name_en) values ('B') returning id`);
  ids.ua = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ua', 'ua@x.org') returning id`, [ids.a]);
  ids.ub = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'ub', 'ub@x.org') returning id`, [ids.b]);
  await q(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.a, ids.ua]);
  await q(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.b, ids.ub]);
  ids.doc = await one(`insert into evidence_item (institution_id, title, type, owner_user_id, schedule) values ($1, 'Doc', 'document', $2, '{"every":"day","startDate":"2030-01-01","dueAfterDays":1,"timezone":"UTC"}') returning id`, [ids.a, ids.ua]);
  ids.doc2 = await one(`insert into evidence_item (institution_id, title, type, owner_user_id) values ($1, 'Doc 2', 'document', $2) returning id`, [ids.a, ids.ua]);
  ids.restricted = await one(`insert into evidence_item (institution_id, title, type, confidentiality) values ($1, 'Secret', 'document', 'restricted') returning id`, [ids.a]);
  ids.ds = await one(`insert into evidence_item (institution_id, title, type) values ($1, 'Data', 'dataset') returning id`, [ids.a]);
  ids.otherItem = await one(`insert into evidence_item (institution_id, title, type) values ($1, 'B doc', 'document') returning id`, [ids.b]);
  ids.v1 = await one(`insert into evidence_version (institution_id, evidence_item_id, version_no, url) values ($1, $2, 1, 'https://x.example/1') returning id`, [ids.a, ids.doc]);
  ids.vOther = await one(`insert into evidence_version (institution_id, evidence_item_id, version_no, url) values ($1, $2, 1, 'https://x.example/2') returning id`, [ids.a, ids.doc2]);
  await q(`insert into dataset_spec (institution_id, evidence_item_id, columns) values ($1, $2, '[{"key":"n","label":"N","type":"integer"}]')`, [ids.a, ids.ds]);
}, 60000);
afterAll(async () => { await db.close(); });

describe('one run per item and period', () => {
  it('makes a period once: a second one for the same item and day is refused, and ON CONFLICT DO NOTHING makes it a no-op', async () => {
    const id = await newRun();
    const dup = await q(`select scheduled_for from evidence_collection_run where id = $1`, [id]);
    await expect(q(`insert into evidence_collection_run (institution_id, evidence_item_id, period_label, scheduled_for, due_at) values ($1, $2, 'P', $3, now())`, [ids.a, ids.doc, dup.rows[0].scheduled_for])).rejects.toThrow(/evidence_collection_run_period_idx/);
    const again = await q(`insert into evidence_collection_run (institution_id, evidence_item_id, period_label, scheduled_for, due_at) values ($1, $2, 'P', $3, now()) on conflict do nothing returning id`, [ids.a, ids.doc, dup.rows[0].scheduled_for]);
    expect(again.rowCount).toBe(0);
  });

  it('starts pending, by the schedule, with no attempts', async () => {
    expect(await status(await newRun())).toMatchObject({ status: 'pending', trigger: 'schedule', attempts: 0, version_id: null, callback_token_hash: null });
  });
});

describe('how a status moves', () => {
  const to = (id: string, st: string, set = '') => q(`update evidence_collection_run set status = $2 ${set} where id = $1`, [id, st]);

  it('pending -> requested | supplied | late | failed | skipped', async () => {
    await to(await newRun(), 'requested');
    await to(await newRun(), 'late');
    await to(await newRun(), 'failed', `, last_error = 'x'`);
    await to(await newRun(), 'skipped', `, skip_reason = 'because'`);
    await to(await newRun(), 'supplied', `, version_id = '${ids.v1}'`);
  });

  it('requested -> late -> supplied (a late run still takes a supply)', async () => {
    const id = await newRun();
    await to(id, 'requested');
    await to(id, 'late');
    await to(id, 'supplied', `, version_id = '${ids.v1}'`);
  });

  it('failed -> requested (retry), supplied or skipped; but supplied and skipped are final', async () => {
    const id = await newRun();
    await to(id, 'failed', `, last_error = 'boom'`);
    await to(id, 'requested', `, last_error = null`);
    await to(id, 'failed', `, last_error = 'boom'`);
    await to(id, 'skipped', `, skip_reason = 'no'`);
    await expect(to(id, 'pending')).rejects.toThrow(/skipped cannot become pending/);
    await expect(to(id, 'requested')).rejects.toThrow(/skipped cannot become requested/);
    const done = await newRun();
    await to(done, 'supplied', `, version_id = '${ids.v1}'`);
    for (const st of ['pending', 'requested', 'late', 'failed', 'skipped']) await expect(to(done, st, `, last_error = 'x', skip_reason = 'y'`), st).rejects.toThrow(/supplied cannot become/);
    await expect(q(`update evidence_collection_run set version_id = $2 where id = $1`, [done, ids.v1])).resolves.toBeDefined(); // the same version: nothing changes
  });

  it('a run cannot go back to pending or from late back to requested', async () => {
    const id = await newRun();
    await to(id, 'requested');
    await expect(to(id, 'pending')).rejects.toThrow(/requested cannot become pending/);
    await to(id, 'late');
    await expect(to(id, 'requested')).rejects.toThrow(/late cannot become requested/);
  });

  it('a status needs its facts: a supplied run its version, a skipped run its reason, a failed run its error', async () => {
    await expect(to(await newRun(), 'supplied')).rejects.toThrow(/evidence_collection_run_supplied_check/);
    await expect(to(await newRun(), 'skipped')).rejects.toThrow(/evidence_collection_run_skipped_check/);
    await expect(to(await newRun(), 'skipped', `, skip_reason = '  '`)).rejects.toThrow(/evidence_collection_run_skipped_check/);
    await expect(to(await newRun(), 'failed')).rejects.toThrow(/evidence_collection_run_failed_check/);
    await expect(to(await newRun(), 'done')).rejects.toThrow(/cannot become done/);
    await expect(q(`insert into evidence_collection_run (institution_id, evidence_item_id, period_label, scheduled_for, due_at, status) values ($1, $2, 'P', '2034-01-01', now(), 'done')`, [ids.a, ids.doc])).rejects.toThrow(/evidence_collection_run_status_check/);
  });

  it('what a run is about never changes: the item, the period, the due time, the trigger', async () => {
    const id = await newRun();
    await expect(q(`update evidence_collection_run set evidence_item_id = $2 where id = $1`, [id, ids.doc2])).rejects.toThrow(/cannot change/);
    await expect(q(`update evidence_collection_run set scheduled_for = scheduled_for + 1 where id = $1`, [id])).rejects.toThrow(/cannot change/);
    await expect(q(`update evidence_collection_run set due_at = now() where id = $1`, [id])).rejects.toThrow(/cannot change/);
    await expect(q(`update evidence_collection_run set period_label = 'other' where id = $1`, [id])).rejects.toThrow(/cannot change/);
    await expect(q(`update evidence_collection_run set "trigger" = 'manual' where id = $1`, [id])).rejects.toThrow(/cannot change/);
  });
});

describe('the same institution, and the right version', () => {
  it('a run belongs to an item of its own institution', async () => {
    await expect(q(`insert into evidence_collection_run (institution_id, evidence_item_id, period_label, scheduled_for, due_at) values ($1, $2, 'P', '2031-01-01', now())`, [ids.a, ids.otherItem])).rejects.toThrow(/same institution/);
    await expect(db.as(app('ua'), (c) => c.query(`insert into evidence_collection_run (institution_id, evidence_item_id, period_label, scheduled_for, due_at) values ($1, $2, 'P', '2031-01-01', now())`, [ids.b, ids.otherItem]))).rejects.toThrow();
  });

  it('a run is supplied by a version of its own item only', async () => {
    const id = await newRun(ids.doc!);
    await expect(q(`update evidence_collection_run set status = 'supplied', version_id = $2 where id = $1`, [id, ids.vOther])).rejects.toThrow(/version of its own evidence item/);
  });
});

describe('the one-time token', () => {
  it('is a hash with an expiry, both or neither, and is cleared the moment the run is supplied, skipped or failed', async () => {
    const hash = 'a'.repeat(64);
    await expect(q(`update evidence_collection_run set callback_token_hash = $2 where id = $1`, [await newRun(), hash])).rejects.toThrow(/evidence_collection_run_token_pair_check/);
    for (const [st, extra] of [['supplied', `, version_id = '${ids.v1}'`], ['skipped', `, skip_reason = 'r'`], ['failed', `, last_error = 'e'`]] as const) {
      const id = await newRun();
      await q(`update evidence_collection_run set status = 'requested', callback_token_hash = $2, callback_expires_at = now() + interval '1 day' where id = $1`, [id, `${st[0]}${hash.slice(1)}`]);
      expect(await status(id)).toMatchObject({ callback_token_hash: `${st[0]}${hash.slice(1)}` });
      await q(`update evidence_collection_run set status = '${st}' ${extra} where id = $1`, [id]);
      expect(await status(id), st).toMatchObject({ callback_token_hash: null, callback_expires_at: null });
    }
  });

  it('is found by the callback by run id (app role only), and only while the run holds one', async () => {
    const id = await newRun();
    await q(`update evidence_collection_run set status = 'requested', callback_token_hash = $2, callback_expires_at = now() + interval '1 day' where id = $1`, [id, 'b'.repeat(64)]);
    const found = await db.as({ role: 'ams_app' }, (c) => c.query(`select * from app_resolve_collection_callback($1)`, [id]));
    expect(found.rows[0]).toMatchObject({ institution_id: ids.a, token_hash: 'b'.repeat(64), status: 'requested' });
    await q(`update evidence_collection_run set status = 'late' where id = $1`, [id]);
    await q(`update evidence_collection_run set status = 'supplied', version_id = $2 where id = $1`, [id, ids.v1]);
    expect((await db.as({ role: 'ams_app' }, (c) => c.query(`select * from app_resolve_collection_callback($1)`, [id]))).rowCount).toBe(0);
    await expect(db.as({ role: 'ams_worker' }, (c) => c.query(`select * from app_resolve_collection_callback($1)`, [id]))).rejects.toThrow(/permission denied/);
  });

  it('one token hash belongs to one run', async () => {
    const a = await newRun();
    const b = await newRun();
    const set = (id: string) => q(`update evidence_collection_run set status = 'requested', callback_token_hash = $2, callback_expires_at = now() + interval '1 day' where id = $1`, [id, 'c'.repeat(64)]);
    await set(a);
    await expect(set(b)).rejects.toThrow(/evidence_collection_run_token_idx/);
  });
});

describe('who sees runs', () => {
  it('each institution sees its own, and a restricted item\'s runs are seen only by those who see the item', async () => {
    const mine = await newRun();
    const secret = await one(`insert into evidence_collection_run (institution_id, evidence_item_id, period_label, scheduled_for, due_at) values ($1, $2, 'P', '2032-01-01', now()) returning id`, [ids.a, ids.restricted]);
    const seenByA = (await db.as(app('ua'), (c) => c.query(`select id from evidence_collection_run`))).rows.map((r) => r.id);
    expect(seenByA).toContain(mine);
    expect(seenByA).toContain(secret); // an institution administrator sees restricted items
    const seenByB = (await db.as(app('ub'), (c) => c.query(`select id from evidence_collection_run`))).rows.map((r) => r.id);
    expect(seenByB).not.toContain(mine);
    // The worker is a system identity (no person): it does not see restricted items' runs, so the scheduler never collects them.
    const seenByWorker = (await db.as(worker('a'), (c) => c.query(`select id from evidence_collection_run`))).rows.map((r) => r.id);
    expect(seenByWorker).toContain(mine);
    expect(seenByWorker).not.toContain(secret);
    expect((await db.as(worker('b'), (c) => c.query(`select id from evidence_collection_run`))).rows).toHaveLength(0);
  });

  it('a run is audited', async () => {
    const actions = (await q(`select distinct action from audit_event where target_type = 'evidence_collection_run'`)).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['insert', 'update']));
  });

  it('the app cannot delete a run', async () => {
    await expect(db.as(app('ua'), (c) => c.query(`delete from evidence_collection_run`))).rejects.toThrow(/permission denied/);
  });
});

describe('what the worker may do', () => {
  const insertRun = (c: { query: (s: string, p?: unknown[]) => Promise<unknown> }, item = ids.doc!, date = '2033-01-01') =>
    c.query(`insert into evidence_collection_run (institution_id, evidence_item_id, period_label, scheduled_for, due_at) values ($1, $2, 'P', $3, now() + interval '1 day') on conflict do nothing`, [ids.a, item, date]);

  it('finds the institutions with work through one narrow function (and the app cannot)', async () => {
    const rows = (await db.as(worker('a'), (c) => c.query(`select collection_institutions() as id`))).rows.map((r) => r.id);
    expect(rows).toContain(ids.a);
    await expect(db.as(app('ua'), (c) => c.query(`select collection_institutions()`))).rejects.toThrow(/permission denied/);
  });

  it('makes a run, in its own institution only, and moves it along in the columns a run needs', async () => {
    await db.as(worker('a'), (c) => insertRun(c));
    await db.as(worker('a'), (c) => insertRun(c)); // again: nothing
    expect((await q(`select count(*)::int as n from evidence_collection_run where scheduled_for = '2033-01-01'`)).rows[0].n).toBe(1);
    await expect(db.as(worker('b'), (c) => insertRun(c))).rejects.toThrow(/row-level security|same institution/);
    const id = (await q(`select id from evidence_collection_run where scheduled_for = '2033-01-01'`)).rows[0].id;
    await db.as(worker('a'), (c) => c.query(`update evidence_collection_run set status = 'requested', requested_at = now(), attempts = 1, details = '{"startedAt":"x"}', callback_token_hash = $2, callback_expires_at = now() + interval '1 day' where id = $1`, [id, 'd'.repeat(64)]));
    await db.as(worker('a'), (c) => c.query(`update evidence_collection_run set status = 'supplied', version_id = $2, responded_at = now() where id = $1`, [id, ids.v1]));
    expect(await status(id)).toMatchObject({ status: 'supplied', callback_token_hash: null });
  });

  it('never skips a run and never changes what a run is about or who made it', async () => {
    const id = await newRun();
    await expect(db.as(worker('a'), (c) => c.query(`update evidence_collection_run set status = 'skipped', skip_reason = 'x' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('a'), (c) => c.query(`update evidence_collection_run set skip_reason = 'x' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('a'), (c) => c.query(`update evidence_collection_run set due_at = now() where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('a'), (c) => c.query(`update evidence_collection_run set trigger = 'manual' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('a'), (c) => c.query(`delete from evidence_collection_run where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    expect(await status(id)).toMatchObject({ status: 'pending' });
  });

  it('keeps an item\'s next due and last run times, and changes nothing else of the item', async () => {
    await db.as(worker('a'), (c) => c.query(`update evidence_item set next_due_at = now(), last_run_at = now() where id = $1`, [ids.doc]));
    await expect(db.as(worker('a'), (c) => c.query(`update evidence_item set title = 'renamed' where id = $1`, [ids.doc]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('a'), (c) => c.query(`update evidence_item set status = 'archived' where id = $1`, [ids.doc]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('a'), (c) => c.query(`update evidence_item set schedule = null where id = $1`, [ids.doc]))).rejects.toThrow(/permission denied/);
  });

  it('adds only the versions the BI supplied', async () => {
    const add = (c: { query: (s: string, p?: unknown[]) => Promise<unknown> }, lineage: string | null, no: number) => c.query(
      `insert into evidence_version (institution_id, evidence_item_id, version_no, url, lineage) values ($1, $2, $3, 'https://x.example/w', $4::jsonb)`, [ids.a, ids.doc2, no, lineage]);
    await expect(db.as(worker('a'), (c) => add(c, null, 2))).rejects.toThrow(/only the versions the BI supplied/);
    await expect(db.as(worker('a'), (c) => add(c, '{"origin":"person"}', 2))).rejects.toThrow(/only the versions the BI supplied/);
    await db.as(worker('a'), (c) => add(c, '{"origin":"bi","run_id":"x"}', 2));
    // Versions are still never changed or deleted, by anyone.
    await expect(db.as(worker('a'), (c) => c.query(`update evidence_version set notes = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('a'), (c) => c.query(`delete from evidence_version`))).rejects.toThrow(/permission denied/);
  });

  it('sends the request of a run, and no other; it can neither answer nor cancel one', async () => {
    const run = await newRun();
    const ask = (c: { query: (s: string, p?: unknown[]) => Promise<unknown> }, withRun: boolean) => c.query(
      `insert into evidence_request (institution_id, title, assignee_email, collection_run_id, data_item_id) values ($1, 'T', 'p@x.org', $2, $3)`, [ids.a, withRun ? run : null, withRun ? null : ids.ds]);
    await expect(db.as(worker('a'), (c) => ask(c, false))).rejects.toThrow(/only the requests of collection runs/);
    await db.as(worker('a'), (c) => ask(c, true));
    await expect(db.as(worker('a'), (c) => c.query(`update evidence_request set status = 'cancelled'`))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('a'), (c) => c.query(`insert into evidence_request (institution_id, title, assignee_email, collection_run_id) values ($1, 'T', 'p@x.org', $2)`, [ids.b, run]))).rejects.toThrow();
    // The request's target is its run, and cannot be moved.
    const other = await newRun();
    await expect(q(`update evidence_request set collection_run_id = $1 where collection_run_id = $2`, [other, run])).rejects.toThrow(/target cannot change/);
  });

  it('opens a dataset\'s form and never closes it or touches its questions', async () => {
    await db.as(worker('a'), (c) => c.query(`update dataset_spec set form_open = true where evidence_item_id = $1`, [ids.ds]));
    await expect(db.as(worker('a'), (c) => c.query(`update dataset_spec set form_open = false where evidence_item_id = $1`, [ids.ds]))).rejects.toThrow(/only opens a form/);
    await expect(db.as(worker('a'), (c) => c.query(`update dataset_spec set columns = '[]' where evidence_item_id = $1`, [ids.ds]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('a'), (c) => c.query(`update dataset_spec set form_link_token = 'abc' where evidence_item_id = $1`, [ids.ds]))).rejects.toThrow(/permission denied/);
    await q(`update dataset_spec set form_open = false where evidence_item_id = $1`, [ids.ds]);
    await db.as(app('ua'), (c) => c.query(`update dataset_spec set form_open = false where evidence_item_id = $1`, [ids.ds])); // a person may close it
  });
});
