// The assistant's bulk-edit tables (DEC-027 Phase 2, migration 0051): the one-time confirmation is written ONLY by the API's role
// and only for the signed-in person; it can be used once; the model's job (the worker role) has no access to any of the three
// tables; each person sees only their own change sets; the audit trail keeps counts and never the words.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const app = (who: string, inst = 'a') => ({ userId: ids[who]!, institutionId: ids[inst]! });
const worker = (who: string) => ({ ...app(who), role: 'ams_worker' as const });
const minutes = (n: number) => `now() + interval '${n} minutes'`;

const confirmation = (who: string, over: { user?: string; token?: string; expires?: string } = {}) =>
  db.as(app(who), (c) => c.query(
    `insert into assistant_confirmation (institution_id, user_id, message_id, part_id, change_set_hash, plan_hash, token_hash, expires_at)
     values ($1, $2, $3, 'p1', 'h', 'ph', $4, ${over.expires ?? minutes(10)}) returning id`,
    [ids.a, ids[over.user ?? who], ids.msg, over.token ?? crypto.randomUUID()]));

beforeAll(async () => {
  db = await createTestDb('assistantchanges');
  ids.a = await one(`insert into institution (name_en) values ('A') returning id`);
  ids.b = await one(`insert into institution (name_en) values ('B') returning id`);
  for (const n of ['ann', 'bob', 'admin']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.a, n]);
  ids.eve = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'eve', 'eve') returning id`, [ids.b]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.a, ids.admin]);
  ids.conv = await one(`insert into assistant_conversation (institution_id, user_id, title) values ($1, $2, 'chat') returning id`, [ids.a, ids.ann]);
  ids.msg = await one(`insert into assistant_message (institution_id, conversation_id, role, status, parts) values ($1, $2, 'assistant', 'done', '[]') returning id`, [ids.a, ids.conv]);
  ids.version = crypto.randomUUID();
});
afterAll(() => db.close());

describe('assistant_confirmation', () => {
  it('is written by the API for the signed-in person only, valid for at most ten minutes', async () => {
    await confirmation('ann');
    await expect(confirmation('bob', { user: 'ann' })).rejects.toThrow(/row-level security|signed-in person it is for/);
    await expect(confirmation('ann', { expires: minutes(30) })).rejects.toThrow(/ten minutes/);
    await expect(confirmation('ann', { expires: `now() - interval '1 minute'` })).rejects.toThrow(/ten minutes/);
    // The AI identity (actor_type ai) cannot be issued one, nor a system identity without a user.
    await expect(db.as(app('ann'), async (c) => {
      await c.query(`select set_config('app.actor_type', 'ai', true)`);
      return c.query(`insert into assistant_confirmation (institution_id, user_id, message_id, part_id, change_set_hash, plan_hash, token_hash, expires_at) values ($1, $2, $3, 'p', 'h', 'h', 'ai-token', ${minutes(5)})`, [ids.a, ids.ann, ids.msg]);
    })).rejects.toThrow(/signed-in person/);
    await expect(db.as({ institutionId: ids.a! }, (c) => c.query(`insert into assistant_confirmation (institution_id, user_id, message_id, part_id, change_set_hash, plan_hash, token_hash, expires_at) values ($1, $2, $3, 'p', 'h', 'h', 'sys-token', ${minutes(5)})`, [ids.a, ids.ann, ids.msg]))).rejects.toThrow();
  });

  it('cannot be read, written or consumed by the worker (the model\'s job): it has no grant at all', async () => {
    const id = (await confirmation('ann')).rows[0].id as string;
    await expect(db.as(worker('ann'), (c) => c.query(`select id from assistant_confirmation`))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('ann'), (c) => c.query(`insert into assistant_confirmation (institution_id, user_id, message_id, part_id, change_set_hash, plan_hash, token_hash, expires_at) values ($1, $2, $3, 'p', 'h', 'h', 'w', ${minutes(5)})`, [ids.a, ids.ann, ids.msg]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('ann'), (c) => c.query(`update assistant_confirmation set consumed_at = now() where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('ann'), (c) => c.query(`select id from assistant_change_set`))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('ann'), (c) => c.query(`select id from assistant_written_text`))).rejects.toThrow(/permission denied/);
  });

  it('can be used once: consumed atomically, never un-consumed, and its binding never changes', async () => {
    const token = crypto.randomUUID();
    const id = (await confirmation('ann', { token })).rows[0].id as string;
    const consume = () => db.as(app('ann'), (c) => c.query(`update assistant_confirmation set consumed_at = now(), consumed_result = 'consuming' where token_hash = $1 and consumed_at is null and expires_at > now() returning id`, [token]));
    expect((await consume()).rowCount).toBe(1);
    expect((await consume()).rowCount).toBe(0); // the second press finds nothing to consume
    // Afterwards only how the use ended can be recorded, once.
    await expect(db.as(app('ann'), (c) => c.query(`update assistant_confirmation set consumed_at = null where id = $1`, [id]))).rejects.toThrow(/already used/);
    await expect(db.as(app('ann'), (c) => c.query(`update assistant_confirmation set consumed_result = 'consuming' where id = $1`, [id]))).rejects.toThrow(/already used/);
    await db.as(app('ann'), (c) => c.query(`update assistant_confirmation set consumed_result = 'applied' where id = $1`, [id]));
    await expect(db.as(app('ann'), (c) => c.query(`update assistant_confirmation set consumed_result = 'failed' where id = $1`, [id]))).rejects.toThrow(/already used/);
    // The binding to the person, the proposal and the change set cannot be edited before use either.
    const fresh = (await confirmation('ann')).rows[0].id as string;
    await expect(db.as(app('ann'), (c) => c.query(`update assistant_confirmation set change_set_hash = 'other' where id = $1`, [fresh]))).rejects.toThrow(/only the use/);
    await expect(db.as(app('ann'), (c) => c.query(`update assistant_confirmation set expires_at = now() + interval '9 minutes' where id = $1`, [fresh]))).rejects.toThrow(/only the use/);
  });

  it('is invisible to everyone but its person, including administrators and other tenants', async () => {
    await confirmation('ann');
    const count = (who: string, inst = 'a') => db.as(app(who, inst), async (c) => (await c.query(`select count(*)::int as n from assistant_confirmation`)).rows[0].n as number);
    expect(await count('ann')).toBeGreaterThan(0);
    expect(await count('bob')).toBe(0);
    expect(await count('admin')).toBe(0);
    expect(await count('eve', 'b')).toBe(0);
  });

  it('is audited without the token', async () => {
    await confirmation('ann');
    const events = (await db.su.query(`select after from audit_event where target_type = 'assistant_confirmation'`)).rows;
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(/token/);
  });
});

describe('assistant_change_set', () => {
  const insertSet = (who: string) => db.as(app(who), (c) => c.query(
    `insert into assistant_change_set (institution_id, user_id, message_id, part_id, version_id, summary, change_set_hash, operations, counts, inverse)
     values ($1, $2, $3, 'p1', $4, 'A private summary', 'h', '[{"op":"x"}]', '{"items":3}', '[{"label":"l"}]') returning id`, [ids.a, ids[who], ids.msg, ids.version]));

  it('belongs to its person; another person, an administrator and another tenant see none of it', async () => {
    const id = (await insertSet('ann')).rows[0].id as string;
    const count = (who: string, inst = 'a') => db.as(app(who, inst), async (c) => (await c.query(`select count(*)::int as n from assistant_change_set where id = $1`, [id])).rows[0].n as number);
    expect(await count('ann')).toBe(1);
    expect(await count('bob')).toBe(0);
    expect(await count('admin')).toBe(0);
    expect(await count('eve', 'b')).toBe(0);
    await expect(insertSet('bob').then(() => db.as(app('bob'), (c) => c.query(`insert into assistant_change_set (institution_id, user_id, version_id, summary, change_set_hash, operations, counts) values ($1, $2, $3, 's', 'h', '[]', '{}')`, [ids.a, ids.ann, ids.version])))).rejects.toThrow(/row-level security/);
  });

  it('keeps what was applied: only its state, counts and undo list change afterwards', async () => {
    const id = (await insertSet('ann')).rows[0].id as string;
    await db.as(app('ann'), (c) => c.query(`update assistant_change_set set state = 'undone', inverse = '[]', undone_at = now() where id = $1`, [id]));
    await expect(db.as(app('ann'), (c) => c.query(`update assistant_change_set set operations = '[]' where id = $1`, [id]))).rejects.toThrow(/cannot be rewritten/);
    await expect(db.as(app('ann'), (c) => c.query(`update assistant_change_set set summary = 'new' where id = $1`, [id]))).rejects.toThrow(/cannot be rewritten/);
    await expect(db.as(app('ann'), (c) => c.query(`update assistant_change_set set state = 'weird' where id = $1`, [id]))).rejects.toThrow(/assistant_change_set_state_check/);
  });

  it('is audited as counts: who, when, how many; never the summary or the operations', async () => {
    const id = (await insertSet('ann')).rows[0].id as string;
    const [e] = (await db.su.query(`select action, actor_id, after from audit_event where target_type = 'assistant_change_set' and target_id = $1`, [id])).rows;
    expect(e).toMatchObject({ action: 'assistant_change_applied', actor_id: ids.ann });
    expect(e.after).toMatchObject({ proposed_by: 'assistant', applied_by: ids.ann, counts: { items: 3 } });
    expect(JSON.stringify(e)).not.toMatch(/private summary|"op"/);
  });
});

describe('assistant_written_text', () => {
  it('is tenant-wide for the API, closed to other tenants and to the worker, and limited to known fields and states', async () => {
    const set = (await db.as(app('ann'), (c) => c.query(
      `insert into assistant_change_set (institution_id, user_id, version_id, summary, change_set_hash, operations, counts) values ($1, $2, $3, 's', 'h', '[]', '{}') returning id`, [ids.a, ids.ann, ids.version]))).rows[0].id as string;
    const insert = (field: string) => db.as(app('ann'), (c) => c.query(
      `insert into assistant_written_text (institution_id, change_set_id, version_id, requirement_id, field, text, previous) values ($1, $2, $3, $4, $5, 'new', 'old') returning id`,
      [ids.a, set, ids.version, crypto.randomUUID(), field]));
    await insert('title');
    await expect(insert('code')).rejects.toThrow(/assistant_written_text_field_check/);
    const seen = (who: string, inst = 'a') => db.as(app(who, inst), async (c) => (await c.query(`select count(*)::int as n from assistant_written_text`)).rows[0].n as number);
    expect(await seen('bob')).toBe(1);
    expect(await seen('eve', 'b')).toBe(0);
  });
});
