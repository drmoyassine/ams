// The in-app assistant API (DEC-027) through the five-step chain: permissions, ownership, sending a message (context chips checked,
// the job queued, the model never called by the API), polling, stopping, the memory cards and memory CRUD with its rules. The
// worker part runs with a fake model.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeAiModel, fakeToolCalls, handlers, runJob, setAiModelForTests } from '@ams/core';
import type { JobEnvelope } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const sent: JobEnvelope[] = [];
const queue = { send: async (_t: string, e: JobEnvelope) => { sent.push(e); } };
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const drain = async () => { while (sent.length) await runJob(pool, 'assistant', sent.shift(), handlers, { queue }); };

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('apiassistant');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, queue, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [n, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer'], ['ext', 'external_reviewer']] as const) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
    await db.su.query(
      `insert into role_assignment (institution_id, user_id, role, scope_type, scope_id, expires_at) values ($1, $2, $3, 'institution', $1, ${role === 'external_reviewer' ? `now() + interval '30 days'` : 'null'})`,
      [ids.inst, ids[n], role]);
  }
  ids.acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Handbook', 'institution') returning id`, [ids.inst, ids.acc]);
  ids.ver = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2025') returning id`, [ids.inst, ids.fw]);
  ids.req = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title, official_text) values ($1, $2, '1.1', 'Standard', 'Library resources', 'The library supports learning.') returning id`, [ids.inst, ids.ver]);
}, 30000);
afterAll(async () => { setAiModelForTests(null); await pool.end(); await db.close(); });
afterEach(() => setAiModelForTests(null));

describe('permissions', () => {
  it('needs a sign-in and the right to read the organisation; external reviewers are out; the audit path is for administrators', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      '/api/assistant/status', '/api/assistant/conversations', '/api/assistant/conversations/{id}', '/api/assistant/conversations/{id}/messages', '/api/assistant/messages/{id}/cancel',
      '/api/assistant/memory-proposals/{messageId}/{partId}/confirm', '/api/assistant/memory-proposals/{messageId}/{partId}/decline', '/api/assistant/memory', '/api/assistant/memory/{id}',
    ]));
    expect((await call(null, 'GET', '/api/assistant/status')).status).toBe(401);
    expect((await call('ext', 'GET', '/api/assistant/status')).status).toBe(403);
    expect((await call('ext', 'GET', '/api/assistant/memory')).status).toBe(403);
    expect((await call('viewer', 'GET', '/api/assistant/status')).status).toBe(200);
    expect((await call('viewer', 'GET', '/api/assistant/audit/conversations')).status).toBe(403);
    expect((await call('lead', 'GET', '/api/assistant/audit/conversations')).status).toBe(403);
    expect((await call('admin', 'GET', '/api/assistant/audit/conversations')).status).toBe(200);
  });

  it('reports why the assistant cannot be used, in words', async () => {
    const off = await call('viewer', 'GET', '/api/assistant/status');
    expect(off.body).toMatchObject({ available: false, reason: 'not_configured', turnsPerHour: 30 });
    expect(off.body.message).toMatch(/not configured/i);
    const send = await call('viewer', 'POST', '/api/assistant/conversations', { text: 'hi' });
    expect(send.status).toBe(409);
    expect(send.body.message).toMatch(/not configured/i);
    setAiModelForTests(createFakeAiModel(['x']).model);
    expect((await call('viewer', 'GET', '/api/assistant/status')).body).toMatchObject({ available: true, reason: null });
  });
});

describe('a conversation over the API', () => {
  it('creates with a first message, queues the job (the API calls no model), polls, answers with links, renames and deletes', async () => {
    const fake = createFakeAiModel([fakeToolCalls([{ name: 'search_requirements', input: { versionId: ids.ver, query: 'library' } }]), 'The library one is **1.1**.']);
    setAiModelForTests(fake.model);
    sent.length = 0;
    const created = await call('viewer', 'POST', '/api/assistant/conversations', { text: 'Which standard is about the library?', context: { versionId: ids.ver, tab: 'requirements' } });
    expect(created.status).toBe(201);
    expect(created.body.userMessage).toMatchObject({ role: 'user', context: { versionId: ids.ver, tab: 'requirements' } });
    expect(created.body.assistantMessage).toMatchObject({ role: 'assistant', status: 'queued', parts: [] });
    expect(created.body.conversation.title).toBe('Which standard is about the library?');
    expect(sent).toHaveLength(1);
    expect(fake.calls).toHaveLength(0); // nothing was sent to a model by the request
    const conv = created.body.conversation.id as string;

    await drain();
    const poll = await call('viewer', 'GET', `/api/assistant/conversations/${conv}/messages`);
    expect(poll.status).toBe(200);
    const reply = poll.body.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(reply.status).toBe('done');
    expect(reply.parts.map((p: { type: string }) => p.type)).toEqual(['tool_call', 'tool_result', 'text']);
    expect(reply.parts[1].links[0]).toMatchObject({ kind: 'requirement', id: ids.req, code: '1.1', versionId: ids.ver });
    const next = await call('viewer', 'GET', `/api/assistant/conversations/${conv}/messages?after=${encodeURIComponent(poll.body.cursor)}`);
    expect(next.body.messages).toEqual([]);

    expect((await call('viewer', 'GET', `/api/assistant/conversations/${conv}`)).body.messages).toHaveLength(2);
    expect((await call('viewer', 'GET', '/api/assistant/conversations')).body.map((c: { id: string }) => c.id)).toContain(conv);
    expect((await call('viewer', 'PATCH', `/api/assistant/conversations/${conv}`, { title: 'Library question' })).body.title).toBe('Library question');
    // Not anybody else's.
    expect((await call('lead', 'GET', `/api/assistant/conversations/${conv}`)).status).toBe(404);
    expect((await call('lead', 'GET', `/api/assistant/conversations/${conv}/messages`)).status).toBe(404);
    expect((await call('admin', 'DELETE', `/api/assistant/conversations/${conv}`)).status).toBe(404);
    expect((await call('lead', 'GET', '/api/assistant/conversations')).body).toEqual([]);
    // The administrator's audited view.
    const audit = await call('admin', 'GET', `/api/assistant/audit/conversations?userId=${ids.viewer}`);
    expect(audit.body.map((c: { id: string }) => c.id)).toContain(conv);
    expect((await call('admin', 'GET', `/api/assistant/audit/conversations/${conv}/messages`)).body).toHaveLength(2);
    expect((await call('viewer', 'DELETE', `/api/assistant/conversations/${conv}`)).status).toBe(204);
    expect((await call('viewer', 'GET', `/api/assistant/conversations/${conv}`)).status).toBe(404);
  });

  it('checks the context chips against what the person may read, and validates the body', async () => {
    setAiModelForTests(createFakeAiModel(['x']).model);
    const conv = (await call('viewer', 'POST', '/api/assistant/conversations', {})).body.conversation.id as string;
    expect((await call('viewer', 'POST', `/api/assistant/conversations/${conv}/messages`, { text: 'hi', context: { versionId: crypto.randomUUID() } })).status).toBe(404);
    expect((await call('viewer', 'POST', `/api/assistant/conversations/${conv}/messages`, { text: 'hi', context: { selectedIds: [ids.req] } })).status).toBe(400);
    expect((await call('viewer', 'POST', `/api/assistant/conversations/${conv}/messages`, { text: '   ' })).status).toBe(400);
    expect((await call('viewer', 'POST', `/api/assistant/conversations/${conv}/messages`, { text: 'hi', context: { route: 'not-a-path' } })).status).toBe(400);
    sent.length = 0;
    const ok = await call('viewer', 'POST', `/api/assistant/conversations/${conv}/messages`, { text: 'hi', context: { versionId: ids.ver, selectedIds: [ids.req] } });
    expect(ok.status).toBe(201);
    // One turn at a time.
    const again = await call('viewer', 'POST', `/api/assistant/conversations/${conv}/messages`, { text: 'and again' });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/still answering/);
    // Stop it: only its owner can.
    expect((await call('lead', 'POST', `/api/assistant/messages/${ok.body.assistantMessage.id}/cancel`)).status).toBe(404);
    expect((await call('viewer', 'POST', `/api/assistant/messages/${ok.body.assistantMessage.id}/cancel`)).body).toMatchObject({ status: 'cancelled' });
    expect((await call('viewer', 'POST', `/api/assistant/conversations/${conv}/messages`, { text: 'and again' })).status).toBe(201);
    sent.length = 0;
  });

  it('answers 429 with the limit when a person has used their turns for the hour', async () => {
    setAiModelForTests(createFakeAiModel(['x']).model);
    await db.su.query(`insert into job (institution_id, type, payload, created_by) select $1, 'assistant', '{}'::jsonb, $2 from generate_series(1, 30)`, [ids.inst, ids.lead]);
    const r = await call('lead', 'POST', '/api/assistant/conversations', { text: 'one too many' });
    expect(r.status).toBe(429);
    expect(r.body.message).toMatch(/30 assistant questions/);
    sent.length = 0;
    await db.su.query(`delete from job where type = 'assistant' and created_by = $1`, [ids.lead]);
  });
});

describe('memory over the API', () => {
  it('a card is saved only on confirm, as the person, under the rules; CRUD respects ownership and scope', async () => {
    setAiModelForTests(createFakeAiModel([
      fakeToolCalls([{ name: 'propose_memory', input: { text: 'We call Measure Indicator group', scope: { type: 'version', id: ids.ver }, visibility: 'workspace', kind: 'convention' } }]),
      'I suggested it.',
    ]).model);
    sent.length = 0;
    const created = await call('lead', 'POST', '/api/assistant/conversations', { text: 'Remember we call Measure Indicator group' });
    await drain();
    const conv = (await call('lead', 'GET', `/api/assistant/conversations/${created.body.conversation.id}`)).body;
    const msg = conv.messages.find((m: { role: string }) => m.role === 'assistant');
    const card = msg.parts.find((p: { type: string }) => p.type === 'memory_proposal');
    expect(card).toMatchObject({ status: 'pending', visibility: 'workspace', scope: { type: 'version', id: ids.ver, label: 'IC 2025' } });
    expect((await call('lead', 'GET', '/api/assistant/memory')).body).toEqual([]);
    // A viewer cannot confirm someone else's card.
    expect((await call('viewer', 'POST', `/api/assistant/memory-proposals/${msg.id}/${card.id}/confirm`, {})).status).toBe(404);
    const saved = await call('lead', 'POST', `/api/assistant/memory-proposals/${msg.id}/${card.id}/confirm`, { text: 'We call Measure "Indicator group"' });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ text: 'We call Measure "Indicator group"', visibility: 'workspace', mine: true, canEdit: true, createdByName: 'lead', scope: { label: 'IC 2025' } });
    expect((await call('lead', 'POST', `/api/assistant/memory-proposals/${msg.id}/${card.id}/confirm`, {})).status).toBe(409);

    // The shared note is visible to a viewer (can read the version) but not editable by them.
    const seen = await call('viewer', 'GET', '/api/assistant/memory?tab=shared');
    expect(seen.body).toHaveLength(1);
    expect(seen.body[0]).toMatchObject({ id: saved.body.id, mine: false, canEdit: false });
    expect((await call('viewer', 'PATCH', `/api/assistant/memory/${saved.body.id}`, { text: 'x' })).status).toBe(403);
    expect((await call('viewer', 'DELETE', `/api/assistant/memory/${saved.body.id}`)).status).toBe(403);
    // The viewer's own shared note is refused (no permission to edit standards), a personal one is fine.
    expect((await call('viewer', 'POST', '/api/assistant/memory', { text: 'shared by viewer', scopeType: 'version', scopeId: ids.ver, visibility: 'workspace' })).status).toBe(403);
    const mine = await call('viewer', 'POST', '/api/assistant/memory', { text: 'I prefer short answers', scopeType: 'institution', visibility: 'private', kind: 'preference' });
    expect(mine.status).toBe(201);
    expect((await call('lead', 'GET', '/api/assistant/memory')).body.map((m: { id: string }) => m.id)).not.toContain(mine.body.id); // private stays private
    expect((await call('lead', 'PATCH', `/api/assistant/memory/${mine.body.id}`, { text: 'hijack' })).status).toBe(404);
    const edited = await call('viewer', 'PATCH', `/api/assistant/memory/${mine.body.id}`, { pinned: true, text: 'I prefer very short answers' });
    expect(edited.body).toMatchObject({ pinned: true, text: 'I prefer very short answers' });
    // Validation.
    expect((await call('viewer', 'POST', '/api/assistant/memory', { text: '', scopeType: 'institution' })).status).toBe(400);
    expect((await call('viewer', 'POST', '/api/assistant/memory', { text: 'x', scopeType: 'version' })).status).toBe(400);
    expect((await call('viewer', 'POST', '/api/assistant/memory', { text: 'x'.repeat(1001), scopeType: 'institution' })).status).toBe(400);
    // Delete archives, then purges.
    expect((await call('viewer', 'DELETE', `/api/assistant/memory/${mine.body.id}`)).body).toEqual({ purged: false });
    expect((await call('viewer', 'GET', '/api/assistant/memory')).body.map((m: { id: string }) => m.id)).not.toContain(mine.body.id);
    expect((await call('viewer', 'GET', '/api/assistant/memory?includeArchived=true&tab=mine')).body.map((m: { id: string }) => m.id)).toContain(mine.body.id);
    expect((await call('viewer', 'DELETE', `/api/assistant/memory/${mine.body.id}`)).body).toEqual({ purged: true });
    // Filter by scope.
    expect((await call('lead', 'GET', `/api/assistant/memory?scopeType=version&scopeId=${ids.ver}`)).body).toHaveLength(1);
    expect((await call('lead', 'GET', '/api/assistant/memory?scopeType=institution')).body).toHaveLength(0);
  });
});
