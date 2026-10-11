import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeAiModel, createFakeEmbedder, setAiModelForTests, setEmbedderForTests } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

const KEY = 'sk-api-test-key-wxyz';
let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeAll(async () => {
  process.env.APP_SECRET = 'a'.repeat(40);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('apiai');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1), ($1, $3, 'lead', 'institution', $1)`, [ids.inst, ids.admin, ids.lead]);
}, 30000);
afterEach(() => setAiModelForTests(null));
afterAll(async () => { delete process.env.APP_SECRET; await pool.end(); await db.close(); });


const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const stubProvider = (urls: Record<string, unknown>) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.entries(urls).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
};

describe('AI settings API', () => {
  let accountId = '';

  it('is documented, needs a sign-in, and is for the admin only', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      '/api/settings/ai', '/api/settings/ai/test', '/api/settings/ai/accounts', '/api/settings/ai/accounts/{id}', '/api/settings/ai/accounts/{id}/test', '/api/settings/ai/accounts/{id}/models',
    ]));
    const any = '00000000-0000-4000-8000-000000000000';
    for (const [m, p, body] of [
      ['GET', '/api/settings/ai'], ['PUT', '/api/settings/ai', {}], ['POST', '/api/settings/ai/test', {}],
      ['GET', '/api/settings/ai/accounts'], ['POST', '/api/settings/ai/accounts', { provider: 'openai' }], ['PATCH', `/api/settings/ai/accounts/${any}`, {}],
      ['DELETE', `/api/settings/ai/accounts/${any}`], ['POST', `/api/settings/ai/accounts/${any}/test`, {}], ['GET', `/api/settings/ai/accounts/${any}/models`],
    ] as [string, string, unknown?][]) {
      expect((await call(null, m, p, body)).status, `${m} ${p}`).toBe(401);
      expect((await call('lead', m, p, body)).status, `${m} ${p}`).toBe(403);
    }
  });

  it('creates an account and never returns the key', async () => {
    const post = await call('admin', 'POST', '/api/settings/ai/accounts', { name: 'Work OpenAI', provider: 'openai', apiKey: KEY });
    expect(post.status).toBe(201);
    expect(post.body).toMatchObject({ name: 'Work OpenAI', provider: 'openai', keyConfigured: true, keyLast4: 'wxyz', keySource: 'saved', usedFor: [] });
    expect(post.text).not.toContain(KEY);
    accountId = post.body.id;
    const list = await call('admin', 'GET', '/api/settings/ai/accounts');
    expect(list.body).toHaveLength(1);
    expect(list.text).not.toContain(KEY);
    expect((await db.su.query(`select api_key_enc from ai_account`)).rows[0].api_key_enc).not.toContain(KEY);
  });

  it('refuses a bad account: unknown fields, a short key, a missing or bad Base URL, a name in use', async () => {
    const bad = (body: unknown) => call('admin', 'POST', '/api/settings/ai/accounts', body);
    expect((await bad({ provider: 'cohere' })).status).toBe(400);
    expect((await bad({ provider: 'openai', apiKey: 'short' })).status).toBe(400);
    expect((await bad({ provider: 'openai', surprise: true })).status).toBe(400);
    expect((await bad({ provider: 'openai_compatible' })).status).toBe(400);
    expect((await bad({ provider: 'openai_compatible', baseUrl: 'http://u:p@host/v1' })).status).toBe(400);
    expect((await bad({ provider: 'openrouter', baseUrl: 'http://host/v1' })).status).toBe(400);
    expect((await bad({ name: 'work openai', provider: 'openai' })).status).toBe(400);
  });

  it('updates an account; changing the provider removes the key unless a new one comes with it', async () => {
    const renamed = await call('admin', 'PATCH', `/api/settings/ai/accounts/${accountId}`, { name: 'Work OpenAI (main)' });
    expect(renamed.body).toMatchObject({ name: 'Work OpenAI (main)', keyLast4: 'wxyz' });
    const moved = await call('admin', 'PATCH', `/api/settings/ai/accounts/${accountId}`, { provider: 'openrouter' });
    expect(moved.body).toMatchObject({ provider: 'openrouter', keyConfigured: false, keyLast4: null });
    const keyed = await call('admin', 'PATCH', `/api/settings/ai/accounts/${accountId}`, { provider: 'openai', apiKey: KEY });
    expect(keyed.body).toMatchObject({ provider: 'openai', keyLast4: 'wxyz' });
    expect((await call('admin', 'PATCH', `/api/settings/ai/accounts/${crypto.randomUUID()}`, { name: 'x' })).status).toBe(404);
  });

  it('assigns the account and saves the settings: model, OCR options, cap, recovery rounds', async () => {
    const put = await call('admin', 'PUT', '/api/settings/ai', {
      enabled: true, analysis: { accountId, model: 'some-model' }, reading: { ocrEnabled: true, maxPages: 120, language: 'ar' },
      cap: { unit: 'tokens', tokens: 3_000_000 }, maxRecoveryRounds: 3,
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      enabled: true, analysis: { accountId, model: 'some-model' }, reading: { accountId: null, model: null, ocrEnabled: true, maxPages: 120, language: 'ar' },
      cap: { unit: 'tokens', tokens: 3_000_000, usd: null, usdAvailable: false }, maxRecoveryRounds: 3,
    });
    const got = await call('admin', 'GET', '/api/settings/ai');
    expect(got.text).not.toContain(KEY);
    expect(got.text).not.toMatch(/apiKey|UsdPerMTok/);
    expect((await call('admin', 'GET', '/api/settings/ai/accounts')).body[0].usedFor).toEqual(['analysis']);
  });

  it('refuses unknown or unreasonable values: the old price fields, a negative cap, rounds out of range, an unknown account', async () => {
    const put = (body: unknown) => call('admin', 'PUT', '/api/settings/ai', body);
    expect((await put({ surprise: true })).status).toBe(400);
    expect((await put({ cap: { tokens: -5 } })).status).toBe(400);
    expect((await put({ cap: { inputUsdPerMTok: 3 } })).status).toBe(400);
    expect((await put({ maxCostUsdPerRun: 2 })).status).toBe(400);
    expect((await put({ reading: { maxPages: 0 } })).status).toBe(400);
    for (const bad of [6, -1, 1.5, null]) expect((await put({ maxRecoveryRounds: bad })).status, String(bad)).toBe(400);
    expect((await put({ analysis: { accountId: crypto.randomUUID(), model: 'm' } })).status).toBe(400);
    expect((await put({ cap: { unit: 'usd', usd: 2 } })).status).toBe(400); // OpenAI's list gives no price
    expect((await call('lead', 'PUT', '/api/settings/ai', { maxRecoveryRounds: 1 })).status).toBe(403);
  });

  it('lists the account\'s models from the provider, server side, and says why when it cannot', async () => {
    stubProvider({ 'https://api.openai.com/v1/models': { data: [{ id: 'gpt-x' }, { id: 'text-embedding-9' }] } });
    const chat = await call('admin', 'GET', `/api/settings/ai/accounts/${accountId}/models?kind=chat`);
    expect(chat.body).toMatchObject({ models: [{ id: 'gpt-x', kind: 'chat' }], error: null });
    expect(chat.text).not.toContain(KEY);
    expect((await call('admin', 'GET', `/api/settings/ai/accounts/${accountId}/models?kind=embedding&refresh=true`)).body.models).toEqual([{ id: 'text-embedding-9', kind: 'embedding' }]);
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const down = await call('admin', 'GET', `/api/settings/ai/accounts/${accountId}/models?refresh=true`);
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({ models: [], error: expect.stringContaining('could not reach api.openai.com') });
    expect((await call('admin', 'GET', `/api/settings/ai/accounts/${accountId}/models?kind=other`)).status).toBe(400);
  });

  it('tests a role through the saved assignment and an account on its own, and reports ok or the error without the key', async () => {
    setAiModelForTests(createFakeAiModel([{ ok: true }]).model);
    expect((await call('admin', 'POST', '/api/settings/ai/test', { role: 'analysis' })).body).toMatchObject({ ok: true, role: 'analysis', model: 'some-model', error: null, dimension: null });
    expect((await call('admin', 'POST', '/api/settings/ai/test', {})).body).toMatchObject({ ok: true, role: 'analysis' });
    expect((await call('admin', 'POST', `/api/settings/ai/accounts/${accountId}/test`, {})).body).toMatchObject({ ok: true, model: 'some-model', role: null });
    expect((await call('admin', 'POST', '/api/settings/ai/test', { role: 'bogus' })).status).toBe(400);
    setAiModelForTests(createFakeAiModel([new Error(`rejected ${KEY}`)]).model);
    const bad = await call('admin', 'POST', '/api/settings/ai/test', { role: 'analysis' });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.text).not.toContain(KEY);
  });

  it('detects the embedding vector size when the assignment is saved, and the account of an assignment cannot be deleted', async () => {
    setEmbedderForTests(createFakeEmbedder());
    const put = await call('admin', 'PUT', '/api/settings/ai', { embeddings: { enabled: true, accountId, model: 'emb-1' } });
    expect(put.status).toBe(200);
    expect(put.body.embeddings).toEqual({ enabled: true, accountId, model: 'emb-1', dimension: 32 });
    setEmbedderForTests(null);
    expect((await call('admin', 'POST', '/api/settings/ai/test', { role: 'embeddings' })).status).toBe(200);
    const del = await call('admin', 'DELETE', `/api/settings/ai/accounts/${accountId}`);
    expect(del.status).toBe(409);
    expect(del.text).toMatch(/is used for Analysis and Embeddings/);
    await call('admin', 'PUT', '/api/settings/ai', { enabled: false, embeddings: { enabled: false, accountId: null, model: null } });
    await call('admin', 'PUT', '/api/settings/ai', { analysis: { accountId: null, model: null } });
    expect((await call('admin', 'DELETE', `/api/settings/ai/accounts/${accountId}`)).status).toBe(204);
    expect((await call('admin', 'GET', '/api/settings/ai/accounts')).body).toEqual([]);
  });
});
