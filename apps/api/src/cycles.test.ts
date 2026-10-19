// Cycles over HTTP (TASK-078): every route needs a permission, a viewer who owns a stage can work it, only the named approver can
// decide, files go up as the request body and come back, mutations answer with an X-Undo header, a draft is deleted to the Trash.
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
const as = (who: string) => ({ 'x-test-user': `${ids[who]}:${ids.inst}` });
interface Reply { status: number; body: any; headers: Headers } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await app.request(path, {
    method, headers: { 'content-type': 'application/json', ...(who ? as(who) : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const undoOf = (r: Reply) => { const h = r.headers.get(UNDO_HEADER); return h ? JSON.parse(decodeURIComponent(h)) as { label: string; method: string; path: string; body?: unknown } : null; };
const stage = (c: any, key: string) => c.stages.find((s: any) => s.key === key); // eslint-disable-line @typescript-eslint/no-explicit-any

const TEMPLATE = {
  key: 'unit_review', name: 'Unit review', anchorKinds: ['org_unit'],
  stages: [
    { key: 'prepare', name: 'Prepare', unit: { kind: 'subject' }, owner: { kind: 'head_of_unit' }, startOffsetDays: 0, lengthDays: 10,
      outputs: [{ key: 'brief', name: 'Brief', kind: 'document', required: true }, { key: 'note', name: 'Note', kind: 'note', required: false }] },
    { key: 'sign', name: 'Sign-off', unit: { kind: 'subject' }, owner: { kind: 'cycle_lead' }, startOffsetDays: 10, lengthDays: 5,
      outputs: [{ key: 'ok', name: 'Sign-off', kind: 'approval', required: true, approver: { kind: 'head_of_unit' } }],
      inputs: [{ key: 'brief', name: 'Brief', from: { stage: 'prepare', output: 'brief' } }] },
  ],
};

beforeAll(async () => {
  db = await createTestDb('apicycles');
  pool = new pg.Pool({ connectionString: db.url });
  const made = createApp({ pool, store, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } });
  app = made.app;
  registry = made.registry;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead', 'contributor', 'viewer', 'head', 'nobody']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['contributor', 'contributor'], ['viewer', 'viewer'], ['head', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en, head_user_id) values ($1, 'department', 'Physics', $2) returning id`, [ids.inst, ids.head]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('cycles API', () => {
  it('documents its routes and gives each a permission', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    for (const p of ['/api/cycle-templates', '/api/cycle-templates/{id}/publish', '/api/cycles', '/api/cycles/{id}/activate', '/api/cycle-stages/{id}/complete', '/api/cycle-outputs/{id}/decision', '/api/cycle-outputs/{id}/file', '/api/my-cycle-work', '/api/cycle-inputs/{id}/pick']) {
      expect(Object.keys(spec.paths), p).toContain(p);
    }
    const mine = [...registry.declared].filter(([k]) => /\/api\/(cycles|cycle-|my-cycle-work)/.test(k));
    expect(mine.length).toBeGreaterThanOrEqual(35);
    for (const [k, access] of mine) {
      expect(access.kind, k).toBe('permission');
      expect(['cycle:read', 'cycle:manage'], k).toContain((access as { permission: string }).permission);
    }
    expect((await call(null, 'GET', '/api/cycles')).status).toBe(401);
    expect((await call('nobody', 'GET', '/api/cycles')).status).toBe(403);
    expect((await call('nobody', 'GET', '/api/my-cycle-work')).status).toBe(403);
  });

  it('lets only cycle:manage create templates and launch; everyone with read may look', async () => {
    for (const who of ['viewer', 'contributor']) {
      expect((await call(who, 'POST', '/api/cycle-templates', TEMPLATE)).status, who).toBe(403);
      expect((await call(who, 'POST', '/api/cycles', { anchorKind: 'org_unit', anchorId: ids.unit, startDate: '2026-09-01' })).status, who).toBe(403);
    }
    const made = await call('lead', 'POST', '/api/cycle-templates', TEMPLATE);
    expect(made.status).toBe(201);
    ids.tpl = made.body.id;
    expect(undoOf(made)).toMatchObject({ method: 'DELETE', path: `/api/cycle-templates/${ids.tpl}` });
    expect((await call('lead', 'POST', '/api/cycle-templates', TEMPLATE)).status).toBe(409);
    expect((await call('lead', 'POST', '/api/cycle-templates', { ...TEMPLATE, key: 'Bad Key' })).status).toBe(400);
    expect((await call('viewer', 'GET', '/api/cycle-templates')).body.map((t: { key: string }) => t.key)).toEqual(['unit_review']);
    expect((await call('viewer', 'GET', `/api/cycle-templates/${ids.tpl}`)).status).toBe(200);
    expect((await call('viewer', 'POST', `/api/cycle-templates/${ids.tpl}/publish`)).status).toBe(403);
    const checked = await call('viewer', 'POST', '/api/cycle-templates/validate', { stages: [{ key: 'a', name: 'a', inputs: [{ key: 'i', name: 'i', from: { stage: 'zz', output: 'o' } }] }] });
    expect(checked.body).toMatchObject({ ok: false, issues: [{ message: expect.stringContaining('no stage "zz"') }] });
    expect((await call('lead', 'POST', `/api/cycle-templates/${ids.tpl}/publish`)).body).toMatchObject({ status: 'published', version: 1 });
    expect((await call('lead', 'POST', `/api/cycle-templates/${ids.tpl}/retire`)).body.status).toBe('retired');
    expect((await call('lead', 'POST', `/api/cycle-templates/${ids.tpl}/reinstate`)).body.status).toBe('published');
  });

  it('launches a draft, resolves the owners, validates the body, and the viewer reads it', async () => {
    expect((await call('lead', 'POST', '/api/cycles', { anchorKind: 'org_unit', anchorId: ids.unit })).status).toBe(400);   // no start date
    expect((await call('lead', 'POST', '/api/cycles', { anchorKind: 'org_unit', anchorId: ids.unit, startDate: '2026-09-01', subjectKind: 'program' })).status).toBe(400);
    const r = await call('lead', 'POST', '/api/cycles', { templateId: ids.tpl, anchorKind: 'org_unit', anchorId: ids.unit, startDate: '2026-09-01', leadUserId: ids.lead, periodLabel: 'AY2026-27' });
    expect(r.status).toBe(201);
    ids.cycle = r.body.id;
    expect(undoOf(r)).toMatchObject({ method: 'DELETE', path: `/api/cycles/${ids.cycle}` });
    expect(r.body).toMatchObject({ status: 'draft', responsibleUnitName: 'Physics', anchorName: 'Physics', stageCount: 2, canManage: true });
    expect(stage(r.body, 'prepare')).toMatchObject({ ownerName: 'head', ownerUnresolved: false, startDate: '2026-09-01', endDate: '2026-09-11' });
    const seen = await call('viewer', 'GET', `/api/cycles/${ids.cycle}`);
    expect(seen.body).toMatchObject({ canManage: false });
    expect(stage(seen.body, 'prepare').canWork).toBe(false);
    expect((await call('viewer', 'GET', `/api/cycle-stages/${stage(r.body, 'sign').id}/inputs`)).body[0]).toMatchObject({ source: 'stage_output', outputName: 'Brief', satisfied: false });
    const list = await call('viewer', 'GET', `/api/cycles?anchorKind=org_unit&anchorId=${ids.unit}&status=draft`);
    expect(list.body.map((c: { id: string }) => c.id)).toEqual([ids.cycle]);
    expect((await call('viewer', 'GET', '/api/cycles?status=bogus')).status).toBe(400);
    expect((await call('viewer', 'PATCH', `/api/cycles/${ids.cycle}`, { title: 'x' })).status).toBe(403);
    expect((await call('lead', 'POST', `/api/cycle-stages/${stage(r.body, 'prepare').id}/start`)).status).toBe(409);   // launch it first
  });

  it('lets the stage owner (a viewer) work their stage and a contributor any, and files go up as the body', async () => {
    const act = await call('lead', 'POST', `/api/cycles/${ids.cycle}/activate`);
    expect(act.body.status).toBe('active');
    expect(undoOf(act)).toMatchObject({ method: 'POST', path: `/api/cycles/${ids.cycle}/revert-to-draft` });
    const prepare = stage(act.body, 'prepare');
    expect((await call('nobody', 'POST', `/api/cycle-stages/${prepare.id}/start`)).status).toBe(403);
    expect((await call('viewer', 'POST', `/api/cycle-stages/${prepare.id}/start`)).status).toBe(403);
    const started = await call('head', 'POST', `/api/cycle-stages/${prepare.id}/start`);
    expect(started.status).toBe(200);
    expect(undoOf(started)).toMatchObject({ method: 'POST', path: `/api/cycle-stages/${prepare.id}/reset` });
    expect(stage(started.body, 'prepare')).toMatchObject({ status: 'in_progress', canWork: true });
    const brief = stage(started.body, 'prepare').outputs.find((o: { key: string }) => o.key === 'brief');
    expect((await call('head', 'POST', `/api/cycle-stages/${prepare.id}/complete`)).body.message).toMatch(/Brief/);
    const pdf = new TextEncoder().encode('%PDF-1.4 brief');
    const up = await app.request(`/api/cycle-outputs/${brief.id}/file?fileName=${encodeURIComponent('ملخص.pdf')}`, { method: 'PUT', headers: { ...as('head'), 'content-type': 'application/pdf' }, body: pdf });
    expect(up.status).toBe(200);
    const upBody = await up.json() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(stage(upBody, 'prepare').outputs[0]).toMatchObject({ state: 'draft', file: { name: 'ملخص.pdf', mime: 'application/pdf', size: pdf.byteLength } });
    expect(JSON.parse(decodeURIComponent(up.headers.get(UNDO_HEADER)!))).toMatchObject({ method: 'DELETE', path: `/api/cycle-outputs/${brief.id}/file` });
    const down = await app.request(`/api/cycle-outputs/${brief.id}/file`, { headers: as('viewer') });
    expect(down.status).toBe(200);
    expect(down.headers.get('content-type')).toBe('application/pdf');
    expect(down.headers.get('content-disposition')).toMatch(/^inline; filename\*=UTF-8''/);
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(pdf);
    expect((await app.request(`/api/cycle-outputs/${brief.id}/file?fileName=x.pdf`, { method: 'PUT', headers: { ...as('viewer') }, body: pdf })).status).toBe(403);
    // A contributor holds cycle:work and may finish the stage on the owner's behalf.
    expect((await call('contributor', 'POST', `/api/cycle-outputs/${brief.id}/finalize`)).status).toBe(200);
    const done = await call('head', 'POST', `/api/cycle-stages/${prepare.id}/complete`);
    expect(stage(done.body, 'prepare').status).toBe('completed');
    expect(stage(done.body, 'sign').inputs[0]).toMatchObject({ satisfied: true });
    expect((await call('viewer', 'GET', '/api/my-cycle-work')).status).toBe(200);
  });

  it('lets only the named approver decide, and shows it in my work', async () => {
    const detail = (await call('lead', 'GET', `/api/cycles/${ids.cycle}`)).body;
    const sign = stage(detail, 'sign');
    const out = sign.outputs[0];
    expect((await call('lead', 'POST', `/api/cycle-stages/${sign.id}/start`)).status).toBe(200);   // the cycle lead owns this stage
    const mine = await call('head', 'GET', '/api/my-cycle-work');
    expect(mine.body.approvals).toEqual([expect.objectContaining({ outputId: out.id, outputName: 'Sign-off', stageName: 'Sign-off' })]);
    for (const who of ['admin', 'lead', 'contributor', 'viewer']) {
      expect((await call(who, 'POST', `/api/cycle-outputs/${out.id}/decision`, { decision: 'approved' })).status, who).toBe(403);
    }
    expect((await call('head', 'POST', `/api/cycle-outputs/${out.id}/decision`, { decision: 'returned' })).status).toBe(400);   // needs a comment
    expect((await call('head', 'POST', `/api/cycle-outputs/${out.id}/decision`, { decision: 'maybe' })).status).toBe(400);
    const decided = await call('head', 'POST', `/api/cycle-outputs/${out.id}/decision`, { decision: 'approved' });
    expect(decided.status).toBe(200);
    expect(decided.headers.get(UNDO_HEADER)).toBeNull();     // a sign-off is recorded, not undone
    expect(stage(decided.body, 'sign').outputs[0]).toMatchObject({ decision: 'approved', decisionLabel: 'Internally approved', state: 'final', finalisedByName: 'head' });
    const finished = await call('lead', 'POST', `/api/cycle-stages/${sign.id}/complete`);
    expect(finished.body).toMatchObject({ status: 'completed', stagesDone: 2 });
    expect((await call('head', 'GET', '/api/my-cycle-work')).body).toEqual({ stages: [], approvals: [] });
  });

  it('cancels with a reason, deletes only drafts (to the Trash), and takes the draft back with Undo', async () => {
    const d = await call('lead', 'POST', '/api/cycles', { templateId: ids.tpl, anchorKind: 'org_unit', anchorId: ids.unit, startDate: '2027-09-01' });
    expect((await call('viewer', 'DELETE', `/api/cycles/${d.body.id}`)).status).toBe(403);
    expect((await call('lead', 'DELETE', `/api/cycles/${ids.cycle}`)).status).toBe(409);        // completed: not deleted
    expect((await call('lead', 'POST', `/api/cycles/${d.body.id}/cancel`, { reason: 'no' })).status).toBe(409);   // a draft is deleted
    const del = await call('lead', 'DELETE', `/api/cycles/${d.body.id}`);
    expect(del.status).toBe(200);
    const undo = undoOf(del)!;
    expect(undo).toMatchObject({ method: 'POST', path: `/api/trash/groups/${del.body.groupId}/restore` });
    expect((await call('viewer', 'GET', `/api/cycles/${d.body.id}`)).status).toBe(404);
    const back = await call('lead', undo.method, undo.path, undo.body ?? {});
    expect(back.status).toBe(200);
    expect((await call('viewer', 'GET', `/api/cycles/${d.body.id}`)).status).toBe(200);
    await call('lead', 'POST', `/api/cycles/${d.body.id}/activate`);
    expect((await call('lead', 'POST', `/api/cycles/${d.body.id}/cancel`, {})).status).toBe(400);
    const cancelled = await call('lead', 'POST', `/api/cycles/${d.body.id}/cancel`, { reason: 'Replaced by a periodic review' });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'Replaced by a periodic review' });
  });

  it('keeps another institution out', async () => {
    const other = await one(`insert into institution (name_en) values ('Other') returning id`);
    const u = await one(`insert into app_user (institution_id, full_name, email) values ($1, 'o', 'o') returning id`, [other]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1)`, [other, u]);
    const h = { 'x-test-user': `${u}:${other}` };
    const res = await app.request('/api/cycles', { headers: h });
    expect(await res.json()).toEqual([]);
    expect((await app.request(`/api/cycles/${ids.cycle}`, { headers: h })).status).toBe(404);
    expect((await app.request(`/api/cycle-templates/${ids.tpl}`, { headers: h })).status).toBe(404);
  });
});
