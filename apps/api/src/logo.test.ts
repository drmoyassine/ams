// Accreditor logos over HTTP: the image is the request body, comes back with its type, and only editors may change it.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const as = (who: string) => ({ 'x-test-user': `${ids[who]}:${ids.inst}` });
const PNG: Uint8Array<ArrayBuffer> = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

beforeAll(async () => {
  db = await createTestDb('apilogo');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, store: new MemoryStore(), authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['lead', 'viewer']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['lead', 'lead'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  ids.acc = await one(`insert into accreditor (institution_id, name, short_name, type) values ($1, 'Test Accreditor', 'TA', 'institutional') returning id`, [ids.inst]);
  await db.su.query(`insert into framework (institution_id, accreditor_id, name, scope) values ($1, $2, 'Test Standard', 'institution')`, [ids.inst, ids.acc]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('accreditor logo API', () => {
  it('is uploaded as the body, served with its type, and listed with a version', async () => {
    const put = (who: string, body: Uint8Array<ArrayBuffer>) => app.request(`/api/accreditors/${ids.acc}/logo`, { method: 'PUT', headers: { ...as(who), 'content-type': 'image/png' }, body });
    expect((await put('viewer', PNG)).status).toBe(403);
    expect((await put('lead', new TextEncoder().encode('<svg/>'))).status).toBe(400);
    expect((await put('lead', PNG)).status).toBe(204);
    const got = await app.request(`/api/accreditors/${ids.acc}/logo`, { headers: as('viewer') });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    const list = await (await app.request('/api/frameworks', { headers: as('viewer') })).json() as { accreditorName: string; logoVersion: string | null; versions: unknown[] }[];
    expect(list[0]).toMatchObject({ accreditorName: 'Test Accreditor', versions: [] });
    expect(list[0]!.logoVersion).toMatch(/^\d+$/);
    expect((await app.request(`/api/accreditors/${ids.acc}/logo`, { method: 'DELETE', headers: as('lead') })).status).toBe(204);
    expect((await app.request(`/api/accreditors/${ids.acc}/logo`, { headers: as('viewer') })).status).toBe(404);
  });
});
