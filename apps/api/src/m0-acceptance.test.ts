// M0 acceptance (PRD 18.4, ROADMAP-001 "done when"). Do not weaken these: they are the milestone gate.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';
import { secured } from './chain.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;

async function one(sql: string, params: unknown[] = []) {
  return (await db.su.query(sql, params)).rows[0].id as string;
}
const call = (user: string, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-test-user': `${user}:${ids.inst}` } });

beforeAll(async () => {
  db = await createTestDb('m0');
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
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Eng') returning id`, [ids.inst]);
  const program = (n: string) => one(
    `insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, $3, 'bachelor') returning id`, [ids.inst, ids.unit, n]);
  ids.progA = await program('Program A');
  ids.progB = await program('Program B');
  const user = (e: string) => one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, e]);
  ids.contrib = await user('contributor@x.org');
  ids.admin = await user('admin@x.org');
  const assign = (u: string, role: string, scope: string, sid: string) => db.su.query(
    `insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, u, role, scope, sid]);
  await assign(ids.contrib!, 'contributor', 'program', ids.progA!);
  await assign(ids.admin!, 'admin', 'institution', ids.inst!);
});
afterAll(async () => { await pool.end(); await db.close(); });

describe('M0 done-when', () => {
  it('1. a contributor scoped to program A cannot read program B (API and SQL with session settings)', async () => {
    const viaApi = await (await call(ids.contrib!, '/api/programs')).json() as { id: string }[];
    expect(viaApi.map((p) => p.id)).toEqual([ids.progA]);

    const viaSql = await db.as({ userId: ids.contrib, institutionId: ids.inst }, async (c) =>
      (await c.query(`select id from program`)).rows.map((r) => r.id));
    expect(viaSql).toEqual([ids.progA]);
    const direct = await db.as({ userId: ids.contrib, institutionId: ids.inst }, async (c) =>
      (await c.query(`select id from program where id = $1`, [ids.progB])).rowCount);
    expect(direct).toBe(0);
  });

  it('2. registering a route without requires(...) fails startup and CI', () => {
    const unauth = async () => null;
    expect(() => createApp({
      pool, authenticate: unauth,
      extend: (_a, registry, deps) => { secured(registry, deps, { method: 'get', path: '/api/x', responses: {} } as never); },
    })).toThrow(/no requires/);
    expect(() => createApp({
      pool, authenticate: unauth,
      extend: (a) => { a.get('/api/y', (c) => c.json({})); },
    })).toThrow(/without a requires/);
  });

  it('3. a write through the API produces an audit_event carrying the caller id', async () => {
    const res = await call(ids.admin!, '/api/programs', {
      method: 'POST', body: JSON.stringify({ orgUnitId: ids.unit, nameEn: 'Program C', degreeLevel: 'master' }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json() as { id: string };
    const { rows } = await db.su.query(`select actor_id, action, target_type from audit_event where target_id = $1`, [id]);
    expect(rows).toEqual([{ actor_id: ids.admin, action: 'insert', target_type: 'program' }]);
  });
});
