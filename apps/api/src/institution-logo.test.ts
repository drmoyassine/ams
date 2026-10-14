// The institution logo over HTTP, and the one public read: the sign-in page's branding. Only an administrator changes the
// logo, anyone who can read the organization sees it, and without signing in nothing but the display name, the accent
// colour and the logo is served.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '@ams/core';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let store: MemoryStore;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
const as = (who: string) => ({ 'x-test-user': `${ids[who]}:${ids.inst}` });
const bytes = (...head: number[]): Uint8Array<ArrayBuffer> => Uint8Array.from([...head, 9, 9]);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const put = (who: string, body: Uint8Array<ArrayBuffer>) => app.request('/api/institution/logo', { method: 'PUT', headers: { ...as(who), 'content-type': 'image/png' }, body });

beforeAll(async () => {
  db = await createTestDb('instlogo');
  pool = new pg.Pool({ connectionString: db.url });
  store = new MemoryStore();
  app = createApp({ pool, store, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en, name_ar, default_locale, accent_color, country) values ('Gulf University', 'جامعة الخليج', 'en', '#1f3b66', 'Qatar') returning id`);
  for (const n of ['admin', 'lead', 'viewer', 'ext']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2 || '@x.org') returning id`, [ids.inst, n]);
  for (const [u, role] of [['admin', 'admin'], ['lead', 'lead'], ['viewer', 'viewer']]) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, $3, 'institution', $1)`, [ids.inst, ids[u!], role]);
  }
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id, expires_at) values ($1, $2, 'external_reviewer', 'institution', $1, now() + interval '1 day')`, [ids.inst, ids.ext]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('institution logo API', () => {
  it('is public to nobody and read-only for everyone but an administrator', async () => {
    expect((await app.request('/api/institution/logo')).status).toBe(401);
    expect((await app.request('/api/institution/logo', { method: 'PUT', body: PNG })).status).toBe(401);
    expect((await put('lead', PNG)).status).toBe(403);
    expect((await put('viewer', PNG)).status).toBe(403);
    expect((await app.request('/api/institution/logo', { method: 'DELETE', headers: as('lead') })).status).toBe(403);
    expect((await app.request('/api/institution/logo', { headers: as('ext') })).status).toBe(403); // no org:read
    expect((await app.request('/api/institution/logo', { headers: as('viewer') })).status).toBe(404); // none yet
  });

  it('refuses SVG, a lie about the type, an empty file and a big file, and keeps the old logo', async () => {
    expect((await put('admin', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status).toBe(400);
    expect((await put('admin', new Uint8Array(0))).status).toBe(400);
    expect((await put('admin', new Uint8Array(513 * 1024))).status).toBe(400);
    expect(store.objects.size).toBe(0);
  });

  it('stores, serves with its type and cache headers, versions it, replaces the old file and removes it', async () => {
    expect((await put('admin', PNG)).status).toBe(204);
    const got = await app.request('/api/institution/logo', { headers: as('viewer') });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('cache-control')).toContain('max-age');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    const inst = await (await app.request('/api/institution', { headers: as('viewer') })).json() as { logoVersion: string | null };
    expect(inst.logoVersion).toMatch(/^\d+$/);
    expect(store.objects.size).toBe(1);
    // A JPEG sent as image/png is stored as what the bytes are; the old object is deleted.
    await new Promise((r) => setTimeout(r, 5));
    expect((await put('admin', JPEG)).status).toBe(204);
    expect(store.objects.size).toBe(1);
    expect((await app.request('/api/institution/logo', { headers: as('viewer') })).headers.get('content-type')).toBe('image/jpeg');
    const v2 = (await (await app.request('/api/institution', { headers: as('viewer') })).json() as { logoVersion: string }).logoVersion;
    expect(v2).not.toBe(inst.logoVersion);
  });

  it('serves nothing but the display name, accent colour and logo without signing in', async () => {
    const res = await app.request('/api/public/branding');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['accentColor', 'logoUrl', 'name']);
    expect(body.name).toBe('Gulf University');
    expect(body.accentColor).toBe('#1f3b66');
    expect(body.logoUrl).toMatch(/^\/api\/public\/branding\/logo\?v=\d+$/);
    expect(JSON.stringify(body)).not.toContain(ids.inst!);
    expect(JSON.stringify(body)).not.toContain('Qatar');
    const logo = await app.request(String(body.logoUrl));
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(JPEG);
    // No listing or other metadata: nothing else under /api/public.
    expect((await app.request('/api/public')).status).toBe(404);
    expect((await app.request('/api/public/institution')).status).toBe(404);
  });

  it('shows the Arabic name when Arabic is the default language, and nothing once the logo is removed', async () => {
    await db.su.query(`update institution set secondary_language = 'ar', default_locale = 'ar'`);
    expect((await (await app.request('/api/public/branding')).json() as { name: string }).name).toBe('جامعة الخليج');
    expect((await app.request('/api/institution/logo', { method: 'DELETE', headers: as('admin') })).status).toBe(204);
    expect(store.objects.size).toBe(0);
    expect((await app.request('/api/institution/logo', { headers: as('viewer') })).status).toBe(404);
    expect((await app.request('/api/public/branding/logo')).status).toBe(404);
    expect((await (await app.request('/api/public/branding')).json() as { logoUrl: string | null }).logoUrl).toBeNull();
  });

  it('shows nothing when the deployment has more than one institution (never a guess)', async () => {
    await db.su.query(`insert into institution (name_en) values ('Another University')`);
    expect(await (await app.request('/api/public/branding')).json()).toEqual({ name: null, accentColor: null, logoUrl: null });
    expect((await app.request('/api/public/branding/logo')).status).toBe(404);
  });
});
