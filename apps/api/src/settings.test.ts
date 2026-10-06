import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

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
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeAll(async () => {
  db = await createTestDb('apiset');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  ids.col = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BS Mechanical', 'bachelor') returning id`, [ids.inst, ids.col]);
  const grant = (u: string, role: string, scope: string, id: string) => db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, ids[u], role, scope, id]);
  await grant('admin', 'admin', 'institution', ids.inst!);
  await grant('lead', 'lead', 'org_unit', ids.col!);
  await grant('viewer', 'viewer', 'institution', ids.inst!);
}, 30000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('settings API', () => {
  it('documents the routes and needs authentication', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    for (const p of ['/api/institution', '/api/org-units', '/api/org-units/{id}', '/api/programs/{id}']) expect(Object.keys(spec.paths), p).toContain(p);
    expect((await call(null, 'GET', '/api/institution')).status).toBe(401);
  });

  it('shows the institution to everyone and lets only an admin change it, refusing unreadable colours', async () => {
    expect((await call('viewer', 'GET', '/api/institution')).body).toMatchObject({ nameEn: 'Gulf University', accentColor: null });
    expect((await call('lead', 'PATCH', '/api/institution', { nameEn: 'x' })).status).toBe(403);
    expect((await call('admin', 'PATCH', '/api/institution', { accentColor: '#ffee00' })).status).toBe(400);
    const ok = await call('admin', 'PATCH', '/api/institution', { nameAr: 'جامعة الخليج', accentColor: '#1F4E79' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ nameAr: 'جامعة الخليج', accentColor: '#1f4e79' });
  });

  it('builds the org chart within each person\'s scope', async () => {
    const dept = await call('lead', 'POST', '/api/org-units', { parentId: ids.col, type: 'department', nameEn: 'Mechanical Dept' });
    expect(dept.status).toBe(201);
    expect((await call('lead', 'POST', '/api/org-units', { parentId: null, type: 'college', nameEn: 'x' })).status).toBe(403);
    expect((await call('viewer', 'POST', '/api/org-units', { parentId: ids.col, type: 'department', nameEn: 'x' })).status).toBe(403);
    expect((await call('admin', 'PATCH', `/api/org-units/${ids.col}`, { parentId: dept.body.id })).status).toBe(400); // cycle
    expect((await call('admin', 'PATCH', `/api/org-units/${ids.col}`, { active: false })).status).toBe(409); // active children
    const list = await call('viewer', 'GET', '/api/org-units');
    expect(list.body.map((u: { nameEn: string }) => u.nameEn)).toEqual(['Engineering', 'Mechanical Dept']);
  });

  it('edits a program', async () => {
    const out = await call('lead', 'PATCH', `/api/programs/${ids.prog}`, { nameAr: 'بكالوريوس الهندسة الميكانيكية', tags: ['mechanical', 'engineering'] });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ nameAr: 'بكالوريوس الهندسة الميكانيكية', tags: ['mechanical', 'engineering'] });
    expect((await call('viewer', 'PATCH', `/api/programs/${ids.prog}`, { nameEn: 'x' })).status).toBe(403);
    expect((await call('lead', 'PATCH', `/api/programs/${ids.prog}`, { degreeLevel: 'astronaut' })).status).toBe(400);
  });
});
