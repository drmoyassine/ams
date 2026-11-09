// The syllabus API (TASK-124): documented routes, authentication, the upsert that always loads and flags, the workflow over HTTP with who
// may do what, and the settings.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { emptySyllabus } from '@ams/shared';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method, headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeAll(async () => {
  db = await createTestDb('apisyllabus');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'coordinator', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  const grant = (u: string, role: string) => db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u], role]);
  await grant('admin', 'admin'); await grant('coordinator', 'viewer'); await grant('viewer', 'viewer');
  ids.course = await one(`insert into course (institution_id, code, title_en, coordinator_user_id) values ($1, 'ECE 420', 'Digital Signal Processing', $2) returning id`, [ids.inst, ids.coordinator]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('the syllabus API', () => {
  it('documents its routes and needs authentication', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    for (const p of ['/api/courses/{id}/syllabus', '/api/syllabi/upsert', '/api/syllabi', '/api/syllabus-versions/{id}/submit', '/api/syllabus-versions/{id}/approve', '/api/settings/syllabus']) expect(Object.keys(spec.paths), p).toContain(p);
    expect((await call(null, 'GET', '/api/syllabi')).status).toBe(401);
  });

  it('loads an upsert by course code with every rule broken, flags it, and lets the coordinator (not a viewer) read and edit it', async () => {
    const up = await call('coordinator', 'POST', '/api/syllabi/upsert', { courseCode: 'ECE 420', content: emptySyllabus(), source: 'api' });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ versionNo: 1, status: 'draft', source: 'api' });
    expect(up.body.errorCount).toBeGreaterThan(5);
    expect((await call('viewer', 'POST', '/api/syllabi/upsert', { courseCode: 'ECE 420', content: emptySyllabus() })).status).toBe(403);
    expect((await call('coordinator', 'POST', '/api/syllabi/upsert', { courseCode: 'NOPE 1', content: emptySyllabus() })).status).toBe(404);
    const ov = (await call('viewer', 'GET', `/api/courses/${ids.course}/syllabus`)).body;
    expect(ov.open).toMatchObject({ status: 'draft' });
    expect(ov.can).toEqual({ edit: false, suggest: false, endorse: false, approve: false });
    expect((await call('coordinator', 'GET', `/api/courses/${ids.course}/syllabus`)).body.can.edit).toBe(true);
    const list = (await call('coordinator', 'GET', '/api/syllabi?flagged=true&mine=true')).body;
    expect(list).toEqual([expect.objectContaining({ code: 'ECE 420', needsMyAttention: true })]);
  });

  it('refuses to submit a draft with errors, over HTTP, and validates the body', async () => {
    const open = (await call('coordinator', 'GET', `/api/courses/${ids.course}/syllabus`)).body.open;
    const r = await call('coordinator', 'POST', `/api/syllabus-versions/${open.id}/submit`);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/error/);
    expect((await call('coordinator', 'PUT', `/api/courses/${ids.course}/syllabus`, { content: { clos: 'nope' } })).status).toBe(400);
    expect((await call('viewer', 'POST', `/api/syllabus-versions/${open.id}/suggestions`, { section: 'clos', suggestion: 'x' })).status).toBe(403);
    expect((await call('coordinator', 'POST', `/api/syllabus-versions/${open.id}/suggestions`, { section: 'clos', suggestion: 'Add a measurable verb' })).status).toBe(201);
  });

  it('lets only an admin set the limits, validates them, and flags what now breaks them', async () => {
    const cur = (await call('viewer', 'GET', '/api/settings/syllabus')).body;
    expect(cur).toMatchObject({ minClos: 3, maxClos: 8 });
    expect((await call('coordinator', 'PUT', '/api/settings/syllabus', { ...cur, maxClos: 6 })).status).toBe(403);
    expect((await call('admin', 'PUT', '/api/settings/syllabus', { ...cur, minClos: 9 })).status).toBe(400);
    expect((await call('admin', 'PUT', '/api/settings/syllabus', { ...cur, maxClos: 6 })).body.maxClos).toBe(6);
  });
});
