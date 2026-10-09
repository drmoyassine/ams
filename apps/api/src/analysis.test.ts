// Framework analysis API: start, list, detail, cancel, through the five-step chain. The worker part runs with a fake model.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeAiModel, FIXTURE_GUIDE, FIXTURE_HANDBOOK, fixtureResponder, handlers, runJob, setAiModelForTests } from '@ams/core';
import type { JobEnvelope } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const sent: JobEnvelope[] = [];
const queue = { send: async (_t: string, e: JobEnvelope) => { sent.push(e); } };
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
async function call(who: string | null, method: string, path: string) {
  const res = await app.request(path, { method, headers: who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {} });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function drain() { while (sent.length) await runJob(pool, 'analyse', sent.shift(), handlers, { queue }); }

async function draft(edition: string) {
  const v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, $3) returning id`, [ids.inst, ids.fw, edition]);
  const hb = await one(`insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256) values ($1, $2, $3, 'standards', 'binding', 'p', $4) returning id`, [ids.inst, v, FIXTURE_HANDBOOK.title, 'a'.repeat(64)]);
  for (const [i, t] of FIXTURE_HANDBOOK.pages.entries()) await db.su.query(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1, $2, $3, $4, 'pdf_text')`, [ids.inst, hb, i + 1, t]);
  const g = await one(`insert into source_document (institution_id, framework_version_id, title, role, role_origin, authority, language, file_path, sha256) values ($1, $2, $3, 'other', 'unset', 'interpretive', 'ar', 'p2', $4) returning id`, [ids.inst, v, FIXTURE_GUIDE.title, 'b'.repeat(64)]);
  await db.su.query(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1, $2, 1, $3, 'pdf_text')`, [ids.inst, g, FIXTURE_GUIDE.pages[0]]);
  return v;
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('apianalysis');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, queue, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [n, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']] as const) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[n], role]);
  }
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]);
  ids.fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'S', 'institution') returning id`, [ids.inst, acc]);
}, 30000);
afterEach(() => setAiModelForTests(null));
afterAll(async () => { await pool.end(); await db.close(); });

describe('analysis API', () => {
  it('is documented and needs a sign-in; starting needs framework:write', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/framework-versions/{id}/analysis', '/api/analysis/{id}', '/api/analysis/{id}/cancel']));
    const v = await draft('auth');
    expect((await call(null, 'POST', `/api/framework-versions/${v}/analysis`)).status).toBe(401);
    expect((await call('viewer', 'POST', `/api/framework-versions/${v}/analysis`)).status).toBe(403);
    expect((await call('viewer', 'GET', `/api/framework-versions/${v}/analysis`)).status).toBe(200);
  });

  it('starts a run, reports its progress and result, and lists it', async () => {
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    const v = await draft('run');
    const started = await call('lead', 'POST', `/api/framework-versions/${v}/analysis`);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: 'queued', stage: 'read', frameworkVersionId: v });
    expect((await call('lead', 'POST', `/api/framework-versions/${v}/analysis`)).status).toBe(409); // one at a time
    await drain();
    const run = await call('viewer', 'GET', `/api/analysis/${started.body.id}`);
    expect(run.status).toBe(200);
    // Six calls for the extraction, three recovery questions (the fixture answers each "not there").
    expect(run.body).toMatchObject({ status: 'succeeded', progress: { windowsDone: 3, windowsTotal: 3, round: 1, maxRounds: 2 }, usage: { calls: 9 } });
    expect(run.body.report.stats).toMatchObject({ requirements: 7, notes: 3, orphans: 1, gapsConfirmedAbsent: 3, gapsUnresolved: 0, recoveryRounds: 1 });
    expect(run.body.report.gaps).toHaveLength(3);
    expect(run.body.report.gaps[0]).toMatchObject({ key: 'req:3.9', kind: 'missing_parent', status: 'confirmed_absent', round: 1, attempts: 1 });
    const list = await call('viewer', 'GET', `/api/framework-versions/${v}/analysis`);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([started.body.id]);
    const reqs = await call('viewer', 'GET', `/api/framework-versions/${v}/requirements`);
    expect(reqs.body.find((r: { code: string }) => r.code === '1.9')).toMatchObject({ origin: 'ai', quoteVerified: false, editedByPerson: false });
  });

  it('cancels an active run once', async () => {
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    const v = await draft('cancel');
    const started = await call('lead', 'POST', `/api/framework-versions/${v}/analysis`);
    expect((await call('viewer', 'POST', `/api/analysis/${started.body.id}/cancel`)).status).toBe(403);
    const c = await call('lead', 'POST', `/api/analysis/${started.body.id}/cancel`);
    expect(c.body).toMatchObject({ status: 'cancelled' });
    expect((await call('lead', 'POST', `/api/analysis/${started.body.id}/cancel`)).status).toBe(409);
    await drain();
    expect((await call('lead', 'GET', `/api/analysis/${started.body.id}`)).body.status).toBe('cancelled');
  });

  it('refuses a published version, a version without sources, and AI that is off', async () => {
    setAiModelForTests(createFakeAiModel([fixtureResponder()]).model);
    const v = await draft('pub');
    await db.su.query(`update framework_version set status = 'in_review' where id = $1`, [v]);
    await db.su.query(`update framework_version set status = 'published', published_at = now(), published_by = $2 where id = $1`, [v, ids.admin]);
    expect((await call('lead', 'POST', `/api/framework-versions/${v}/analysis`)).status).toBe(409);
    const empty = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'empty') returning id`, [ids.inst, ids.fw]);
    expect((await call('lead', 'POST', `/api/framework-versions/${empty}/analysis`)).body.message).toMatch(/Sources first/);
    await db.su.query(`insert into ai_setting (institution_id, model, enabled) values ($1, 'm', false)`, [ids.inst]);
    const off = await call('lead', 'POST', `/api/framework-versions/${await draft('off')}/analysis`);
    expect(off.status).toBe(409);
    expect(off.body.message).toMatch(/switched off/);
    await db.su.query(`delete from ai_setting`);
    expect((await call('lead', 'GET', `/api/analysis/${crypto.randomUUID()}`)).status).toBe(404);
  });
});
