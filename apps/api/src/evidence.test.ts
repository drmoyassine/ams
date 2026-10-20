// Evidence over HTTP: the file goes up as the request body, comes back with its type, and nobody else's stays hidden.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const as = (who: string) => ({ 'x-test-user': `${ids[who]}:${ids.inst}` });
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method, headers: { 'content-type': 'application/json', ...(who ? as(who) : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeAll(async () => {
  db = await createTestDb('apievidence');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['lead', 'viewer', 'nobody', 'contrib']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['lead', 'lead'], ['viewer', 'viewer'], ['contrib', 'contributor']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('evidence API', () => {
  it('documents its routes and needs a permission for each', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    for (const p of ['/api/evidence', '/api/evidence/{id}/files', '/api/evidence-versions/{id}/file', '/api/engagement-requirements/{id}/evidence-suggestions']) expect(Object.keys(spec.paths), p).toContain(p);
    expect((await call(null, 'GET', '/api/evidence')).status).toBe(401);
    expect((await call('nobody', 'GET', '/api/evidence')).status).toBe(403);
    expect((await call('viewer', 'POST', '/api/evidence', { title: 'x', type: 'document' })).status).toBe(403);
  });

  it('uploads a file as the request body and serves it back with its type and name', async () => {
    const item = await call('lead', 'POST', '/api/evidence', { title: 'Strategic plan', type: 'document', periodLabel: 'AY2025-26' });
    expect(item.status).toBe(201);
    const pdf = new TextEncoder().encode('%PDF-1.4 plan');
    const up = await app.request(`/api/evidence/${item.body.id}/files?fileName=${encodeURIComponent('خطة استراتيجية.pdf')}`, {
      method: 'POST', headers: { ...as('lead'), 'content-type': 'application/pdf' }, body: pdf,
    });
    expect(up.status).toBe(201);
    const version = await up.json() as { id: string; versionNo: number; size: number; mime: string; fileName: string };
    expect(version).toMatchObject({ versionNo: 1, size: pdf.byteLength, mime: 'application/pdf', fileName: 'خطة استراتيجية.pdf' });

    const down = await app.request(`/api/evidence-versions/${version.id}/file`, { headers: as('viewer') });
    expect(down.status).toBe(200);
    expect(down.headers.get('content-type')).toBe('application/pdf');
    expect(down.headers.get('content-disposition')).toMatch(/^inline; filename\*=UTF-8''/);
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(pdf);

    const list = await call('viewer', 'GET', '/api/evidence?q=plan');
    expect(list.body.map((e: { title: string }) => e.title)).toEqual(['Strategic plan']);
    expect(list.body[0].latest.versionNo).toBe(1);
  });

  it('registers a link to a document kept elsewhere as a version', async () => {
    const item = await call('lead', 'POST', '/api/evidence', { title: 'Faculty handbook', type: 'document', url: 'https://intranet.example.edu/handbook' });
    const detail = await call('viewer', 'GET', `/api/evidence/${item.body.id}`);
    expect(detail.body.versions).toEqual([expect.objectContaining({ versionNo: 1, url: 'https://intranet.example.edu/handbook' })]);
    expect((await call('lead', 'POST', `/api/evidence/${item.body.id}/links-to-documents`, { url: 'https://intranet.example.edu/handbook-2026' })).body.versionNo).toBe(2);
  });

  it('saves data rows and names every cell it refuses', async () => {
    const item = await call('lead', 'POST', '/api/evidence', { title: 'Headcount', type: 'data' });
    expect((await call('lead', 'POST', `/api/evidence/${item.body.id}/data`, { rows: [{ n: '1' }] })).body.message).toBe('define the columns first');
    expect((await call('lead', 'PUT', `/api/evidence/${item.body.id}/data-definition`, { columns: [{ key: 'n', label: 'Headcount', type: 'integer', required: true }] })).status).toBe(200);
    const bad = await call('lead', 'POST', `/api/evidence/${item.body.id}/data`, { rows: [{ n: '12' }, { n: 'x' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.issues).toEqual([{ path: 'rows.1.n', message: 'enter a number' }]);
    const ok = await call('lead', 'POST', `/api/evidence/${item.body.id}/data`, { rows: [{ n: '12' }, { n: '1,200' }] });
    expect(ok.body).toMatchObject({ versionNo: 1, rowCount: 2 });
    expect((await call('viewer', 'GET', `/api/evidence-versions/${ok.body.id}/data`)).body.rows).toEqual([{ n: 12 }, { n: 1200 }]);
  });
  it('links evidence to a requirement of an external standard and reports what each requirement holds', async () => {
    const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Invented Council', 'IC', 'institutional') returning id`, [ids.inst]);
    const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Standards', 'institution') returning id`, [ids.inst, acc]);
    const ver = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'E1') returning id`, [ids.inst, fw]);
    const req = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, '1.2', 'Criterion', 'Faculty') returning id`, [ids.inst, ver]);
    const item = await call('lead', 'POST', '/api/evidence', { title: 'Faculty list', type: 'document', url: 'https://intranet.example.edu/faculty' });
    const version = (await call('lead', 'GET', `/api/evidence/${item.body.id}`)).body.versions[0].id as string;

    expect((await call('viewer', 'POST', `/api/requirements/${req}/evidence-links`, { evidenceVersionId: version, rationale: 'x' })).status).toBe(403);
    const made = await call('lead', 'POST', `/api/requirements/${req}/evidence-links`, { evidenceVersionId: version, rationale: 'Lists every faculty member' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ reviewStatus: 'approved', reviewedByName: 'lead', reviewComment: null });
    expect(made.body.target).toMatchObject({ kind: 'external', code: '1.2', title: 'Faculty', frameworkLabel: 'IC' });
    expect((await call('lead', 'POST', `/api/requirements/${req}/evidence-links`, { evidenceVersionId: version, rationale: 'again' })).status).toBe(409);
    expect((await call('viewer', 'GET', `/api/requirements/${req}/evidence-links`)).body).toHaveLength(1);

    const ctx = await call('viewer', 'GET', `/api/framework-versions/${ver}/requirement-context`);
    expect(ctx.status).toBe(200);
    expect(ctx.body.byCode['1.2']).toMatchObject({ mappings: [], inheritedCount: 0, directCount: 1, direct: [{ title: 'Faculty list', versionNo: 1, reviewStatus: 'approved' }] }); // the lead may review, so hers is approved at once
    expect((await call(null, 'GET', `/api/framework-versions/${ver}/requirement-context`)).status).toBe(401);
    expect((await call('nobody', 'GET', `/api/framework-versions/${ver}/requirement-context`)).status).toBe(403);
  });

  it('approves a reviewer\'s own link at once, makes a rejection give its reason, and tells the proposer', async () => {
    const acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Other Council', 'OC', 'institutional') returning id`, [ids.inst]);
    const fw = await one(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Standards', 'institution') returning id`, [ids.inst, acc]);
    const ver = await one(`insert into framework_version (institution_id, framework_id, edition) values ($1, $2, 'E1') returning id`, [ids.inst, fw]);
    const req = await one(`insert into requirement (institution_id, framework_version_id, code, level_label, title) values ($1, $2, '3', 'Standard', 'Students') returning id`, [ids.inst, ver]);
    const item = await call('lead', 'POST', '/api/evidence', { title: 'Admissions policy', type: 'document', url: 'https://intranet.example.edu/admissions' });
    const version = (await call('lead', 'GET', `/api/evidence/${item.body.id}`)).body.versions[0].id as string;

    const proposed = await call('contrib', 'POST', `/api/requirements/${req}/evidence-links`, { evidenceVersionId: version, rationale: 'It states the criteria' });
    expect(proposed.body).toMatchObject({ reviewStatus: 'proposed', reviewedAt: null, linkedBy: ids.contrib });
    const review = `/api/evidence-links/${proposed.body.id}/review`;
    expect((await call('contrib', 'POST', review, { decision: 'approved' })).status).toBe(403);
    expect((await call('lead', 'POST', review, { decision: 'rejected' })).status).toBe(400);
    const rejected = await call('lead', 'POST', review, { decision: 'rejected', comment: 'It is the old policy' });
    expect(rejected.body).toMatchObject({ reviewStatus: 'rejected', reviewComment: 'It is the old policy', reviewedByName: 'lead' });

    // The notice reaches the proposer only; nobody else, and no account without evidence access, reads it.
    const mine = await call('contrib', 'GET', '/api/notifications');
    expect(mine.body).toEqual([expect.objectContaining({ kind: 'link_rejected', readAt: null, body: expect.stringContaining('was rejected: It is the old policy'), link: expect.objectContaining({ id: proposed.body.id, reviewStatus: 'rejected' }) })]);
    expect((await call('viewer', 'GET', '/api/notifications')).body).toEqual([]);
    expect((await call('lead', 'GET', '/api/notifications')).body).toEqual([]);
    expect((await call('nobody', 'GET', '/api/notifications')).status).toBe(403);
    expect((await call(null, 'GET', '/api/notifications')).status).toBe(401);
    const note = mine.body[0].id as string;
    expect((await call('viewer', 'POST', `/api/notifications/${note}/read`)).status).toBe(404);
    expect((await call('viewer', 'DELETE', `/api/notifications/${note}`)).status).toBe(404);

    // Resubmit: only the proposer; the link returns to review and its notice goes away.
    expect((await call('lead', 'POST', `/api/evidence-links/${proposed.body.id}/resubmit`, { rationale: 'x' })).status).toBe(403);
    expect((await call('contrib', 'POST', `/api/evidence-links/${proposed.body.id}/resubmit`, { rationale: ' ' })).status).toBe(400);
    const back = await call('contrib', 'POST', `/api/evidence-links/${proposed.body.id}/resubmit`, { rationale: 'The 2026 policy' });
    expect(back.body).toMatchObject({ reviewStatus: 'proposed', rationale: 'The 2026 policy', reviewComment: null });
    expect((await call('contrib', 'POST', `/api/evidence-links/${proposed.body.id}/resubmit`, { rationale: 'again' })).status).toBe(409);
    expect((await call('contrib', 'GET', '/api/notifications')).body).toEqual([]);

    // Approved by someone else: a notice too; mark it read, then dismiss it.
    await call('lead', 'POST', review, { decision: 'approved' });
    const approved = (await call('contrib', 'GET', '/api/notifications')).body[0];
    expect(approved).toMatchObject({ kind: 'link_approved' });
    expect((await call('contrib', 'POST', `/api/notifications/${approved.id}/read`)).status).toBe(204);
    expect((await call('contrib', 'GET', '/api/notifications')).body[0].readAt).toEqual(expect.any(String));
    expect((await call('contrib', 'DELETE', `/api/notifications/${approved.id}`)).status).toBe(204);
    expect((await call('contrib', 'GET', '/api/notifications')).body).toEqual([]);
  });
});
