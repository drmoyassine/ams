// Suggested IQF links and new items, through the five-step chain (step E): who may see, accept and dismiss them, and what the
// refusals say. The worker part runs with a fake model.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeAiModel, FIXTURE_HANDBOOK, fixtureResponder, handlers, mappingResponder, runJob, setAiModelForTests } from '@ams/core';
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
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method, headers: { ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function drain() { while (sent.length) await runJob(pool, 'analyse', sent.shift(), handlers, { queue }); }

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  db = await createTestDb('apiiqfmap');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, queue, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [n, role] of [['admin', 'admin'], ['lead', 'lead'], ['reviewer', 'reviewer'], ['viewer', 'viewer']] as const) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[n], role]);
  }
  // The quality framework, published, then the external standard analysed against it.
  const q = await call('admin', 'POST', '/api/quality-framework', {});
  ids.qv = q.body.versions[0].id;
  for (const [code, title] of [['1', 'Mission and governance'], ['1.1', 'Mission, vision and values'], ['2', 'Teaching and learning']]) {
    expect((await call('admin', 'POST', `/api/framework-versions/${ids.qv}/quality-items`, { code, title })).status).toBe(201);
  }
  expect((await call('admin', 'POST', `/api/framework-versions/${ids.qv}/publish-quality`)).status).toBe(200);
  const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]);
  const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'S', 'institution') returning id`, [ids.inst, acc]);
  ids.v = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'E') returning id`, [ids.inst, fw]);
  const hb = await one(`insert into source_document (institution_id, framework_version_id, title, role, authority, file_path, sha256) values ($1, $2, $3, 'standards', 'binding', 'p', $4) returning id`, [ids.inst, ids.v, FIXTURE_HANDBOOK.title, 'a'.repeat(64)]);
  for (const [i, t] of FIXTURE_HANDBOOK.pages.entries()) await db.su.query(`insert into source_page (institution_id, source_document_id, page_no, text, method) values ($1, $2, $3, $4, 'pdf_text')`, [ids.inst, hb, i + 1, t]);
  setAiModelForTests(createFakeAiModel([mappingResponder(fixtureResponder(), {
    fit: { '1.1': { '1.1': 'covers' }, '1': { '1': 'covers' }, '1.2': { '1': 'partly_covers' } },
    newItems: (codes) => (codes.includes('1.1.1') ? [
      { parent_code: '1', code: '1.2', title: 'Published mission statement', description: 'The mission statement is public.', reason: 'Nothing asks for it.', covers: [{ requirement: '1.1.1', relation: 'covers', reason: 'Asks for publication.' }] },
      { parent_code: null, code: '3', title: 'Graduate follow-up', description: 'Graduates are followed up.', reason: 'Nothing about graduates.', covers: [{ requirement: '3.9.1', relation: 'covers', reason: null }] },
    ] : []),
  })]).model);
  expect((await call('lead', 'POST', `/api/framework-versions/${ids.v}/analysis`)).status).toBe(202);
  await drain();
  setAiModelForTests(null);
}, 90000);
afterEach(() => setAiModelForTests(null));
afterAll(async () => { await pool.end(); await db.close(); });

describe('suggested IQF links and items API', () => {
  it('is documented, needs a sign-in, and anyone who may read frameworks sees the suggestions', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      '/api/framework-versions/{id}/iqf-proposals', '/api/framework-versions/{id}/mappings/accept-covers', '/api/iqf-proposals/{id}/accept', '/api/iqf-proposals/{id}/dismiss',
    ]));
    expect((await call(null, 'GET', `/api/framework-versions/${ids.v}/iqf-proposals`)).status).toBe(401);
    const list = await call('viewer', 'GET', `/api/framework-versions/${ids.v}/iqf-proposals`);
    expect(list.status).toBe(200);
    expect(list.body.draftVersionId).toBeNull();
    expect(list.body.proposals.map((p: { code: string; status: string }) => [p.code, p.status])).toEqual([['1.2', 'pending'], ['3', 'pending']]);
    expect(list.body.proposals[0]).toMatchObject({ parentCode: '1', parentTitle: 'Mission and governance', levelLabel: 'Sub-standard', links: [{ externalCode: '1.1.1', relation: 'covers', reason: 'Asks for publication.' }] });
    const maps = await call('viewer', 'GET', `/api/framework-versions/${ids.v}/mappings`);
    expect(maps.body.mappings.filter((m: { origin: string; reviewStatus: string }) => m.origin === 'ai' && m.reviewStatus === 'pending')).toHaveLength(3);
  });

  it('accepts "covers" links in bulk for those who review, and only "covers"', async () => {
    const maps = (await call('viewer', 'GET', `/api/framework-versions/${ids.v}/mappings`)).body.mappings as { id: string; relation: string }[];
    const all = maps.map((m) => m.id);
    expect((await call('viewer', 'POST', `/api/framework-versions/${ids.v}/mappings/accept-covers`, { ids: all })).status).toBe(403);
    expect((await call('lead', 'POST', `/api/framework-versions/${ids.v}/mappings/accept-covers`, { ids: [] })).status).toBe(400);
    expect((await call('lead', 'POST', `/api/framework-versions/${ids.v}/mappings/accept-covers`, { ids: ['nope'] })).status).toBe(400);
    const done = await call('reviewer', 'POST', `/api/framework-versions/${ids.v}/mappings/accept-covers`, { ids: all });
    expect(done).toMatchObject({ status: 200, body: { accepted: 2, skipped: 1 } });
    const after = (await call('viewer', 'GET', `/api/framework-versions/${ids.v}/mappings`)).body.mappings as { relation: string; reviewStatus: string }[];
    expect(after.filter((m) => m.reviewStatus === 'approved').map((m) => m.relation)).toEqual(['covers', 'covers']);
    expect(after.find((m) => m.relation === 'partly_covers')!.reviewStatus).toBe('pending');
  });

  it('refuses to add a suggested item while the quality framework has no draft, saying what to do', async () => {
    const p = (await call('viewer', 'GET', `/api/framework-versions/${ids.v}/iqf-proposals`)).body.proposals[0];
    expect((await call('viewer', 'POST', `/api/iqf-proposals/${p.id}/accept`, {})).status).toBe(403);
    // Reviewing is not enough: adding an item to the framework also needs the right to edit it.
    expect((await call('reviewer', 'POST', `/api/iqf-proposals/${p.id}/accept`, {})).status).toBe(403);
    const refused = await call('lead', 'POST', `/api/iqf-proposals/${p.id}/accept`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.message ?? refused.body.error).toMatch(/Start a new version of the quality framework first/);
    expect((await call('lead', 'POST', `/api/iqf-proposals/${p.id}/accept`, { code: '' })).status).toBe(400);
    expect((await call('lead', 'POST', `/api/iqf-proposals/${p.id}/accept`, { surprise: 1 })).status).toBe(400);
  });

  it('accepts with edits once there is a draft, and dismisses; neither can be done twice', async () => {
    expect((await call('lead', 'POST', '/api/quality-framework/versions')).status).toBe(201);
    const list = (await call('lead', 'GET', `/api/framework-versions/${ids.v}/iqf-proposals`)).body;
    expect(list.draftVersionId).toEqual(expect.any(String));
    const [first, second] = list.proposals;
    const accepted = await call('lead', 'POST', `/api/iqf-proposals/${first.id}/accept`, { title: 'Public mission statement', parentCode: '1.1' });
    expect(accepted).toMatchObject({ status: 200, body: { status: 'accepted', title: 'Public mission statement', parentCode: '1.1', acceptedRequirementId: expect.any(String) } });
    expect((await call('lead', 'POST', `/api/iqf-proposals/${first.id}/accept`, {})).status).toBe(409);
    const req = await call('lead', 'GET', `/api/requirements/${accepted.body.acceptedRequirementId}`);
    expect(req.body.requirement).toMatchObject({ code: '1.2', origin: 'ai', reviewStatus: 'pending', title: 'Public mission statement' });
    const link = (await call('lead', 'GET', `/api/framework-versions/${ids.v}/mappings`)).body.mappings.find((m: { externalCode: string }) => m.externalCode === '1.1.1');
    expect(link).toMatchObject({ internalCode: '1.2', reviewStatus: 'approved', origin: 'ai', relation: 'covers' });

    expect((await call('viewer', 'POST', `/api/iqf-proposals/${second.id}/dismiss`)).status).toBe(403);
    expect((await call('reviewer', 'POST', `/api/iqf-proposals/${second.id}/dismiss`)).body).toMatchObject({ status: 'dismissed' });
    expect((await call('reviewer', 'POST', `/api/iqf-proposals/${second.id}/dismiss`)).status).toBe(409);
    expect((await call('lead', 'POST', `/api/iqf-proposals/${second.id}/accept`, {})).status).toBe(409);
    expect((await call('lead', 'POST', `/api/iqf-proposals/00000000-0000-4000-8000-000000000000/dismiss`)).status).toBe(404);
  });
});
