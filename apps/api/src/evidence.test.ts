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
  for (const n of ['lead', 'viewer', 'nobody']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  for (const [u, role] of [['lead', 'lead'], ['viewer', 'viewer']]) {
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
});
