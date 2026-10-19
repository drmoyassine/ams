// Scope and champion over HTTP (TASK-086): the levels need org:write to change, assigning needs framework:write, reading is open to
// those who read; assigning works on a published version; the batched context carries scope and champion with their source;
// mutations answer with an X-Undo header; the tenant boundary holds.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '@ams/core';
import { UNDO_HEADER } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
let registry: ReturnType<typeof createApp>['registry'];
const store = new MemoryStore();
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
interface Reply { status: number; body: any; headers: Headers } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, method: string, path: string, body?: unknown, inst = 'inst'): Promise<Reply> {
  const res = await app.request(path, {
    method, headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': `${ids[who]}:${ids[inst]}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const undoOf = (r: Reply) => { const h = r.headers.get(UNDO_HEADER); return h ? JSON.parse(decodeURIComponent(h)) as { label: string; method: string; path: string; body?: unknown } : null; };
const q = (code: string) => `frameworkId=${ids.fw}&code=${encodeURIComponent(code)}`;

beforeAll(async () => {
  db = await createTestDb('apiscope');
  pool = new pg.Pool({ connectionString: db.url });
  const made = createApp({ pool, store, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } });
  app = made.app;
  registry = made.registry;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  ids.other = await one(`insert into institution (name_en) values ('Other') returning id`);
  for (const n of ['admin', 'lead', 'contributor', 'viewer', 'nobody']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  ids.theirs = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'theirs', 'theirs') returning id`, [ids.other]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [ids.other, ids.theirs]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['contributor', 'contributor'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'department', 'Physics') returning id`, [ids.inst]);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BSc Physics', 'bachelor') returning id`, [ids.inst, ids.unit]);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'A', 'A', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'F', 'institution') returning id`, [ids.inst, acc]);
  ids.ver = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, '2026') returning id`, [ids.inst, ids.fw]);
  ids.r1 = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, '1', 'Standard', 'First') returning id`, [ids.inst, ids.ver]);
  await db.su.query(`insert into requirement (institution_id, framework_version_id, parent_id, code, level_label, title) values ($1, $2, $3, '1.1', 'Sub', 'First one') `, [ids.inst, ids.ver, ids.r1]);
  // Published: the framework tables are fixed from now on, and scope and champion must still be assignable.
  await db.su.query(`update framework_version set status = 'published', published_at = now() where id = $1`, [ids.ver]).catch(() => undefined);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('scope and champion API', () => {
  it('documents its routes; every one has a permission', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    for (const p of ['/api/scope-levels', '/api/scope-levels/reorder', '/api/scope-levels/{id}', '/api/scope-items', '/api/requirement-assignment', '/api/requirement-scope', '/api/requirement-champion']) expect(Object.keys(spec.paths), p).toContain(p);
    const mine = [...registry.declared].filter(([k]) => /\/api\/(scope-|requirement-(assignment|scope|champion))/.test(k));
    expect(mine.length).toBe(10);
    for (const [k, access] of mine) {
      expect(access.kind, k).toBe('permission');
      expect(['org:read', 'org:write', 'framework:read', 'framework:write'], k).toContain((access as { permission: string }).permission);
    }
    expect((await call(null, 'GET', '/api/scope-levels')).status).toBe(401);
    expect((await call('nobody', 'GET', '/api/scope-levels')).status).toBe(403);
  });

  it('lists the seeded levels and items; levels change only for those who write the organization', async () => {
    const levels = await call('viewer', 'GET', '/api/scope-levels');
    expect(levels.status).toBe(200);
    expect(levels.body.map((l: { key: string }) => l.key)).toEqual(['institution', 'unit', 'program', 'course']);
    expect(levels.body.find((l: { key: string }) => l.key === 'course')).toMatchObject({ itemCount: 0, active: true });
    expect((await call('viewer', 'POST', '/api/scope-levels', { labelEn: 'Centre' })).status).toBe(403);
    const made = await call('admin', 'POST', '/api/scope-levels', { labelEn: 'Centre', labelAr: 'مركز' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ key: 'centre', kind: 'custom', labelAr: 'مركز' });
    expect(undoOf(made)).toMatchObject({ method: 'PATCH', body: { active: false } });
    const upd = await call('admin', 'PATCH', `/api/scope-levels/${made.body.id}`, { labelEn: 'Research centre' });
    expect(upd.body.labelEn).toBe('Research centre');
    expect((await call('admin', 'PATCH', `/api/scope-levels/${made.body.id}`, { nope: 1 })).status).toBe(400);
    const order = [made.body.id, ...levels.body.map((l: { id: string }) => l.id)];
    expect((await call('admin', 'POST', '/api/scope-levels/reorder', { ids: order })).body[0].key).toBe('centre');
    const items = await call('viewer', 'GET', '/api/scope-items');
    expect(items.body.orgUnit).toEqual([{ id: ids.unit, nameEn: 'Physics', nameAr: null, detail: null }]);
    expect(items.body.program).toEqual([{ id: ids.prog, nameEn: 'BSc Physics', nameAr: null, detail: 'Physics' }]);
  });

  it('sets, reads and clears a scope; framework:write is needed; a bad level or list is refused', async () => {
    const body = { frameworkId: ids.fw, code: '1', levelKey: 'program', itemIds: [ids.prog] };
    expect((await call('contributor', 'PUT', '/api/requirement-scope', body)).status).toBe(403);
    expect((await call('viewer', 'PUT', '/api/requirement-scope', body)).status).toBe(403);
    const set = await call('lead', 'PUT', '/api/requirement-scope', body);
    expect(set.status).toBe(200);
    expect(set.body.scope).toEqual({ levelKey: 'program', itemIds: [ids.prog] });
    expect(undoOf(set)).toMatchObject({ method: 'DELETE', path: expect.stringContaining('/api/requirement-scope?') });
    expect((await call('viewer', 'GET', `/api/requirement-assignment?${q('1')}`)).body.scope.levelKey).toBe('program');
    expect((await call('lead', 'PUT', '/api/requirement-scope', { ...body, levelKey: 'nope' })).status).toBe(400);
    expect((await call('lead', 'PUT', '/api/requirement-scope', { ...body, code: '9.9' })).status).toBe(404);
    expect((await call('lead', 'PUT', '/api/requirement-scope', { ...body, levelKey: 'course', itemIds: [ids.prog] })).status).toBe(400);
    const cleared = await call('lead', 'DELETE', `/api/requirement-scope?${q('1')}`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.scope).toBeNull();
    expect(undoOf(cleared)).toMatchObject({ method: 'PUT', path: '/api/requirement-scope', body: { levelKey: 'program' } });
  });

  it('sets and clears champions, overall and per item', async () => {
    const overall = await call('lead', 'PUT', '/api/requirement-champion', { frameworkId: ids.fw, code: '1', userId: ids.admin });
    expect(overall.body.champions).toEqual([{ itemKind: null, itemId: null, userId: ids.admin, userName: 'admin' }]);
    const perItem = await call('lead', 'PUT', '/api/requirement-champion', { frameworkId: ids.fw, code: '1', userId: ids.viewer, itemKind: 'program', itemId: ids.prog });
    expect(perItem.body.champions).toHaveLength(2);
    expect((await call('contributor', 'PUT', '/api/requirement-champion', { frameworkId: ids.fw, code: '1', userId: ids.viewer })).status).toBe(403);
    expect((await call('lead', 'PUT', '/api/requirement-champion', { frameworkId: ids.fw, code: '1', userId: ids.theirs })).status).toBe(400);
    const one_ = await call('lead', 'DELETE', `/api/requirement-champion?${q('1')}&itemKind=program&itemId=${ids.prog}`);
    expect(one_.body.champions).toHaveLength(1);
    expect(undoOf(one_)).toMatchObject({ method: 'PUT', path: '/api/requirement-champion' });
    const all = await call('lead', 'DELETE', `/api/requirement-champion?${q('1')}&all=true`);
    expect(all.body.champions).toEqual([]);
  });

  it('the version\'s context carries scope and champion with where they come from', async () => {
    await call('lead', 'PUT', '/api/requirement-scope', { frameworkId: ids.fw, code: '1', levelKey: 'unit', itemIds: [] });
    await call('lead', 'PUT', '/api/requirement-champion', { frameworkId: ids.fw, code: '1', userId: ids.admin });
    const ctx = await call('viewer', 'GET', `/api/framework-versions/${ids.ver}/requirement-context`);
    expect(ctx.status).toBe(200);
    expect(ctx.body.byCode['1'].scope).toMatchObject({ own: { levelKey: 'unit' }, effective: { levels: [{ levelKey: 'unit', labelEn: 'Unit', all: true }], sources: [{ kind: 'own' }] } });
    expect(ctx.body.byCode['1.1'].scope.effective.sources).toEqual([{ kind: 'parent', code: '1' }]);
    expect(ctx.body.byCode['1.1'].champion.effective[0]).toMatchObject({ userName: 'admin', needsOne: false, sources: [{ kind: 'parent', code: '1' }] });
  });

  it('keeps another institution out', async () => {
    expect((await call('theirs', 'GET', '/api/scope-levels', undefined, 'other')).body).toHaveLength(4);
    expect((await call('theirs', 'PUT', '/api/requirement-scope', { frameworkId: ids.fw, code: '1', levelKey: 'unit' }, 'other')).status).toBe(404);
    expect((await call('theirs', 'GET', `/api/framework-versions/${ids.ver}/requirement-context`, undefined, 'other')).status).toBe(404);
  });
});
