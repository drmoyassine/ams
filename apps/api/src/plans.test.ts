// The academic calendar, cycle plans and proposed runs over HTTP (TASK-081): the calendar needs org:write to change, plans need cycle:manage,
// reading is open to those who read cycles; every route declares a permission; proposed runs are computed on request; launching a proposed
// run goes through POST /api/cycles with plan and period; mutations answer with an X-Undo header; the tenant boundary holds.
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
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

beforeAll(async () => {
  db = await createTestDb('apiplans');
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
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('academic calendar API', () => {
  it('documents its routes; every one has a permission', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    for (const p of ['/api/academic-terms', '/api/academic-terms/reorder', '/api/academic-terms/{id}', '/api/cycle-plans', '/api/cycle-plans/target', '/api/cycle-plans/{id}', '/api/cycle-plans/{id}/next-date', '/api/due-cycle-runs', '/api/cycle-plan-skips', '/api/cycle-plan-skips/{id}']) {
      expect(Object.keys(spec.paths), p).toContain(p);
    }
    const mine = [...registry.declared].filter(([k]) => /\/api\/(academic-terms|cycle-plans|cycle-plan-skips|due-cycle-runs)/.test(k));
    expect(mine.length).toBe(13);
    for (const [k, access] of mine) {
      expect(access.kind, k).toBe('permission');
      expect(['org:read', 'org:write', 'cycle:read', 'cycle:manage'], k).toContain((access as { permission: string }).permission);
    }
    expect((await call(null, 'GET', '/api/academic-terms')).status).toBe(401);
    expect((await call('nobody', 'GET', '/api/academic-terms')).status).toBe(403);
  });

  it('is changed by whoever writes the organization, read by those who read it; mutations carry Undo', async () => {
    const body = { name: 'AY2026-27', nameAr: 'العام الدراسي', kind: 'year', startDate: '2026-08-15', endDate: '2027-08-14' };
    expect((await call('viewer', 'POST', '/api/academic-terms', body)).status).toBe(403);
    expect((await call('contributor', 'POST', '/api/academic-terms', body)).status).toBe(403);
    const made = await call('admin', 'POST', '/api/academic-terms', body);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'AY2026-27', nameAr: 'العام الدراسي', kind: 'year', displayOrder: 0 });
    expect(undoOf(made)).toMatchObject({ method: 'DELETE', path: `/api/academic-terms/${made.body.id}` });
    expect((await call('admin', 'POST', '/api/academic-terms', { ...body, name: 'Other year', startDate: '2027-01-01', endDate: '2027-12-31' })).status).toBe(409);   // overlaps
    expect((await call('admin', 'POST', '/api/academic-terms', { ...body, name: 'Bad', kind: 'semester' })).status).toBe(400);
    expect((await call('viewer', 'GET', '/api/academic-terms')).body.map((t: { name: string }) => t.name)).toEqual(['AY2026-27']);
    const patched = await call('admin', 'PATCH', `/api/academic-terms/${made.body.id}`, { name: 'AY 2026-27' });
    expect(patched.body.name).toBe('AY 2026-27');
    expect(undoOf(patched)).toMatchObject({ method: 'PATCH', body: { name: 'AY2026-27' } });
    const second = await call('admin', 'POST', '/api/academic-terms', { name: 'Fall 2026', kind: 'term', startDate: '2026-08-24', endDate: '2026-12-18' });
    const re = await call('admin', 'POST', '/api/academic-terms/reorder', { ids: [second.body.id, made.body.id] });
    expect(re.body.map((t: { name: string }) => t.name)).toEqual(['Fall 2026', 'AY 2026-27']);
    const del = await call('admin', 'DELETE', `/api/academic-terms/${second.body.id}`);
    expect(del.status).toBe(204);
    expect(undoOf(del)).toMatchObject({ method: 'POST', path: '/api/academic-terms' });
  });

  it('is a separate calendar per institution', async () => {
    expect((await call('theirs', 'GET', '/api/academic-terms', undefined, 'other')).body).toEqual([]);
  });
});

describe('cycle plans API', () => {
  let tpl = '';
  let planId = '';
  const start = plusDays(-3);

  it('sets a plan only with cycle:manage, and refuses a template that does not fit', async () => {
    const t = await call('admin', 'POST', '/api/cycle-templates', { key: 'annual', name: 'Annual report', anchorKinds: ['program'], stages: [{ key: 's1', name: 'Do', startOffsetDays: 0, lengthDays: 10 }] });
    tpl = t.body.id;
    await call('admin', 'POST', `/api/cycle-templates/${tpl}/publish`);
    const input = { anchorKind: 'program', anchorId: ids.prog, templateId: tpl, recurrence: { every: 1, unit: 'month' }, firstStart: start };
    expect((await call('viewer', 'PUT', '/api/cycle-plans', input)).status).toBe(403);
    expect((await call('contributor', 'PUT', '/api/cycle-plans', input)).status).toBe(403);
    expect((await call('admin', 'PUT', '/api/cycle-plans', { ...input, anchorKind: 'org_unit', anchorId: ids.unit })).status).toBe(409);   // fits programs only
    expect((await call('admin', 'PUT', '/api/cycle-plans', { ...input, recurrence: { every: 0, unit: 'month' } })).status).toBe(400);
    const ok = await call('admin', 'PUT', '/api/cycle-plans', input);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ anchorKind: 'program', anchorName: 'BSc Physics', templateName: 'Annual report', mode: 'own', subjectCount: 1, canManage: true, nextLabel: expect.any(String) });
    expect(undoOf(ok)).toMatchObject({ method: 'DELETE', path: `/api/cycle-plans/${ok.body.id}` });
    planId = ok.body.id;
  });

  it('is read by everyone who reads cycles, with the plans in the Plans list and on the target', async () => {
    const list = await call('viewer', 'GET', '/api/cycle-plans');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: planId, canManage: false });
    const target = await call('viewer', 'GET', `/api/cycle-plans/target?anchorKind=program&anchorId=${ids.prog}`);
    expect(target.body.own.map((p: { id: string }) => p.id)).toEqual([planId]);
    expect((await call('nobody', 'GET', '/api/cycle-plans')).status).toBe(403);
    expect((await call('theirs', 'GET', '/api/cycle-plans', undefined, 'other')).body).toEqual([]);
  });

  it('proposes the run, which is launched through POST /api/cycles with the plan and period; then it is no longer proposed', async () => {
    const due = await call('viewer', 'GET', '/api/due-cycle-runs?horizonDays=5');
    expect(due.status).toBe(200);
    const run = due.body.runs.find((r: { planId: string }) => r.planId === planId);
    expect(run).toMatchObject({ anchorKind: 'program', anchorId: ids.prog, periodStart: start, state: 'due', templateName: 'Annual report', canLaunch: false });
    const launched = await call('admin', 'POST', '/api/cycles', {
      templateId: run.templateId, anchorKind: run.anchorKind, anchorId: run.anchorId, startDate: run.periodStart, periodLabel: run.periodLabel, planId: run.planId, periodStart: run.periodStart,
    });
    expect(launched.status).toBe(201);
    expect(launched.body).toMatchObject({ planId, periodStart: start, periodLabel: run.periodLabel });
    expect((await call('admin', 'GET', '/api/due-cycle-runs?horizonDays=5')).body.runs.find((r: { planId: string; periodStart: string }) => r.planId === planId && r.periodStart === start)).toBeUndefined();
    expect((await call('admin', 'POST', '/api/cycles', {
      templateId: run.templateId, anchorKind: run.anchorKind, anchorId: run.anchorId, startDate: run.periodStart, planId: run.planId, periodStart: run.periodStart,
    })).status).toBe(409);
    expect((await call('admin', 'DELETE', `/api/cycle-plans/${planId}`)).status).toBe(409);   // it has made a cycle
  });

  it('skips a period with a reason, undoably, and refuses a skip without permission or reason', async () => {
    const next = (await call('admin', 'GET', '/api/due-cycle-runs?horizonDays=70')).body.runs.find((r: { planId: string }) => r.planId === planId);
    expect(next).toBeDefined();
    const skip = { planId, periodStart: next.periodStart, reason: 'Reviewed at the quarterly meeting instead' };
    expect((await call('viewer', 'POST', '/api/cycle-plan-skips', skip)).status).toBe(403);
    expect((await call('admin', 'POST', '/api/cycle-plan-skips', { ...skip, reason: '' })).status).toBe(400);
    const done = await call('admin', 'POST', '/api/cycle-plan-skips', skip);
    expect(done.status).toBe(200);
    const undo = undoOf(done);
    expect(undo).toMatchObject({ method: 'DELETE' });
    expect((await call('admin', 'GET', '/api/due-cycle-runs?horizonDays=70')).body.runs.some((r: { periodStart: string }) => r.periodStart === next.periodStart)).toBe(false);
    expect((await call('admin', 'DELETE', undo!.path)).status).toBe(204);
    expect((await call('admin', 'GET', '/api/due-cycle-runs?horizonDays=70')).body.runs.some((r: { periodStart: string }) => r.periodStart === next.periodStart)).toBe(true);
  });

  it('records the date a decision fixes, and opts out of a plan', async () => {
    const dec = await call('admin', 'PUT', '/api/cycle-plans', { anchorKind: 'org_unit', anchorId: ids.unit, templateId: tpl, recurrence: { after: 'previous_ends', setBy: 'decision' }, firstStart: start });
    expect(dec.status).toBe(409);   // the template fits programs only
    const t2 = await call('admin', 'POST', '/api/cycle-templates', { key: 'any', name: 'Anything', stages: [{ key: 's1', name: 'Do' }] });
    await call('admin', 'POST', `/api/cycle-templates/${t2.body.id}/publish`);
    const p2 = await call('admin', 'PUT', '/api/cycle-plans', { anchorKind: 'org_unit', anchorId: ids.unit, templateId: t2.body.id, recurrence: { after: 'previous_ends', setBy: 'decision' }, firstStart: start });
    expect(p2.status).toBe(200);
    expect((await call('viewer', 'POST', `/api/cycle-plans/${p2.body.id}/next-date`, { date: plusDays(400) })).status).toBe(403);
    expect((await call('admin', 'POST', `/api/cycle-plans/${p2.body.id}/next-date`, { date: start })).status).toBe(400);
    const set = await call('admin', 'POST', `/api/cycle-plans/${p2.body.id}/next-date`, { date: plusDays(400) });
    expect(set.body.recurrence).toEqual({ after: 'previous_ends', setBy: 'decision', dates: [plusDays(400)] });
    const out = await call('admin', 'PUT', '/api/cycle-plans', { anchorKind: 'org_unit', anchorId: ids.unit, templateId: t2.body.id, mode: 'opt_out' });
    expect(out.body).toMatchObject({ mode: 'opt_out', recurrence: null, nextDue: null });
    expect((await call('admin', 'DELETE', `/api/cycle-plans/${p2.body.id}`)).status).toBe(204);
  });
});
