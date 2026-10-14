// Documents and AI import through the five-step chain (TASK-075): scope permissions, upload, the Trash and Undo, a run with the worker
// (fake model), review, one undoable Apply and its Undo and Redo as the X-Undo header says.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createFakeAiModel, handlers, MemoryStore, registerTestTarget, runJob, setAiModelForTests, TEST_TARGET_KIND, testUnitsResponder, unregisterTestTarget,
} from '@ams/core';
import type { JobEnvelope, JobType } from '@ams/shared';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const store = new MemoryStore();
const ids = {} as Record<string, string>;
const sent: (JobEnvelope & { type: JobType })[] = [];
const queue = { send: async (type: JobType, e: JobEnvelope) => { sent.push({ ...e, type }); } };
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
interface Out { status: number; body: any; undo: { label: string; method: string; path: string; body?: unknown } | null; headers: Headers } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: string | null, method: string, path: string, body?: unknown, raw?: { bytes: Uint8Array; type: string }): Promise<Out> {
  const res = await app.request(path, {
    method,
    headers: { ...(who ? { 'x-test-user': `${ids[who]}:${ids.inst}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(raw ? { 'content-type': raw.type } : {}) },
    ...(raw ? { body: raw.bytes as unknown as BodyInit } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  const header = res.headers.get('x-undo');
  const json = res.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : text;
  return { status: res.status, body: json, undo: header ? JSON.parse(decodeURIComponent(header)) : null, headers: res.headers };
}
const applyUndo = (who: string, u: NonNullable<Out['undo']>) => call(who, u.method, u.path, u.body);
async function drain() { while (sent.length) { const { type, ...env } = sent.shift()!; await runJob(pool, type, env, handlers, { store, queue }); } }

// A tiny valid PDF with the text of each page (the same generator the core tests use is not exported; this one is enough).
function pdf(pages: string[]): Uint8Array {
  const enc = new TextEncoder();
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((t, i) => {
    const content = t.split('\n').map((line, n) => `BT /F1 12 Tf 72 ${700 - n * 16} Td (${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`).join('\n');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}
const upload = (who: string, name: string, bytes: Uint8Array, scope = 'scopeKind=org_chart') =>
  call(who, 'POST', `/api/documents/upload?${scope}&fileName=${encodeURIComponent(name)}`, undefined, { bytes, type: 'application/pdf' });

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  registerTestTarget();
  db = await createTestDb('apidocs');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store, queue, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('U') returning id`);
  for (const [n, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer'], ['external', 'external_reviewer']] as const) {
    ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id, expires_at) values ($1, $2, $3, 'institution', $1, ${role === 'external_reviewer' ? "now() + interval '1 day'" : 'null'})`, [ids.inst, ids[n], role]);
  }
}, 30000);
afterEach(() => setAiModelForTests(null));
afterAll(async () => { unregisterTestTarget(); await pool.end(); await db.close(); });

describe('documents API', () => {
  it('is documented, needs a sign-in, and keeps people without the place\'s permission out', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).body as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      '/api/documents', '/api/documents/upload', '/api/documents/{id}', '/api/document-library', '/api/imports', '/api/imports/{id}/apply', '/api/import-proposals/{id}', '/api/import-applies/{id}/undo',
    ]));
    expect((await call(null, 'GET', '/api/documents?scopeKind=org_chart')).status).toBe(401);
    expect((await call('external', 'GET', '/api/documents?scopeKind=org_chart')).status).toBe(403); // an external reviewer reads no uploads
    expect((await call('external', 'GET', '/api/document-library')).status).toBe(403);
    expect((await call('viewer', 'GET', '/api/documents?scopeKind=org_chart')).status).toBe(200);
    expect((await call('viewer', 'GET', '/api/documents?scopeKind=nothing')).status).toBe(400);
    expect((await upload('viewer', 'a.pdf', pdf(['x']))).status).toBe(403);
    expect((await call('viewer', 'POST', '/api/imports', { scopeKind: 'org_chart', targetKind: TEST_TARGET_KIND, documentIds: [crypto.randomUUID()] })).status).toBe(403);
    expect((await call('viewer', 'GET', `/api/imports/preflight?scopeKind=org_chart&targetKind=${TEST_TARGET_KIND}`)).status).toBe(403);
  });

  it('uploads a file (with who and when), lists it, refuses it twice, serves it, reads it, and deletes it to the Trash with an Undo', async () => {
    const bytes = pdf(['Unit: College of Arts (college)\nA page of the list of units with enough words to count.']);
    const up = await upload('lead', 'list.pdf', bytes);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ source: 'import', name: 'list.pdf', status: 'queued', fileKind: 'PDF', uploadedByName: 'lead', hasFile: true });
    expect((await upload('lead', 'again.pdf', bytes)).status).toBe(409);
    expect((await upload('lead', 'empty.pdf', new Uint8Array())).status).toBe(400);
    await drain();
    const list = await call('viewer', 'GET', '/api/documents?scopeKind=org_chart');
    expect(list.body).toMatchObject([{ id: up.body.id, status: 'read', pageCount: 1, statusText: 'Read: 1 page' }]);
    const file = await call('viewer', 'GET', `/api/documents/${up.body.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('content-disposition')).toContain('inline');
    expect((await call('viewer', 'GET', `/api/documents/${up.body.id}/pages`)).body).toMatchObject([{ pageNo: 1, needsOcr: false }]);
    const view = await call('viewer', 'GET', `/api/documents/${up.body.id}/pages/1/view?quote=${encodeURIComponent('Unit: College of Arts (college)')}`);
    expect(view.body).toMatchObject({ page: { pageNo: 1 }, highlight: { start: expect.any(Number) } });
    const lib = await call('viewer', 'GET', '/api/document-library?q=list');
    expect(lib.body).toMatchObject({ total: 1, items: [{ name: 'list.pdf', place: { label: 'Org chart' } }] });
    expect((await call('viewer', 'GET', '/api/document-library?q=nothing')).body.total).toBe(0);

    expect((await call('viewer', 'POST', `/api/documents/${up.body.id}/read`)).status).toBe(403);
    expect((await call('lead', 'POST', `/api/documents/${up.body.id}/read`)).status).toBe(202);
    await drain();
    expect((await call('viewer', 'DELETE', `/api/documents/${up.body.id}`)).status).toBe(403);
    const del = await call('lead', 'DELETE', `/api/documents/${up.body.id}`);
    expect(del.status).toBe(200);
    expect(del.undo).toMatchObject({ method: 'POST', path: expect.stringMatching(/^\/api\/trash\/groups\/.+\/restore$/) });
    expect((await call('viewer', 'GET', '/api/documents?scopeKind=org_chart')).body).toEqual([]);
    expect((await applyUndo('lead', del.undo!)).status).toBe(200);
    expect((await call('viewer', 'GET', '/api/documents?scopeKind=org_chart')).body).toHaveLength(1);
    ids.doc = up.body.id;
  }, 60000);

  it('reports what a person may do in a place', async () => {
    expect((await call('viewer', 'GET', '/api/document-scopes?scopeKind=org_chart')).body).toMatchObject({ canRead: true, canWrite: false, editable: true, label: 'Org chart' });
    expect((await call('lead', 'GET', '/api/document-scopes?scopeKind=org_chart')).body).toMatchObject({ canRead: true, canWrite: true });
  });
});

describe('import API', () => {
  it('runs an import, reviews it and applies it as one undoable group', async () => {
    setAiModelForTests(createFakeAiModel([testUnitsResponder()]).model);
    const targets = await call('viewer', 'GET', '/api/imports/targets?scopeKind=org_chart');
    expect(targets.body).toMatchObject([{ kind: TEST_TARGET_KIND, label: 'Units (test)', itemsLabel: 'units' }]);
    const pre = await call('lead', 'GET', `/api/imports/preflight?scopeKind=org_chart&targetKind=${TEST_TARGET_KIND}`);
    expect(pre.body).toMatchObject({ canStart: true });

    const started = await call('lead', 'POST', '/api/imports', { scopeKind: 'org_chart', targetKind: TEST_TARGET_KIND, documentIds: [ids.doc] });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: 'queued', stage: 'read', targetLabel: 'Units (test)', startedByName: 'lead' });
    expect((await call('lead', 'POST', '/api/imports', { scopeKind: 'org_chart', targetKind: TEST_TARGET_KIND, documentIds: [ids.doc] })).status).toBe(409);
    await drain();
    const run = await call('viewer', 'GET', `/api/imports/${started.body.id}`);
    expect(run.body).toMatchObject({ status: 'succeeded', counts: { total: 1, pending: 1 }, usage: { calls: 1 } });
    expect((await call('viewer', 'GET', `/api/imports?scopeKind=org_chart`)).body.map((r: { id: string }) => r.id)).toEqual([started.body.id]);

    const list = (await call('viewer', 'GET', `/api/imports/${started.body.id}/proposals`)).body;
    const p = list.proposals[0];
    expect(p).toMatchObject({ label: 'College of Arts', status: 'pending', pageNo: 1, quoteVerified: true, documentName: 'list.pdf', payload: { name: 'College of Arts', type: 'college' } });
    const report = await call('viewer', 'GET', `/api/imports/${started.body.id}/report`);
    expect(report.body).toMatchObject({ scopeLabel: 'Org chart', totals: { documents: 1, pages: 1 }, proposals: { total: 1 }, models: { role: 'analysis' } });

    expect((await call('viewer', 'PATCH', `/api/import-proposals/${p.id}`, { payload: { name: 'X', type: 'college' } })).status).toBe(403);
    const bad = await call('lead', 'PATCH', `/api/import-proposals/${p.id}`, { payload: { name: '', type: 'college' } });
    expect(bad.status).toBe(400);
    const edited = await call('lead', 'PATCH', `/api/import-proposals/${p.id}`, { payload: { name: 'College of Arts and Letters', type: 'college', parent: null } });
    expect(edited.body).toMatchObject({ status: 'edited', effective: { name: 'College of Arts and Letters' }, payload: { name: 'College of Arts' } });
    expect((await call('lead', 'POST', `/api/imports/${started.body.id}/proposals/decide`, { ids: [p.id], decision: 'accept' })).body).toEqual({ changed: 0 }); // an edited row already counts as accepted

    expect((await call('viewer', 'GET', `/api/imports/${started.body.id}/apply-preview`)).body).toMatchObject({ count: 1 });
    expect((await call('viewer', 'POST', `/api/imports/${started.body.id}/apply`)).status).toBe(403);
    const applied = await call('lead', 'POST', `/api/imports/${started.body.id}/apply`);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ state: 'applied', applied: 1, skipped: [] });
    expect(applied.undo).toEqual({ label: 'Applied 1 unit to Org chart', method: 'POST', path: `/api/import-applies/${applied.body.applyId}/undo` });
    const units = await call('viewer', 'GET', '/api/org-units');
    expect(units.body.map((u: { nameEn: string; active: boolean }) => [u.nameEn, u.active])).toContainEqual(['College of Arts and Letters', true]);
    expect((await call('lead', 'POST', `/api/imports/${started.body.id}/apply`)).status).toBe(409); // nothing left to apply

    // Undo as the toast would send it; its answer is the Redo, tagged by the chain.
    const undone = await applyUndo('lead', applied.undo!);
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ state: 'undone' });
    expect(undone.undo).toMatchObject({ method: 'POST', path: `/api/import-applies/${applied.body.applyId}/redo` });
    expect((await call('viewer', 'GET', '/api/org-units')).body.find((u: { nameEn: string }) => u.nameEn === 'College of Arts and Letters').active).toBe(false);
    const redone = await applyUndo('lead', undone.undo!);
    expect(redone.body).toMatchObject({ state: 'applied', applied: 1 });
    expect((await call('viewer', 'POST', `/api/import-applies/${applied.body.applyId}/undo`)).status).toBe(403);
  }, 120000);

  it('cancels a run that has not finished', async () => {
    setAiModelForTests(createFakeAiModel([testUnitsResponder()]).model);
    const doc2 = await upload('lead', 'second.pdf', pdf(['Unit: School of Law (school)\nAnother page of enough words to count as a page of text.']));
    const run = await call('lead', 'POST', '/api/imports', { scopeKind: 'org_chart', targetKind: TEST_TARGET_KIND, documentIds: [doc2.body.id] });
    expect((await call('viewer', 'POST', `/api/imports/${run.body.id}/cancel`)).status).toBe(403);
    const c = await call('lead', 'POST', `/api/imports/${run.body.id}/cancel`);
    expect(c.body).toMatchObject({ status: 'cancelled' });
    expect((await call('lead', 'POST', `/api/imports/${run.body.id}/cancel`)).status).toBe(409);
    await drain();
  }, 60000);
});
