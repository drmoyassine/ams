// The batch move (drag and drop) through the five-step chain: permissions, the refusals as HTTP errors, atomicity, and the
// X-Undo header putting several moved items back in one call.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { MemoryStore } from '@ams/core';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
interface Out { status: number; body: any; undo: { label: string; method: string; path: string; body?: unknown } | null } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, method: string, path: string, body?: unknown): Promise<Out> {
  const res = await app.request(path, {
    method,
    headers: { ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const header = res.headers.get('x-undo');
  return { status: res.status, body: text ? JSON.parse(text) : null, undo: header ? JSON.parse(decodeURIComponent(header)) : null };
}

let n = 0;
/** S1 (S1.1, S1.2) · S2 · S3 */
async function draft() {
  n += 1;
  const v = (await call('lead', 'POST', `/api/frameworks/${ids.fw}/versions`, { edition: `m${n}` })).body.id as string;
  const post = async (code: string, order: number, parentId?: string) =>
    (await call('lead', 'POST', `/api/framework-versions/${v}/requirements`, { code, levelLabel: 'Standard', title: `T ${code}`, displayOrder: order, ...(parentId ? { parentId } : {}) })).body.id as string;
  const s1 = await post('S1', 0);
  const s11 = await post('S1.1', 0, s1);
  const s12 = await post('S1.2', 1, s1);
  const s2 = await post('S2', 1);
  const s3 = await post('S3', 2);
  return { v, s1, s11, s12, s2, s3 };
}
const shape = async (v: string) => {
  const rows = (await call('lead', 'GET', `/api/framework-versions/${v}/requirements`)).body as { id: string; code: string; parentId: string | null; displayOrder: number }[];
  const kids = (p: string | null) => rows.filter((r) => r.parentId === p);
  const fmt = (p: string | null): string => kids(p).map((r) => (kids(r.id).length ? `${r.code}(${fmt(r.id)})` : r.code)).join(p === null ? ' ' : ',');
  return fmt(null);
};

beforeAll(async () => {
  db = await createTestDb('apimovemany');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store: new MemoryStore(), queue: { send: async () => undefined },
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [name, role] of [['lead', 'lead'], ['admin', 'admin'], ['viewer', 'viewer']] as const) {
    ids[name] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, name]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[name], role]);
  }
  const acc = (await call('lead', 'POST', '/api/accreditors', { name: 'Invented Council', shortName: 'IC', type: 'institutional' })).body.id;
  ids.fw = (await call('lead', 'POST', '/api/frameworks', { accreditorId: acc, name: 'Handbook', scope: 'institution' })).body.id;
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('POST /api/framework-versions/{id}/requirements/move-many', () => {
  it('is documented, needs a sign-in and framework:write', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toContain('/api/framework-versions/{id}/requirements/move-many');
    const x = await draft();
    const body = { moves: [{ id: x.s3, parentId: x.s1, index: 0 }] };
    expect((await call(null, 'POST', `/api/framework-versions/${x.v}/requirements/move-many`, body)).status).toBe(401);
    expect((await call('viewer', 'POST', `/api/framework-versions/${x.v}/requirements/move-many`, body)).status).toBe(403);
    expect(await shape(x.v)).toBe('S1(S1.1,S1.2) S2 S3');
  });

  it('moves several in one request and X-Undo puts all of them back in one call', async () => {
    const x = await draft();
    const r = await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/move-many`, { moves: [{ id: x.s11, parentId: x.s3, index: 0 }, { id: x.s2, parentId: x.s3, index: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ moved: 2, unchanged: false });
    expect(r.undo).toMatchObject({ label: 'Moved S1.1, S2 under S3', method: 'POST', path: `/api/framework-versions/${x.v}/requirements/move-many` });
    expect(await shape(x.v)).toBe('S1(S1.2) S3(S1.1,S2)');
    const back = await call('lead', 'POST', r.undo!.path, r.undo!.body);
    expect(back.status).toBe(200);
    expect(await shape(x.v)).toBe('S1(S1.1,S1.2) S2 S3');
  });

  it('refuses a move under itself with 409 and its message, and applies nothing', async () => {
    const x = await draft();
    const r = await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/move-many`, { moves: [{ id: x.s3, parentId: x.s2, index: 0 }, { id: x.s1, parentId: x.s11, index: 0 }] });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/itself or one of its own sub-items/);
    expect(r.undo).toBeNull();
    expect(await shape(x.v)).toBe('S1(S1.1,S1.2) S2 S3');
  });

  it('refuses bad input (400) and a published version (409)', async () => {
    const x = await draft();
    expect((await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/move-many`, { moves: [] })).status).toBe(400);
    expect((await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/move-many`, { moves: [{ id: 'nope', parentId: null, index: 0 }] })).status).toBe(400);
    expect((await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/move-many`, {})).status).toBe(400);
    // another version's items are not this version's
    const y = await draft();
    expect((await call('lead', 'POST', `/api/framework-versions/${x.v}/requirements/move-many`, { moves: [{ id: y.s1, parentId: null, index: 0 }] })).status).toBe(400);
    // a published version (the institution's own framework publishes in one step)
    const q = (await call('lead', 'POST', '/api/quality-framework', { template: true })).body.versions[0].id as string;
    const rows = (await call('lead', 'GET', `/api/framework-versions/${q}/requirements`)).body as { id: string }[];
    expect((await call('admin', 'POST', `/api/framework-versions/${q}/publish-quality`)).body.status).toBe('published');
    const r = await call('lead', 'POST', `/api/framework-versions/${q}/requirements/move-many`, { moves: [{ id: rows[0]!.id, parentId: rows[1]!.id, index: 0 }] });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/immutable/);
  });
});
