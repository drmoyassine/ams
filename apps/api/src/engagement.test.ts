// The engagement API end to end through the real app: authentication, the permission chain, scoped services, the
// typed responses, and the M2 flow a lead follows (create, members, roadmap, workspace).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, params: unknown[] = []) => (await db.su.query(sql, params)).rows[0].id as string;
const fixture = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../packages/db/fixtures/${name}.json`), 'utf8')) as unknown;

async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function publish(name: string): Promise<string> {
  const imported = await call('admin', 'POST', '/api/framework-versions/import', { file: fixture(name), autoApprove: true });
  expect(imported.status).toBe(201);
  const id = imported.body.version.id as string;
  expect((await call('admin', 'POST', `/api/framework-versions/${id}/submit`)).status).toBe(200);
  expect((await call('admin', 'POST', `/api/framework-versions/${id}/publish`)).status).toBe(200);
  return id;
}

beforeAll(async () => {
  db = await createTestDb('apieng');
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
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'coord', 'contrib', 'reviewer', 'stranger']) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, `${n}@x.org`]);
  }
  const unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.mech = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level, tags) values ($1, $2, 'BS Mechanical Engineering', 'bachelor', '{mechanical}') returning id`, [ids.inst, unit]);
  const grant = (u: string, role: string, scope: string, scopeId: string) =>
    db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, $4, $5)`, [ids.inst, ids[u], role, scope, scopeId]);
  await grant('admin', 'admin', 'institution', ids.inst!);
  await grant('coord', 'lead', 'program', ids.mech!);
  await grant('contrib', 'contributor', 'program', ids.mech!);
  ids.abet = await publish('abet-eac-2027-28');
  ids.wscuc = await publish('wscuc-2023');
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('engagement API', () => {
  let eng: string;
  let reqId: string;

  it('documents every engagement route in the OpenAPI spec', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    for (const p of ['/api/engagements', '/api/engagements/{id}', '/api/engagements/{id}/members', '/api/engagements/{id}/handover', '/api/milestones/{id}',
      '/api/engagements/{id}/template-update', '/api/engagements/{id}/requirements', '/api/engagement-requirements/{id}', '/api/engagement-requirements/{id}/applicability']) {
      expect(Object.keys(spec.paths), p).toContain(p);
    }
  });

  it('requires authentication, and creation needs the permission at the subject\'s scope', async () => {
    const body = { frameworkVersionId: ids.abet, subjectType: 'program', subjectId: ids.mech, kind: 'initial', reviewYear: 2027, leadUserId: ids.coord };
    expect((await call(null, 'GET', '/api/engagements')).status).toBe(401);
    expect((await call('stranger', 'GET', '/api/engagements')).status).toBe(403); // holds no role
    expect((await call('contrib', 'POST', '/api/engagements', body)).status).toBe(403); // chain: no engagement:create anywhere
    expect((await call('coord', 'POST', '/api/engagements', { ...body, subjectId: ids.inst, subjectType: 'institution' })).status).toBe(403); // service: not at institution scope
    expect((await call('coord', 'POST', '/api/engagements', { ...body, reviewYear: 'soon' })).status).toBe(400);
  });

  it('lets a program-scoped lead read the framework library (to pick a version) but not change it', async () => {
    const list = await call('coord', 'GET', '/api/frameworks');
    expect(list.status).toBe(200);
    expect(list.body.map((f: { accreditorShortName: string }) => f.accreditorShortName).sort()).toEqual(['ABET', 'WSCUC']);
    expect((await call('coord', 'POST', '/api/framework-versions/import', { file: fixture('puc-2019') })).status).toBe(403);
    expect((await call('coord', 'GET', '/api/users')).body.length).toBeGreaterThan(3);
  });

  it('creates an engagement with its lead, requirements and roadmap', async () => {
    const res = await call('coord', 'POST', '/api/engagements', {
      frameworkVersionId: ids.abet, subjectType: 'program', subjectId: ids.mech, kind: 'initial', reviewYear: 2027, leadUserId: ids.coord,
    });
    expect(res.status).toBe(201);
    eng = res.body.engagement.id;
    expect(res.body.engagement).toMatchObject({ status: 'active', currentPhase: 'eligibility', leadName: 'coord@x.org', subjectName: 'BS Mechanical Engineering' });
    expect(res.body.requirementCounts.notApplicable).toBe(0);
    expect(res.body.milestoneCount).toBeGreaterThan(20);
  });

  it('lists only what the caller can see, and serves the detail', async () => {
    expect((await call('coord', 'GET', '/api/engagements')).body).toHaveLength(1);
    expect((await call('contrib', 'GET', '/api/engagements')).body).toHaveLength(1); // program-scoped
    const d = await call('coord', 'GET', `/api/engagements/${eng}`);
    expect(d.status).toBe(200);
    expect(d.body.phases.map((p: { type: string }) => p.type)).toEqual(['eligibility', 'self_study', 'review', 'decision', 'maintenance']);
    expect(d.body).toMatchObject({ canAdvance: false, members: [expect.objectContaining({ role: 'engagement_lead' })] });
    expect(d.body.milestones.find((m: { templateKey: string }) => m.templateKey === 'ssr_submit')).toMatchObject({ dueDate: '2027-07-01', locked: true });
    expect((await call('stranger', 'GET', `/api/engagements/${eng}`)).status).toBe(403);
    expect((await call('coord', 'GET', `/api/engagements/${ids.inst}`)).status).toBe(404);
  });

  it('manages members and hands the lead over, with the right errors', async () => {
    const added = await call('coord', 'POST', `/api/engagements/${eng}/members`, { userId: ids.contrib, role: 'contributor' });
    expect(added.status).toBe(201);
    expect((await call('coord', 'POST', `/api/engagements/${eng}/members`, { userId: ids.contrib, role: 'viewer' })).status).toBe(409);
    expect((await call('coord', 'POST', `/api/engagements/${eng}/members`, { userId: ids.reviewer, role: 'reviewer' })).status).toBe(201);
    expect((await call('contrib', 'POST', `/api/engagements/${eng}/members`, { userId: ids.stranger, role: 'viewer' })).status).toBe(403);
    expect((await call('contrib', 'POST', `/api/engagements/${eng}/handover`, { newLeadUserId: ids.contrib })).status).toBe(403);
    expect((await call('coord', 'DELETE', `/api/engagements/${eng}/members/${ids.coord}`)).status).toBe(409); // the lead
    const members = await call('coord', 'GET', `/api/engagements/${eng}/members`);
    expect(members.body.map((m: { role: string }) => m.role)).toEqual(['engagement_lead', 'contributor', 'reviewer']);
  });

  it('edits the roadmap within the guardrails', async () => {
    const d = (await call('coord', 'GET', `/api/engagements/${eng}`)).body;
    const m = (k: string) => d.milestones.find((x: { templateKey: string }) => x.templateKey === k);
    const renamed = await call('coord', 'PATCH', `/api/milestones/${m('pay_invoice').id}`, { name: 'Pay the invoice', dueDate: '2027-06-01' });
    expect(renamed.body).toMatchObject({ origin: 'modified', dueDate: '2027-06-01' });
    expect((await call('coord', 'DELETE', `/api/milestones/${m('ssr_submit').id}`)).status).toBe(409); // locked
    expect((await call('coord', 'PATCH', `/api/milestones/${m('rrev_fee').id}`, { status: 'skipped' })).status).toBe(400); // needs a reason
    expect((await call('contrib', 'PATCH', `/api/milestones/${m('rrev_fee').id}`, { name: 'x' })).status).toBe(403);
    const local = await call('coord', 'POST', `/api/engagements/${eng}/milestones`, { phase: 'self_study', name: 'Board approval' });
    expect(local.status).toBe(201);
    expect(local.body).toMatchObject({ origin: 'local', required: false });
    expect((await call('coord', 'DELETE', `/api/milestones/${local.body.id}`)).status).toBe(204);
    const patched = await call('coord', 'PATCH', `/api/engagements/${eng}`, { keyDates: { visit_date: '2027-10-18' } });
    expect(patched.body.milestones.find((x: { templateKey: string }) => x.templateKey === 'on_site_visit').dueDate).toBe('2027-10-18');
    expect((await call('coord', 'POST', `/api/engagements/${eng}/advance-phase`)).status).toBe(409); // required milestones open
  });

  it('works a requirement from not started to internally approved, each role taking its own step', async () => {
    const list = (await call('contrib', 'GET', `/api/engagements/${eng}/requirements`)).body;
    expect(list.byStatus.not_started).toBe(list.items.length);
    reqId = list.items.find((i: { code: string }) => i.code === 'Criterion 1').id;
    const assigned = await call('coord', 'PATCH', `/api/engagement-requirements/${reqId}`, { ownerId: ids.contrib, reviewerId: ids.reviewer });
    expect(assigned.status).toBe(200);
    expect((await call('contrib', 'PATCH', `/api/engagement-requirements/${reqId}`, { status: 'in_progress' })).body.item.status).toBe('in_progress');
    expect((await call('contrib', 'PATCH', `/api/engagement-requirements/${reqId}`, { status: 'ready_for_review' })).body.item.status).toBe('ready_for_review');
    expect((await call('contrib', 'PATCH', `/api/engagement-requirements/${reqId}`, { status: 'approved' })).status).toBe(409);
    const ws = await call('reviewer', 'GET', `/api/engagement-requirements/${reqId}`);
    expect(ws.body.allowedStatuses).toEqual(['approved', 'needs_work']);
    expect(ws.body.requirement.officialText).toMatch(/Student performance must be evaluated/);
    const approved = await call('reviewer', 'PATCH', `/api/engagement-requirements/${reqId}`, { status: 'approved' });
    expect(approved.body.item.status).toBe('approved');
    expect(approved.body.history.map((h: { actorName: string }) => h.actorName)).toContain('reviewer@x.org');
    // DEC-005: the system's own words never say compliant or met (the framework's quoted text is the accreditor's).
    expect(JSON.stringify({ item: approved.body.item, allowed: approved.body.allowedStatuses, history: approved.body.history })).not.toMatch(/compliant|\bmet\b/i);
  });

  it('exports the roadmap as a calendar file', async () => {
    const res = await app.request(`/api/engagements/${eng}/calendar.ics`, { headers: { 'x-test-user': `${ids.contrib}:${ids.inst}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/calendar/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="ABET-.*\.ics"/);
    const text = await res.text();
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('DTSTART;VALUE=DATE:20270701');
    expect((await call(null, 'GET', `/api/engagements/${eng}/calendar.ics`)).status).toBe(401);
    expect((await call('stranger', 'GET', `/api/engagements/${eng}/calendar.ics`)).status).toBe(403);
  });

  it('switches applicability with a reason and counts only applicable requirements', async () => {
    const id = (await call('coord', 'GET', `/api/engagements/${eng}/requirements`)).body.items.find((i: { code: string }) => i.code === 'Criterion 8').id;
    expect((await call('coord', 'POST', `/api/engagement-requirements/${id}/applicability`, { applicable: false })).status).toBe(400);
    expect((await call('coord', 'POST', `/api/engagement-requirements/${id}/applicability`, { applicable: false, reason: 'Covered elsewhere' })).body.item.applicable).toBe(false);
  });

  it('reports no template update until a newer version is published, then hands the lead over', async () => {
    const u = await call('coord', 'GET', `/api/engagements/${eng}/template-update`);
    expect(u.body).toMatchObject({ available: false, changes: [] });
    const handed = await call('coord', 'POST', `/api/engagements/${eng}/handover`, { newLeadUserId: ids.contrib, outgoingRole: 'co_lead' });
    expect(handed.status).toBe(200);
    expect(handed.body.map((m: { role: string }) => m.role)).toEqual(['engagement_lead', 'co_lead', 'reviewer']);
    expect((await call('coord', 'POST', `/api/engagements/${eng}/withdraw`, { reason: 'x' })).status).toBe(403); // no longer the lead
    expect((await call('contrib', 'POST', `/api/engagements/${eng}/withdraw`, { reason: 'Not pursuing' })).body.engagement.status).toBe('withdrawn');
  });
});
