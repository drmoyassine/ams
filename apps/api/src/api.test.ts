import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []) {
  return (await db.su.query(sql, params)).rows[0].id as string;
}
const call = (user: string | null, path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': `${user}:${ids.inst}` } : {}) },
  });

beforeAll(async () => {
  db = await createTestDb('api');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool,
    authenticate: async (req) => {
      const h = req.headers.get('x-test-user');
      if (!h) return null;
      const [userId, institutionId] = h.split(':');
      return { userId: userId!, institutionId: institutionId! };
    },
  }).app;

  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  ids.college = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Eng') returning id`, [ids.inst]);
  ids.progA = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'Prog A', 'bachelor') returning id`, [ids.inst, ids.college]);
  ids.progB = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'Prog B', 'bachelor') returning id`, [ids.inst, ids.college]);
  const user = (e: string) => one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, e]);
  ids.contribA = await user('a@x.org');
  ids.admin = await user('admin@x.org');
  const assign = (u: string, role: string, scope: string, sid: string) => db.su.query(
    `insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, u, role, scope, sid]);
  await assign(ids.contribA, 'contributor', 'program', ids.progA);
  await assign(ids.admin, 'admin', 'institution', ids.inst);
});
afterAll(async () => { await pool.end(); await db.close(); });

describe('API', () => {
  it('serves health and the OpenAPI spec without authentication', async () => {
    expect((await call(null, '/healthz')).status).toBe(200);
    const spec = await (await call(null, '/openapi.json')).json() as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toContain('/api/programs');
  });

  it('rejects unauthenticated requests', async () => {
    expect((await call(null, '/api/programs')).status).toBe(401);
  });

  it('a contributor scoped to program A cannot read program B through the API', async () => {
    const res = await call(ids.contribA!, '/api/programs');
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string }[];
    expect(body.map((p) => p.id)).toEqual([ids.progA]);
  });

  it('an admin sees both programs', async () => {
    const body = await (await call(ids.admin!, '/api/programs')).json() as unknown[];
    expect(body).toHaveLength(2);
  });

  it('a contributor cannot create programs', async () => {
    const res = await call(ids.contribA!, '/api/programs', {
      method: 'POST', body: JSON.stringify({ orgUnitId: ids.college, nameEn: 'X', degreeLevel: 'master' }),
    });
    expect(res.status).toBe(403);
  });

  it('a write through the API produces an audit_event carrying the caller id', async () => {
    const res = await call(ids.admin!, '/api/programs', {
      method: 'POST', body: JSON.stringify({ orgUnitId: ids.college, nameEn: 'New Prog', degreeLevel: 'master', tags: ['computing'] }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string };
    const { rows } = await db.su.query(
      `select actor_id, actor_type, action, target_type, institution_id, after from audit_event where target_id = $1`, [created.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: ids.admin, actor_type: 'user', action: 'insert', target_type: 'program', institution_id: ids.inst });
    expect(rows[0].after.name_en).toBe('New Prog');
    const { rows: [p] } = await db.su.query(`select created_by from program where id = $1`, [created.id]);
    expect(p.created_by).toBe(ids.admin);
  });

  it('validates input with a 400 and writes nothing', async () => {
    const before = (await db.su.query(`select count(*)::int n from audit_event`)).rows[0].n;
    const res = await call(ids.admin!, '/api/programs', {
      method: 'POST', body: JSON.stringify({ orgUnitId: 'not-a-uuid', nameEn: '', degreeLevel: 'phd' }),
    });
    expect(res.status).toBe(400);
    expect((await db.su.query(`select count(*)::int n from audit_event`)).rows[0].n).toBe(before);
  });
});
