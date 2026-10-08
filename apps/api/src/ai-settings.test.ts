import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeAiModel, setAiModelForTests } from '@ams/core';
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

describe('AI settings API', () => {
  it('is documented, needs a sign-in, and is for the admin only', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/settings/ai', '/api/settings/ai/test']));
    for (const [m, p] of [['GET', '/api/settings/ai'], ['PUT', '/api/settings/ai'], ['POST', '/api/settings/ai/test']] as const) {
      expect((await call(null, m, p, m === 'PUT' ? {} : undefined)).status, `${m} ${p}`).toBe(401);
      expect((await call('lead', m, p, m === 'PUT' ? {} : undefined)).status, `${m} ${p}`).toBe(403);
    }
  });

  it('saves the settings and never returns the key', async () => {
    const put = await call('admin', 'PUT', '/api/settings/ai', { model: 'some-model', apiKey: KEY, maxTokensPerRun: 100000, enabled: true });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ model: 'some-model', keyConfigured: true, keyLast4: 'wxyz', enabled: true, maxTokensPerRun: 100000 });
    const got = await call('admin', 'GET', '/api/settings/ai');
    expect(got.text).not.toContain(KEY);
    expect(got.body.apiKey).toBeUndefined();
    expect((await db.su.query(`select api_key_enc from ai_setting`)).rows[0].api_key_enc).not.toContain(KEY);
  });

  it('refuses unknown fields and unreasonable values', async () => {
    expect((await call('admin', 'PUT', '/api/settings/ai', { apiKey: 'short' })).status).toBe(400);
    expect((await call('admin', 'PUT', '/api/settings/ai', { maxTokensPerRun: -5 })).status).toBe(400);
    expect((await call('admin', 'PUT', '/api/settings/ai', { surprise: true })).status).toBe(400);
    expect((await call('admin', 'PUT', '/api/settings/ai', { maxCostUsdPerRun: 2 })).status).toBe(400); // needs prices
  });

  it('tests the connection through the model and reports ok or the error', async () => {
    setAiModelForTests(createFakeAiModel([{ ok: true }]).model);
    expect((await call('admin', 'POST', '/api/settings/ai/test')).body).toMatchObject({ ok: true, model: 'some-model', error: null, embeddings: null });
    setAiModelForTests(createFakeAiModel([new Error(`rejected ${KEY}`)]).model);
    const bad = await call('admin', 'POST', '/api/settings/ai/test');
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.text).not.toContain(KEY);
  });
});
