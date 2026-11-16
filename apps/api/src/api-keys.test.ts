// API keys (DEC-040) over HTTP: an admin issues a key (shown once), another system calls with it as its service user with the key's role,
// a wrong, revoked or expired key is refused with 401, and only an admin manages keys. Programs over the API: one, create, update, delete.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
const ids = {} as Record<string, string>;
const one = async (sql: string, p: unknown[] = []) => (await db.su.query(sql, p)).rows[0].id as string;
async function call(auth: { user?: string; key?: string }, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth.user) headers['x-test-user'] = `${ids[auth.user]}:${ids.inst}`;
  if (auth.key) headers.authorization = `Bearer ${auth.key}`;
  const res = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as any : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeAll(async () => {
  db = await createTestDb('apikeys');
  pool = new pg.Pool({ connectionString: db.url });
  app = createApp({ pool, authenticate: async (req) => { const h = req.headers.get('x-test-user'); if (!h) return null; const [u, i] = h.split(':'); return { userId: u!, institutionId: i! }; } }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Gulf University') returning id`);
  for (const n of ['admin', 'lead']) ids[n] = await one(`insert into app_user (institution_id, full_name, email) values ($1, $2, $2) returning id`, [ids.inst, n]);
  await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id) values ($1, $2, 'admin', 'institution', $1), ($1, $3, 'lead', 'institution', $1)`, [ids.inst, ids.admin, ids.lead]);
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
}, 60000);
afterAll(async () => { await pool.end(); await db.close(); });

describe('API keys', () => {
  it('are issued by an admin only, shown once, and stored only as a hash', async () => {
    expect((await call({ user: 'lead' }, 'POST', '/api/settings/api-keys', { name: 'SIS sync', role: 'lead' })).status).toBe(403);
    const r = await call({ user: 'admin' }, 'POST', '/api/settings/api-keys', { name: 'SIS sync', role: 'lead' });
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^ams_[0-9a-f-]{36}_[A-Za-z0-9_-]{40,}$/);
    expect(r.body.key).toMatchObject({ name: 'SIS sync', role: 'lead', hint: r.body.token.slice(-4), revokedAt: null });
    ids.key = r.body.token; ids.keyId = r.body.key.id;
    const stored = (await db.su.query(`select token_hash from api_key where id = $1`, [ids.keyId])).rows[0].token_hash as string;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(ids.key!.slice(41));
    const list = await call({ user: 'admin' }, 'GET', '/api/settings/api-keys');
    expect(list.body.map((k: { name: string }) => k.name)).toEqual(['SIS sync']);
    expect(JSON.stringify(list.body)).not.toContain(ids.key!);
  });

  it('lets another system call the API as the key\'s service user, within its role, and records the use', async () => {
    const created = await call({ key: ids.key! }, 'POST', '/api/programs', { orgUnitId: ids.unit, nameEn: 'BS Civil Engineering', degreeLevel: 'bachelor', code: 'BS-CE' });
    expect(created.status).toBe(201);
    expect(created.body.missing).toEqual(expect.arrayContaining(['Mission', 'PEOs', 'PLOs'])); // saved and flagged, not refused
    const id = created.body.id as string;
    expect((await call({ key: ids.key! }, 'GET', `/api/programs/${id}`)).body).toMatchObject({ nameEn: 'BS Civil Engineering', code: 'BS-CE' });
    expect((await call({ key: ids.key! }, 'PATCH', `/api/programs/${id}`, { mission: 'To educate civil engineers.', contactHours: 2000, mode: 'on_campus' })).body).toMatchObject({ contactHours: 2000, mode: 'on_campus' });
    expect((await call({ key: ids.key! }, 'DELETE', `/api/programs/${id}`)).body).toMatchObject({ active: false });
    // The audit trail names the key's service user; its last use is recorded.
    const actor = (await db.su.query(`select u.full_name from audit_event a join app_user u on u.id = a.actor_id where a.target_type = 'program' order by a.at desc limit 1`)).rows[0];
    expect(actor?.full_name).toBe('API key: SIS sync');
    expect((await db.su.query(`select last_used_at from api_key where id = $1`, [ids.keyId])).rows[0].last_used_at).not.toBeNull();
    // Within its role: a lead key cannot manage keys.
    expect((await call({ key: ids.key! }, 'GET', '/api/settings/api-keys')).status).toBe(403);
  });

  it('refuses a wrong, revoked or expired key with 401 and no fallback to a session', async () => {
    expect((await call({ key: `${ids.key!.slice(0, -4)}AAAA` }, 'GET', '/api/programs')).status).toBe(401);
    expect((await call({ user: 'admin', key: `${ids.key!.slice(0, -4)}AAAA` }, 'GET', '/api/programs')).status).toBe(401);
    expect((await call({ user: 'admin' }, 'POST', `/api/settings/api-keys/${ids.keyId}/revoke`)).body.revokedAt).not.toBeNull();
    expect((await call({ key: ids.key! }, 'GET', '/api/programs')).status).toBe(401);
    const viewer = (await call({ user: 'admin' }, 'POST', '/api/settings/api-keys', { name: 'Reporting', role: 'viewer', expiresAt: '2999-01-01' })).body;
    expect((await call({ key: viewer.token }, 'GET', '/api/programs')).status).toBe(200);
    expect((await call({ key: viewer.token }, 'POST', '/api/programs', { orgUnitId: ids.unit, nameEn: 'X', degreeLevel: 'bachelor' })).status).toBe(403);
    await db.su.query(`update api_key set expires_at = now() - interval '1 minute' where id = $1`, [viewer.key.id]);
    expect((await call({ key: viewer.token }, 'GET', '/api/programs')).status).toBe(401);
    expect((await call({ user: 'admin' }, 'POST', '/api/settings/api-keys', { name: 'Old', role: 'viewer', expiresAt: '2001-01-01' })).status).toBe(400);
  });
});
