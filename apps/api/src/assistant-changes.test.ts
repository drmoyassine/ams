// The assistant's bulk edits over the API (DEC-027 Phase 2), through the five-step chain: only a person with framework:write can
// confirm or apply, only for their own proposals; the apply answers with ONE small X-Undo descriptor that the existing Undo / Redo
// machinery (X-Replay) runs; a proposal that no longer holds is answered as stale and changes nothing. The model is a fake.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeAiModel, fakeToolCalls, handlers, runJob, setAiModelForTests } from '@ams/core';
import { REPLAY_HEADER, UNDO_HEADER, UndoDescriptorSchema, type JobEnvelope } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const sent: JobEnvelope[] = [];
const queue = { send: async (_t: string, e: JobEnvelope) => { sent.push(e); } };
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const undo = res.headers.get(UNDO_HEADER);
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Json, undo: undo ? UndoDescriptorSchema.parse(JSON.parse(decodeURIComponent(undo))) : null, undoRaw: undo };
}
const drain = async () => { while (sent.length) await runJob(pool, 'assistant', sent.shift(), handlers, { queue }); };
const state = async () => (await db.su.query(`select code, title, official_text, is_assessable from requirement where framework_version_id = $1 order by code`, [ids.draft])).rows.map((r) => JSON.stringify(r)).join('|');

/** The model proposes (scripted), through the real API and job; returns the ids of the card. */
async function proposeVia(who: string, operations: unknown[]) {
  setAiModelForTests(createFakeAiModel([fakeToolCalls([{ name: 'propose_changes', input: { versionId: ids.draft, summary: 'Change the indicators', operations } }]), 'Press Do it.']).model);
  await db.su.query(`delete from job where type = 'assistant'`);
  sent.length = 0;
  const created = await call(who, 'POST', '/api/assistant/conversations', { text: 'please change them', context: { versionId: ids.draft } });
  expect(created.status).toBe(201);
  await drain();
  const poll = await call(who, 'GET', `/api/assistant/conversations/${created.body.conversation.id}/messages`);
  const message = poll.body.messages.find((m: Json) => m.role === 'assistant');
  const part = message.parts.find((p: Json) => p.type === 'change_proposal');
  return { message, part, path: `/api/assistant/change-proposals/${message.id}/${part?.id}` };
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('apiassistantchanges');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, queue, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [n, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[n], role]);
  }
  ids.acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Handbook', 'institution') returning id`, [ids.inst, ids.acc]);
  ids.draft = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2025') returning id`, [ids.inst, ids.fw]);
  for (let i = 1; i <= 6; i += 1) {
    await db.su.query(`insert into requirement (institution_id, framework_version_id, code, level_label, title, official_text, display_order) values ($1, $2, $3, 'Indicator', $3, $4, $5)`, [ids.inst, ids.draft, `1-1-${i}`, `The statement of indicator ${i}`, i]);
  }
}, 30000);
afterAll(async () => { setAiModelForTests(null); await pool.end(); await db.close(); });
afterEach(() => setAiModelForTests(null));

describe('permissions', () => {
  it('only a person who may write standards can confirm, apply, cancel, undo or redo; reading the markers needs only read access', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      '/api/assistant/change-proposals/{messageId}/{partId}/confirm', '/api/assistant/change-proposals/{messageId}/{partId}/apply', '/api/assistant/change-proposals/{messageId}/{partId}/decline',
      '/api/assistant/changes/{id}/undo', '/api/assistant/changes/{id}/redo', '/api/assistant/written-texts/{id}/keep', '/api/assistant/written-texts/{id}/revert',
      '/api/framework-versions/{id}/assistant-texts',
    ]));
    const zero = '00000000-0000-0000-0000-000000000000';
    const writes: [string, string, unknown?][] = [
      ['POST', `/api/assistant/change-proposals/${zero}/p/confirm`], ['POST', `/api/assistant/change-proposals/${zero}/p/apply`, { token: 'x'.repeat(40) }],
      ['POST', `/api/assistant/change-proposals/${zero}/p/decline`], ['POST', `/api/assistant/changes/${zero}/undo`], ['POST', `/api/assistant/changes/${zero}/redo`],
      ['POST', `/api/assistant/written-texts/${zero}/keep`], ['POST', `/api/assistant/written-texts/${zero}/revert`],
    ];
    for (const [m, p, b] of writes) {
      expect((await call(null, m, p, b)).status, p).toBe(401);
      expect((await call('viewer', m, p, b)).status, p).toBe(403);
      expect((await call('lead', m, p, b)).status, p).toBe(404); // allowed to try; nothing there
    }
    expect((await call('viewer', 'GET', `/api/framework-versions/${ids.draft}/assistant-texts`)).status).toBe(200);
    expect((await call(null, 'GET', `/api/framework-versions/${ids.draft}/assistant-texts`)).status).toBe(401);
  });
});

describe('propose, confirm, apply, undo, redo over HTTP', () => {
  it('runs the whole path with ONE small undo descriptor that the normal Undo / Redo (X-Replay) machinery runs', async () => {
    const before = await state();
    const { message, part, path } = await proposeVia('lead', [{ op: 'swap_title_and_description', filter: { level: 'Indicator' } }]);
    expect(part).toMatchObject({ status: 'pending', counts: { items: 6 } });
    expect(await state()).toBe(before); // proposing changed nothing
    expect(part.examples.length).toBeGreaterThanOrEqual(2);

    // Apply without a token is refused; a made-up token is refused; nobody else can confirm it.
    expect((await call('lead', 'POST', `${path}/apply`, {})).status).toBe(400);
    expect((await call('lead', 'POST', `${path}/apply`, { token: 'x'.repeat(43) })).status).toBe(409);
    expect((await call('admin', 'POST', `${path}/confirm`)).status).toBe(404);

    const confirm = await call('lead', 'POST', `${path}/confirm`);
    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({ status: 'ready', changeSetHash: part.changeSetHash });
    expect(confirm.body.token.length).toBeGreaterThan(30);
    expect(await state()).toBe(before); // a confirmation is not an application

    const applied = await call('lead', 'POST', `${path}/apply`, { token: confirm.body.token });
    expect(applied.status).toBe(200);
    expect(applied.body.status).toBe('applied');
    expect(applied.body.message).toMatch(/^Changed 6 items in IC 2025/);
    expect(await state()).not.toBe(before);
    expect(applied.undo).toMatchObject({ method: 'POST', path: expect.stringMatching(/^\/api\/assistant\/changes\/[0-9a-f-]{36}\/undo$/) });
    expect(applied.undoRaw!.length).toBeLessThan(600);
    // The single-use token is spent; the card is closed.
    expect((await call('lead', 'POST', `${path}/apply`, { token: confirm.body.token })).status).toBe(409);
    expect((await call('lead', 'POST', `${path}/confirm`)).status).toBe(409);

    // Undo as the client sends it (X-Replay: undo): the answer carries the Redo descriptor.
    const undone = await call('lead', applied.undo!.method, applied.undo!.path, applied.undo!.body, { [REPLAY_HEADER]: 'undo' });
    expect(undone.status).toBe(200);
    expect(undone.body.state).toBe('undone');
    expect(await state()).toBe(before);
    expect(undone.undo).toMatchObject({ kind: 'redo', path: applied.undo!.path.replace('/undo', '/redo') });
    const redone = await call('lead', undone.undo!.method, undone.undo!.path, undone.undo!.body, { [REPLAY_HEADER]: 'redo' });
    expect(redone.status).toBe(200);
    expect(redone.body.state).toBe('applied');
    expect(redone.undo).toMatchObject({ kind: 'undo', path: applied.undo!.path });
    expect(await state()).not.toBe(before);
    // The conversation shows the result, in the part, to the person only.
    const conv = await call('lead', 'GET', `/api/assistant/conversations/${message.conversationId}`);
    expect(conv.body.messages.find((m: Json) => m.id === message.id).parts.find((p: Json) => p.type === 'change_proposal')).toMatchObject({ status: 'applied', result: { state: 'applied', items: 6 } });
    expect((await call('admin', 'GET', `/api/assistant/conversations/${message.conversationId}`)).status).toBe(404);
    // Only its owner can undo it.
    expect((await call('admin', 'POST', applied.undo!.path)).status).toBe(404);
    await call('lead', 'POST', applied.undo!.path, undefined, { [REPLAY_HEADER]: 'undo' });
    expect(await state()).toBe(before);
  });

  it('answers 200 stale (and changes nothing) when the standards changed after the proposal; Cancel closes a card', async () => {
    const p = await proposeVia('lead', [{ op: 'prefix_or_replace_text', filter: { level: 'Indicator' }, field: 'title', mode: 'prefix', text: '* ' }]);
    const c = await call('lead', 'POST', `${p.path}/confirm`);
    await db.su.query(`update requirement set title = 'Edited meanwhile' where framework_version_id = $1 and code = '1-1-1'`, [ids.draft]);
    const before = await state();
    const applied = await call('lead', 'POST', `${p.path}/apply`, { token: c.body.token });
    expect(applied.status).toBe(200);
    expect(applied.body.status).toBe('stale');
    expect(applied.body.message).toMatch(/Nothing was changed/);
    expect(applied.undo).toBeNull();
    expect(await state()).toBe(before);

    const q = await proposeVia('lead', [{ op: 'bulk_set_assessable', filter: { level: 'Indicator' }, value: false }]);
    const cancelled = await call('lead', 'POST', `${q.path}/decline`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await call('lead', 'POST', `${q.path}/confirm`)).status).toBe(409);
  });

  it('a viewer asking the assistant for a change gets a refusal from the tool, and no card', async () => {
    setAiModelForTests(createFakeAiModel([fakeToolCalls([{ name: 'propose_changes', input: { versionId: ids.draft, summary: 'x', operations: [{ op: 'bulk_set_assessable', filter: {}, value: false }] } }]), 'I cannot change standards for you.']).model);
    sent.length = 0;
    const created = await call('viewer', 'POST', '/api/assistant/conversations', { text: 'change them' });
    expect(created.status).toBe(201);
    await drain();
    const poll = await call('viewer', 'GET', `/api/assistant/conversations/${created.body.conversation.id}/messages`);
    const reply = poll.body.messages.find((m: Json) => m.role === 'assistant');
    expect(reply.parts.some((p: Json) => p.type === 'change_proposal')).toBe(false);
    expect(reply.parts.find((p: Json) => p.type === 'tool_result')).toMatchObject({ refused: true });
  });
});
