// Evidence collection runs over HTTP (TASK-090): the people's routes (list, run now, skip, retry, supply) with their permissions, and the
// BI's callback, which is authenticated by the run's one-time token and nothing else.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore, type BiCall, type BiCallResult, type BiClient } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

class FakeBi implements BiClient {
  calls: BiCall[] = [];
  script: (BiCallResult | Error)[] = [{ status: 202 }];
  async collect(call: BiCall): Promise<BiCallResult> {
    this.calls.push(call);
    const next = this.script.length > 1 ? this.script.shift()! : this.script[0]!;
    if (next instanceof Error) throw next;
    return next;
  }
}

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const bi = new FakeBi();
const store = new MemoryStore();
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const as = (who: string) => ({ 'x-test-user': `${ids[who]}:${ids.inst}` });
async function call(who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method, headers: { 'content-type': 'application/json', ...(who ? as(who) : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  db = await createTestDb('apicollection');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({
    pool, store, bi: { config: { baseUrl: 'https://bi.example.org', apiKey: 'k', endpoints: { warehouse: '/ams/collect/warehouse' }, publicUrl: 'https://ams.example.org', production: true }, client: bi },
    authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; },
  }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['lead', 'viewer', 'nobody']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['lead', 'lead'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('the people\'s routes', () => {
  it('say whether the BI is set up, without any secret', async () => {
    expect((await call(null, 'GET', '/api/collection-config')).status).toBe(401);
    expect((await call('nobody', 'GET', '/api/collection-config')).status).toBe(403);
    const r = await call('viewer', 'GET', '/api/collection-config');
    expect(r.body).toEqual({ bi: { configured: true, endpointKeys: ['warehouse'], callbackConfigured: true } });
    expect(JSON.stringify(r.body)).not.toContain('bi.example.org');
  });

  it('run now makes and carries out a run; a viewer may read runs but not make, skip, retry or supply them', async () => {
    const made = await call('lead', 'POST', '/api/evidence', { title: 'Policy review', type: 'document', methodConfig: { instructions: 'Upload it' } });
    ids.manual = made.body.id;
    expect((await call('viewer', 'POST', `/api/evidence/${ids.manual}/runs/now`)).status).toBe(403);
    expect((await call(null, 'POST', `/api/evidence/${ids.manual}/runs/now`)).status).toBe(401);
    const run = await call('lead', 'POST', `/api/evidence/${ids.manual}/runs/now`);
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ status: 'pending', trigger: 'manual', evidenceTitle: 'Policy review', method: 'manual', ownerName: 'lead' });
    ids.run = run.body.id;
    expect((await call('lead', 'POST', `/api/evidence/${ids.manual}/runs/now`)).status).toBe(409);
    expect((await call('viewer', 'GET', `/api/evidence/${ids.manual}/runs`)).body.map((r: { id: string }) => r.id)).toEqual([ids.run]);
    expect((await call('viewer', 'GET', '/api/collection-runs?status=pending,late&mine=false')).body.map((r: { id: string }) => r.id)).toContain(ids.run);
    expect((await call('viewer', 'GET', '/api/collection-runs?status=bogus')).status).toBe(400);
    expect((await call('lead', 'GET', '/api/collection-runs?mine=true')).body.map((r: { id: string }) => r.id)).toContain(ids.run);
    expect((await call('viewer', 'GET', '/api/collection-runs?mine=true')).body).toEqual([]);
    expect((await call('viewer', 'POST', `/api/collection-runs/${ids.run}/skip`, { reason: 'x' })).status).toBe(403);
    expect((await call('viewer', 'POST', `/api/collection-runs/${ids.run}/retry`)).status).toBe(403);
    expect((await call('viewer', 'POST', `/api/collection-runs/${ids.run}/supply`, { versionId: crypto.randomUUID() })).status).toBe(403);
  });

  it('skip needs a reason; retry is for a failed run; supplying needs a version of the same item', async () => {
    expect((await call('lead', 'POST', `/api/collection-runs/${ids.run}/skip`, { reason: '  ' })).status).toBe(400);
    expect((await call('lead', 'POST', `/api/collection-runs/${ids.run}/retry`)).status).toBe(409);
    expect((await call('lead', 'POST', `/api/collection-runs/${crypto.randomUUID()}/skip`, { reason: 'x' })).status).toBe(404);
    expect((await call('lead', 'POST', `/api/collection-runs/${ids.run}/supply`, { versionId: crypto.randomUUID() })).status).toBe(400);
    const other = await call('lead', 'POST', '/api/evidence', { title: 'Another', type: 'document', url: 'https://x.example/a' });
    const otherVersion = (await call('lead', 'GET', `/api/evidence/${other.body.id}`)).body.versions[0].id;
    expect((await call('lead', 'POST', `/api/collection-runs/${ids.run}/supply`, { versionId: otherVersion })).status).toBe(400);
    const own = await call('lead', 'POST', `/api/evidence/${ids.manual}/links-to-documents`, { url: 'https://x.example/own' });
    expect(own.status).toBe(201);
    // Registering the address was the owner's new version: it already supplied the waiting run.
    expect((await call('lead', 'GET', `/api/evidence/${ids.manual}/runs`)).body[0]).toMatchObject({ status: 'supplied', versionNo: 1 });
    expect((await call('lead', 'POST', `/api/collection-runs/${ids.run}/skip`, { reason: 'too late' })).status).toBe(409);
  });

  it('skip records the reason', async () => {
    const m = await call('lead', 'POST', '/api/evidence', { title: 'Minutes', type: 'document' });
    const run = (await call('lead', 'POST', `/api/evidence/${m.body.id}/runs/now`)).body;
    const skipped = await call('lead', 'POST', `/api/collection-runs/${run.id}/skip`, { reason: 'Council did not meet' });
    expect(skipped).toMatchObject({ status: 200, body: { status: 'skipped', skipReason: 'Council did not meet' } });
  });
});

describe('the BI\'s callback', () => {
  const columns = [{ key: 'program', label: 'Program', type: 'text', required: true }, { key: 'n', label: 'Headcount', type: 'integer', required: true }];
  async function waitingRun(title: string) {
    const d = await call('lead', 'POST', '/api/evidence', { title, type: 'dataset', method: 'bi', methodConfig: { query: { metric: 'headcount' } } });
    expect((await call('lead', 'PUT', `/api/evidence/${d.body.id}/data-definition`, { columns })).status).toBe(200);
    bi.script = [{ status: 202 }];
    const run = await call('lead', 'POST', `/api/evidence/${d.body.id}/runs/now`);
    expect(run.status).toBe(201);
    expect(run.body.status).toBe('requested');
    const sent = bi.calls.find((c) => c.body.runId === run.body.id)!;
    expect(sent.body.callbackUrl).toBe(`https://ams.example.org/api/bi/v0/runs/${run.body.id}/supply`);
    return { itemId: d.body.id as string, run: run.body, token: sent.body.callbackToken };
  }
  const good = { rows: [{ program: 'BSME', n: 120 }], asOf: '2027-03-01', lineage: { steward: 'registrar' } };

  it('is authenticated by the run\'s token alone: no token, a wrong token, another run\'s token or a session all answer 401', async () => {
    const a = await waitingRun('Headcount A');
    const b = await waitingRun('Headcount B');
    const url = `/api/bi/v0/runs/${a.run.id}/supply`;
    expect((await call(null, 'POST', url, good)).status).toBe(401);
    expect((await call('lead', 'POST', url, good)).status).toBe(401); // a signed-in administrator's session is not the credential
    expect((await call(null, 'POST', url, good, bearer('wrong-wrong-wrong'))).status).toBe(401);
    expect((await call(null, 'POST', url, good, bearer(b.token))).status).toBe(401);
    expect((await call(null, 'POST', `/api/bi/v0/runs/${crypto.randomUUID()}/supply`, good, bearer(a.token))).status).toBe(401);
    expect((await call(null, 'POST', '/api/bi/v0/runs/not-a-uuid/supply', good, bearer(a.token))).status).toBe(401);
    expect((await call(null, 'POST', url, good, { authorization: `Basic ${a.token}` })).status).toBe(401);
    expect((await call(null, 'POST', url, good, bearer(a.token))).status).toBe(200);
    const state = (await call('viewer', 'GET', `/api/evidence/${a.itemId}/runs`)).body[0];
    expect(state).toMatchObject({ status: 'supplied', versionNo: 1 });
  });

  it('supplies once: the answer creates the version, and the same token cannot be used again', async () => {
    const a = await waitingRun('Headcount C');
    const url = `/api/bi/v0/runs/${a.run.id}/supply`;
    const ok = await call(null, 'POST', url, good, bearer(a.token));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: a.run.id, status: 'supplied', versionNo: 1 });
    const detail = (await call('viewer', 'GET', `/api/evidence/${a.itemId}`)).body;
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]).toMatchObject({ asOfDate: '2027-03-01', rowCount: 1 });
    expect((await call(null, 'POST', url, good, bearer(a.token))).status).toBe(401);
    expect((await call('viewer', 'GET', `/api/evidence/${a.itemId}`)).body.versions).toHaveLength(1);
  });

  it('refuses a body that does not fit with 422 and the issues, and the token stays good for another try', async () => {
    const a = await waitingRun('Headcount D');
    const url = `/api/bi/v0/runs/${a.run.id}/supply`;
    const cells = await call(null, 'POST', url, { rows: [{ program: 'BSME', n: 'lots' }, { n: 3 }], asOf: '2027-03-01' }, bearer(a.token));
    expect(cells.status).toBe(422);
    expect(cells.body.error).toBe('invalid_request');
    expect(cells.body.issues.map((i: { path: string }) => i.path)).toEqual(['rows.0.n', 'rows.1.program']);
    const shape = await call(null, 'POST', url, { asOf: '2027-03-01' }, bearer(a.token));
    expect(shape.status).toBe(422);
    expect(shape.body.issues[0].message).toContain('exactly one of rows, fileBase64 or url');
    const both = await call(null, 'POST', url, { ...good, url: 'https://x.example/y' }, bearer(a.token));
    expect(both.status).toBe(422);
    expect((await call(null, 'POST', url, { rows: [{ program: 'x', n: 1 }] }, bearer(a.token))).status).toBe(422); // asOf is required
    expect((await call(null, 'POST', url, { ...good, fileBase64: 'AAAA' }, bearer(a.token))).status).toBe(422);
    expect((await call('viewer', 'GET', `/api/evidence/${a.itemId}`)).body.versions).toHaveLength(0);
    expect((await call('viewer', 'GET', `/api/evidence/${a.itemId}/runs`)).body[0].status).toBe('requested');
    expect((await call(null, 'POST', url, good, bearer(a.token))).status).toBe(200);
  });

  it('refuses a file over the evidence size limit, a document sent rows and a dataset sent a file', async () => {
    const a = await waitingRun('Headcount E');
    const url = `/api/bi/v0/runs/${a.run.id}/supply`;
    const huge = await app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(200 * 1024 * 1024), ...bearer(a.token) }, body: JSON.stringify(good) });
    expect(huge.status).toBe(422);
    expect(((await huge.json()) as { issues: { path: string }[] }).issues[0]!.path).toBe('fileBase64');
    const file = await call(null, 'POST', url, { fileBase64: Buffer.from('x').toString('base64'), fileName: 'a.pdf', asOf: '2027-03-01' }, bearer(a.token));
    expect(file.status).toBe(422);
    expect(file.body.issues[0].path).toBe('rows');
    // A document item takes a file.
    const doc = await call('lead', 'POST', '/api/evidence', { title: 'Report', type: 'document', method: 'bi' });
    bi.script = [{ status: 202 }];
    const run = (await call('lead', 'POST', `/api/evidence/${doc.body.id}/runs/now`)).body;
    const token = bi.calls.find((c) => c.body.runId === run.id)!.body.callbackToken;
    const docUrl = `/api/bi/v0/runs/${run.id}/supply`;
    expect((await call(null, 'POST', docUrl, good, bearer(token))).status).toBe(422);
    const sent = await call(null, 'POST', docUrl, { fileBase64: Buffer.from('%PDF-1').toString('base64'), fileName: 'report.pdf', mime: 'application/pdf', asOf: '2027-03-02T10:00:00Z' }, bearer(token));
    expect(sent.status).toBe(200);
    expect((await call('viewer', 'GET', `/api/evidence/${doc.body.id}`)).body.versions[0]).toMatchObject({ fileName: 'report.pdf', size: 6, asOfDate: '2027-03-02' });
  });

  it('answers 401 once the token has expired, and refuses a run that is no longer waiting', async () => {
    const a = await waitingRun('Headcount F');
    const url = `/api/bi/v0/runs/${a.run.id}/supply`;
    await db.su.query(`update evidence_collection_run set callback_expires_at = now() - interval '1 second' where id = $1`, [a.run.id]);
    expect((await call(null, 'POST', url, good, bearer(a.token))).status).toBe(401);
    // A skipped run has no token left.
    const b = await waitingRun('Headcount G');
    expect((await call('lead', 'POST', `/api/collection-runs/${b.run.id}/skip`, { reason: 'not this term' })).status).toBe(200);
    expect((await call(null, 'POST', `/api/bi/v0/runs/${b.run.id}/supply`, good, bearer(b.token))).status).toBe(401);
  });

  it('a failed BI call shows on the run and a person retries it', async () => {
    const d = await call('lead', 'POST', '/api/evidence', { title: 'Retention', type: 'dataset', method: 'bi' });
    await call('lead', 'PUT', `/api/evidence/${d.body.id}/data-definition`, { columns });
    bi.script = [new Error('connection reset')];
    const run = await call('lead', 'POST', `/api/evidence/${d.body.id}/runs/now`);
    expect(run.body).toMatchObject({ status: 'failed', attempts: 1, lastError: 'connection reset' });
    expect(run.body.nextAttemptAt).not.toBeNull();
    bi.script = [{ status: 200, body: { rows: [{ program: 'BSME', n: 3 }], asOf: '2027-03-05' } }];
    const retried = await call('lead', 'POST', `/api/collection-runs/${run.body.id}/retry`);
    expect(retried).toMatchObject({ status: 200, body: { status: 'supplied', versionNo: 1 } });
    // Running again on the same day is refused: the period already has its run.
    expect((await call('lead', 'POST', `/api/evidence/${d.body.id}/runs/now`)).status).toBe(409);
  });
});
