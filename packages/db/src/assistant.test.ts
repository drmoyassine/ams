// The in-app assistant's tables (DEC-027, migrations 0048-0049): a person sees only their own conversations, memory is private or
// shared inside the tenant, the worker can only add and update the assistant's own messages and can read but never write memory,
// the audit trail keeps no words, and the administrator's audited path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

let db: TestDb;
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const app = (who: string, inst = 'a') => ({ userId: ids[who]!, institutionId: ids[inst]! });
const worker = (who: string) => ({ ...app(who), role: 'ams_worker' as const });

beforeAll(async () => {
  db = await createTestDb('assistant');
  ids.a = await one(`insert into institution (name_en) values ('A') returning id`);
  ids.b = await one(`insert into institution (name_en) values ('B') returning id`);
  for (const n of ['ann', 'bob', 'admin']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.a, n]);
  ids.eve = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'eve', 'eve') returning id`, [ids.b]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.a, ids.admin]);
  ids.convAnn = await one(`insert into assistant_conversation (institution_id, user_id, title) values ($1, $2, 'Ann chat') returning id`, [ids.a, ids.ann]);
  ids.convBob = await one(`insert into assistant_conversation (institution_id, user_id, title) values ($1, $2, 'Bob chat') returning id`, [ids.a, ids.bob]);
  ids.msgAnn = await one(`insert into assistant_message (institution_id, conversation_id, role, parts) values ($1, $2, 'user', '[{"type":"text","text":"secret question"}]') returning id`, [ids.a, ids.convAnn]);
  ids.asstAnn = await one(`insert into assistant_message (institution_id, conversation_id, role, status) values ($1, $2, 'assistant', 'queued') returning id`, [ids.a, ids.convAnn]);
});
afterAll(() => db.close());

describe('conversations and messages', () => {
  it('are visible only to their owner, never to another person, another tenant, or an administrator on the normal path', async () => {
    const titles = (who: string, inst = 'a') => db.as(app(who, inst), async (c) => (await c.query(`select title from assistant_conversation order by title`)).rows.map((r) => r.title));
    expect(await titles('ann')).toEqual(['Ann chat']);
    expect(await titles('bob')).toEqual(['Bob chat']);
    expect(await titles('admin')).toEqual([]);
    expect(await titles('eve', 'b')).toEqual([]);
    const msgs = (who: string) => db.as(app(who), async (c) => (await c.query(`select id from assistant_message`)).rowCount);
    expect(await msgs('ann')).toBe(2);
    expect(await msgs('bob')).toBe(0);
    expect(await msgs('admin')).toBe(0);
  });

  it('a person cannot write into someone else\'s conversation or make one for someone else', async () => {
    await expect(db.as(app('bob'), (c) => c.query(`insert into assistant_message (institution_id, conversation_id, role, parts) values ($1, $2, 'user', '[]')`, [ids.a, ids.convAnn]))).rejects.toThrow(/row-level security/);
    await expect(db.as(app('bob'), (c) => c.query(`insert into assistant_conversation (institution_id, user_id) values ($1, $2)`, [ids.a, ids.ann]))).rejects.toThrow(/row-level security/);
    const r = await db.as(app('bob'), (c) => c.query(`delete from assistant_conversation where id = $1`, [ids.convAnn]));
    expect(r.rowCount).toBe(0);
  });

  it('keeps an assistant message\'s status in step with its role', async () => {
    await expect(db.su.query(`insert into assistant_message (institution_id, conversation_id, role) values ($1, $2, 'assistant')`, [ids.a, ids.convAnn])).rejects.toThrow(/assistant_message_status_role_check/);
    await expect(db.su.query(`insert into assistant_message (institution_id, conversation_id, role, status) values ($1, $2, 'user', 'done')`, [ids.a, ids.convAnn])).rejects.toThrow(/assistant_message_status_role_check/);
    await expect(db.su.query(`insert into assistant_message (institution_id, conversation_id, role, status) values ($1, $2, 'assistant', 'weird')`, [ids.a, ids.convAnn])).rejects.toThrow(/assistant_message_status_check/);
  });

  it('the worker, running as the person, may update only the assistant\'s message while its turn is going', async () => {
    await db.as(worker('ann'), async (c) => {
      expect((await c.query(`select id from assistant_message`)).rowCount).toBe(2);
      await c.query(`update assistant_message set status = 'running', parts = '[{"type":"text","text":"hi"}]' where id = $1`, [ids.asstAnn]);
      await expect(c.query(`update assistant_message set parts = '[]' where id = $1`, [ids.msgAnn])).rejects.toThrow(/only assistant messages/);
    });
    // It cannot reach another person's conversation, change a column it was not given, or revive an ended turn.
    await expect(db.as(worker('bob'), (c) => c.query(`insert into assistant_message (institution_id, conversation_id, role, status) values ($1, $2, 'assistant', 'queued')`, [ids.a, ids.convAnn]))).rejects.toThrow(/row-level security/);
    await expect(db.as(worker('ann'), (c) => c.query(`update assistant_message set role = 'user' where id = $1`, [ids.asstAnn]))).rejects.toThrow(/permission denied/);
    await db.su.query(`update assistant_message set status = 'cancelled' where id = $1`, [ids.asstAnn]);
    await expect(db.as(worker('ann'), (c) => c.query(`update assistant_message set status = 'running' where id = $1`, [ids.asstAnn]))).rejects.toThrow(/has ended/);
    await expect(db.as(worker('ann'), (c) => c.query(`delete from assistant_message where id = $1`, [ids.asstAnn]))).rejects.toThrow(/permission denied/);
  });

  it('deleting a conversation deletes its messages; memory written from it stays', async () => {
    const conv = await one(`insert into assistant_conversation (institution_id, user_id, title) values ($1, $2, 'temp') returning id`, [ids.a, ids.ann]);
    const msg = await one(`insert into assistant_message (institution_id, conversation_id, role, parts) values ($1, $2, 'user', '[]') returning id`, [ids.a, conv]);
    const mem = await one(`insert into memory_item (institution_id, scope_type, visibility, kind, text, created_by, source_conversation_id, source_message_id) values ($1, 'institution', 'private', 'fact', 'kept', $2, $3, $4) returning id`, [ids.a, ids.ann, conv, msg]);
    await db.as(app('ann'), (c) => c.query(`delete from assistant_conversation where id = $1`, [conv]));
    expect((await db.su.query(`select 1 from assistant_message where conversation_id = $1`, [conv])).rowCount).toBe(0);
    expect((await db.su.query(`select source_conversation_id, source_message_id from memory_item where id = $1`, [mem])).rows[0]).toEqual({ source_conversation_id: null, source_message_id: null });
  });
});

describe('memory_item', () => {
  it('private rows belong to their author alone; workspace rows to the tenant; nobody sees another tenant\'s', async () => {
    await db.su.query(`delete from memory_item`);
    await db.su.query(`insert into memory_item (institution_id, scope_type, visibility, kind, text, created_by) values
      ($1, 'institution', 'private', 'fact', 'ann private', $2), ($1, 'institution', 'workspace', 'convention', 'team note', $3), ($4, 'institution', 'workspace', 'fact', 'other tenant', $5)`, [ids.a, ids.ann, ids.bob, ids.b, ids.eve]);
    const texts = (who: string, inst = 'a') => db.as(app(who, inst), async (c) => (await c.query(`select text from memory_item order by text`)).rows.map((r) => r.text));
    expect(await texts('ann')).toEqual(['ann private', 'team note']);
    expect(await texts('bob')).toEqual(['team note']);
    expect(await texts('admin')).toEqual(['team note']); // not even an administrator reads a private note
    expect(await texts('eve', 'b')).toEqual(['other tenant']);
    // A private note cannot be written as someone else's.
    await expect(db.as(app('bob'), (c) => c.query(`insert into memory_item (institution_id, scope_type, visibility, kind, text, created_by) values ($1, 'institution', 'private', 'fact', 'forged', $2)`, [ids.a, ids.ann]))).rejects.toThrow(/row-level security/);
  });

  it('the worker reads memory (own private + shared) and can never write it', async () => {
    await db.as(worker('bob'), async (c) => {
      expect((await c.query(`select text from memory_item`)).rows.map((r) => r.text)).toEqual(['team note']);
      await expect(c.query(`insert into memory_item (institution_id, scope_type, visibility, kind, text) values ($1, 'institution', 'private', 'fact', 'x')`, [ids.a])).rejects.toThrow(/permission denied/);
    });
    await expect(db.as(worker('bob'), (c) => c.query(`update memory_item set text = 'y'`))).rejects.toThrow(/permission denied/);
    await expect(db.as(worker('bob'), (c) => c.query(`delete from memory_item`))).rejects.toThrow(/permission denied/);
  });

  it('refuses empty text, over-long text and a scope without its id', async () => {
    await expect(db.su.query(`insert into memory_item (institution_id, scope_type, visibility, kind, text) values ($1, 'institution', 'private', 'fact', E' \n\t ')`, [ids.a])).rejects.toThrow(/cannot be empty/);
    await expect(db.su.query(`update memory_item set text = '' where text = 'team note'`)).rejects.toThrow(/cannot be empty/);
    await expect(db.su.query(`insert into memory_item (institution_id, scope_type, visibility, kind, text) values ($1, 'institution', 'private', 'fact', $2)`, [ids.a, 'x'.repeat(1001)])).rejects.toThrow(/memory_item_text_length_check/);
    await expect(db.su.query(`insert into memory_item (institution_id, scope_type, visibility, kind, text) values ($1, 'version', 'private', 'fact', 'x')`, [ids.a])).rejects.toThrow(/memory_item_scope_id_check/);
    await expect(db.su.query(`insert into memory_item (institution_id, scope_type, scope_id, visibility, kind, text) values ($1, 'institution', gen_random_uuid(), 'private', 'fact', 'x')`, [ids.a])).rejects.toThrow(/memory_item_scope_id_check/);
    await expect(db.su.query(`insert into memory_item (institution_id, scope_type, visibility, kind, text) values ($1, 'institution', 'secret', 'fact', 'x')`, [ids.a])).rejects.toThrow(/memory_item_visibility_check/);
  });
});

describe('audit', () => {
  it('records conversations and memory as metadata only, never the words', async () => {
    const c = await one(`insert into assistant_conversation (institution_id, user_id, title, context) values ($1, $2, 'private title words', '{"route":"/x"}') returning id`, [ids.a, ids.ann]);
    await db.su.query(`update assistant_conversation set title = 'edited title words' where id = $1`, [c]);
    await db.su.query(`insert into memory_item (institution_id, scope_type, visibility, kind, text, created_by) values ($1, 'institution', 'private', 'fact', 'remembered words', $2)`, [ids.a, ids.ann]);
    const rows = (await db.su.query(`select * from audit_event where target_type in ('assistant_conversation', 'memory_item')`)).rows;
    expect(rows.length).toBeGreaterThan(3);
    const all = JSON.stringify(rows);
    for (const words of ['private title words', 'edited title words', 'remembered words', 'secret question', '/x']) expect(all).not.toContain(words);
    expect(rows.some((r) => r.target_type === 'memory_item' && r.after?.visibility === 'private')).toBe(true);
    expect((await db.su.query(`select 1 from audit_event where target_type = 'assistant_message'`)).rowCount).toBe(0);
  });

  it('the administrator path: administrators only, same tenant, each read recorded; others and the worker are refused', async () => {
    await db.su.query(`delete from audit_event where action like 'assistant_audit_%'`).catch(() => undefined); // append-only: not expected to work
    const list = await db.as(app('admin'), async (c) => (await c.query(`select id, title from assistant_audit_conversations($1)`, [ids.ann])).rows);
    expect(list.map((r) => r.id)).toContain(ids.convAnn);
    const msgs = await db.as(app('admin'), async (c) => (await c.query(`select id from assistant_audit_messages($1)`, [ids.convAnn])).rows);
    expect(msgs.length).toBe(2);
    const events = (await db.su.query(`select action, actor_id, target_id from audit_event where action like 'assistant_audit_%' order by at`)).rows;
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['assistant_audit_list', 'assistant_audit_read']));
    expect(events.every((e) => e.actor_id === ids.admin)).toBe(true);
    await expect(db.as(app('bob'), (c) => c.query(`select * from assistant_audit_conversations()`))).rejects.toThrow(/only an administrator/);
    await expect(db.as(app('ann'), (c) => c.query(`select * from assistant_audit_messages($1)`, [ids.convAnn]))).rejects.toThrow(/only an administrator/);
    await expect(db.as(worker('admin'), (c) => c.query(`select * from assistant_audit_conversations()`))).rejects.toThrow(/permission denied/);
    // Another tenant's administrator sees nothing of this tenant.
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.b, ids.eve]);
    expect(await db.as(app('eve', 'b'), async (c) => (await c.query(`select id from assistant_audit_conversations()`)).rows)).toEqual([]);
    await expect(db.as(app('eve', 'b'), (c) => c.query(`select * from assistant_audit_messages($1)`, [ids.convAnn]))).rejects.toThrow(/conversation not found/);
  });
});

describe('memory and the things it is about', () => {
  it('is archived, not orphaned, when a standard, version or engagement is deleted', async () => {
    const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Council', 'C', 'institutional') returning id`, [ids.a]);
    const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Handbook', 'institution') returning id`, [ids.a, acc]);
    const ver = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '1') returning id`, [ids.a, fw]);
    const m = await one(`insert into memory_item (institution_id, scope_type, scope_id, visibility, kind, text, created_by) values ($1, 'version', $2, 'workspace', 'fact', 'about v1', $3) returning id`, [ids.a, ver, ids.bob]);
    await db.su.query(`delete from framework_version where id = $1`, [ver]);
    expect((await db.su.query(`select archived_at from memory_item where id = $1`, [m])).rows[0].archived_at).not.toBeNull();
  });
});
