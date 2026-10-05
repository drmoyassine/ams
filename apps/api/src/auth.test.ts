import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';
import { createAuth, sessionAuthenticator } from './auth.js';
import { seedAdmin } from './seed.js';

const cfg = {
  AUTH_SECRET: 'test-secret-'.repeat(4), APP_URL: 'http://localhost:3000',
  OIDC_PROVIDER_ID: 'oidc',
} as const;
const seedEnv = { INSTITUTION_NAME: 'Test University', ADMIN_EMAIL: 'admin@test.edu', ADMIN_PASSWORD: 'correct horse battery' };

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
let auth: ReturnType<typeof createAuth>;

const signIn = (email: string, password: string) => app.request('/api/auth/sign-in/email', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: cfg.APP_URL },
  body: JSON.stringify({ email, password }),
});
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

beforeAll(async () => {
  db = await createTestDb('auth');
  pool = new pg.Pool({ connectionString: db.url });
  auth = createAuth(pool, cfg);
  app = createApp({ pool, authenticate: sessionAuthenticator(auth, pool), authHandler: auth.handler }).app;
});
afterAll(async () => { await pool.end(); await db.close(); });

describe('OIDC wiring', () => {
  let idp: Server;
  let issuer: string;
  beforeAll(async () => {
    idp = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/userinfo`,
      }));
    });
    await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
    issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => idp.close(r)));

  const signIn = async (extra: object) => {
    const a = createAuth(pool, { ...cfg, ...extra });
    const res = await a.handler(new Request(`${cfg.APP_URL}/api/auth/sign-in/social`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: cfg.APP_URL },
      body: JSON.stringify({ provider: 'oidc', callbackURL: '/' }),
    }));
    return { status: res.status, body: await res.text() };
  };

  it('offers OIDC sign-in only when it is configured, redirecting to the issuer discovered from its metadata', async () => {
    expect((await signIn({})).status).toBe(404);
    const ok = await signIn({
      OIDC_DISCOVERY_URL: `${issuer}/.well-known/openid-configuration`, OIDC_CLIENT_ID: 'client', OIDC_CLIENT_SECRET: 'secret',
    });
    expect(ok.status).toBe(200);
    const { url } = JSON.parse(ok.body) as { url: string };
    expect(url.startsWith(`${issuer}/authorize?`)).toBe(true);
    expect(url).toContain('client_id=client');
    expect(decodeURIComponent(url)).toContain(`${cfg.APP_URL}/api/auth/callback/oidc`);
  });
});

describe('authentication', () => {
  it('seeds the institution and admin once', async () => {
    expect(await seedAdmin(pool, auth, seedEnv)).toBe(true);
    expect(await seedAdmin(pool, auth, seedEnv)).toBe(false);
    const { rows } = await db.su.query(`select r.role, r.scope_type from role_assignment r join app_user u on u.id = r.user_id`);
    expect(rows).toEqual([{ role: 'admin', scope_type: 'institution' }]);
  });

  it('does nothing without ADMIN_* variables', async () => {
    expect(await seedAdmin(pool, auth, {})).toBe(false);
  });

  it('signs in with a password and reaches a protected route with the session cookie', async () => {
    expect((await app.request('/api/programs')).status).toBe(401);
    const res = await signIn(seedEnv.ADMIN_EMAIL, seedEnv.ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    const programs = await app.request('/api/programs', { headers: { cookie: cookieOf(res) } });
    expect(programs.status).toBe(200);
  });

  it('rejects a wrong password', async () => {
    expect((await signIn(seedEnv.ADMIN_EMAIL, 'definitely wrong password')).status).toBe(401);
  });

  it('has no self sign-up', async () => {
    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: cfg.APP_URL },
      body: JSON.stringify({ email: 'new@test.edu', password: 'another long password', name: 'New' }),
    });
    expect(res.ok).toBe(false);
  });

  it('a valid login without an app_user gets no access', async () => {
    const ctx = await auth.$context;
    const u = await ctx.internalAdapter.createUser({ email: 'stranger@test.edu', name: 'S', emailVerified: false }, { method: 'admin' });
    await ctx.internalAdapter.linkAccount({
      userId: u.id, providerId: 'credential', accountId: u.id, password: await ctx.password.hash('stranger password 1'),
    });
    const res = await signIn('stranger@test.edu', 'stranger password 1');
    expect(res.status).toBe(200);
    expect((await app.request('/api/programs', { headers: { cookie: cookieOf(res) } })).status).toBe(401);
  });

  it('links a verified-email login to the pre-created app_user (first SSO sign-in)', async () => {
    const { rows: [i] } = await db.su.query(`select id from institution`);
    await db.su.query(
      `insert into app_user (institution_id, full_name, email) values ($1, 'Pre', 'pre@test.edu')`, [i.id]);
    const ctx = await auth.$context;
    const u = await ctx.internalAdapter.createUser({ email: 'pre@test.edu', name: 'Pre', emailVerified: true }, { method: 'admin' });
    await ctx.internalAdapter.linkAccount({
      userId: u.id, providerId: 'credential', accountId: u.id, password: await ctx.password.hash('pre user password'),
    });
    const res = await signIn('pre@test.edu', 'pre user password');
    expect((await app.request('/api/programs', { headers: { cookie: cookieOf(res) } })).status).toBe(403); // known user, no role yet
    const { rows } = await db.su.query(`select auth_user_id from app_user where email = 'pre@test.edu'`);
    expect(rows[0].auth_user_id).toBe(u.id);
  });

  it('application roles cannot read credentials', async () => {
    await expect(db.as({ userId: '', institutionId: '' }, (c) => c.query(`select password from account`)))
      .rejects.toThrow(/permission denied/);
  });
});
