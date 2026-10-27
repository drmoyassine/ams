// The AMS as the BI's authorization server (DEC-035, contract 6.2): a person signs in to a listed client with OAuth 2.1 + PKCE and
// the BI verifies the tokens itself against the published keys, reading the person's BI role and data scope from the claims.
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@ams/db/test-db';
import { createApp } from './app.js';
import { createAuth, seedOAuthClients, sessionAuthenticator } from './auth.js';

const APP = 'http://localhost:3000';
const BI = 'https://bi.example.org';
const SECRET = 'bi-app-secret-0123456789abcdefghij';
const CALLBACK = `${BI}/auth/callback`;
const cfg = {
  AUTH_SECRET: 'test-secret-'.repeat(4), APP_URL: APP, OIDC_PROVIDER_ID: 'oidc', BI_OAUTH_AUDIENCE: BI,
  OAUTH_CLIENTS: [
    { id: 'bi-app', name: 'BI', secret: SECRET, redirectUris: [CALLBACK] },
    { id: 'mcp-client', name: 'An MCP client', redirectUris: ['http://localhost:7777/callback'] },
  ],
};

let db: TestDb;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>['app'];
let auth: ReturnType<typeof createAuth>;
const ids: Record<string, string> = {};
const one = async (q: string, p: unknown[]) => (await db.su.query(q, p)).rows[0].id as string;

async function person(email: string, roles: [string, string, string][]) {
  const ctx = await auth.$context;
  const u = await ctx.internalAdapter.createUser({ email, name: email, emailVerified: true }, { method: 'admin' } as never);
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: 'credential', accountId: u.id, password: await ctx.password.hash('a-long-password-1') });
  const id = await one(`insert into app_user (institution_id, auth_user_id, full_name, email) values ($1, $2, $3, $4) returning id`, [ids.inst, u.id, `Full ${email}`, email]);
  for (const [role, type, scope] of roles) {
    await db.su.query(`insert into role_assignment (institution_id, user_id, role, scope_type, scope_id, expires_at) values ($1, $2, $3, $4, $5, $6)`,
      [ids.inst, id, role, type, scope, role === 'external_reviewer' ? new Date(Date.now() + 86_400_000) : null]);
  }
  return { id, authId: u.id };
}

const call = (path: string, init: RequestInit = {}) => app.request(`${APP}${path}`, { redirect: 'manual', ...init });
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

/** The whole sign-in of one person to one client: password sign-in, authorize with PKCE, code for tokens. */
async function signInToBi(email: string, client: { id: string; secret?: string; redirect: string } = { id: 'bi-app', secret: SECRET, redirect: CALLBACK }) {
  const signIn = await call('/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: APP },
    body: JSON.stringify({ email, password: 'a-long-password-1' }),
  });
  expect(signIn.status).toBe(200);
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({
    response_type: 'code', client_id: client.id, redirect_uri: client.redirect, scope: 'openid profile email offline_access', state: 's1',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: BI,
  });
  const az = await call(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie: cookieOf(signIn) } });
  const location = new URL(az.headers.get('location')!);
  const code = location.searchParams.get('code');
  expect(code, location.toString()).toBeTruthy();
  const token = await call('/api/auth/oauth2/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: code!, redirect_uri: client.redirect, client_id: client.id, code_verifier: verifier, resource: BI,
      ...(client.secret ? { client_secret: client.secret } : {}),
    }),
  });
  return { status: token.status, body: await token.json() as Record<string, string> };
}

const keys = async () => createLocalJWKSet(await (await call('/api/auth/jwks')).json());

beforeAll(async () => {
  db = await createTestDb('biid');
  pool = new pg.Pool({ connectionString: db.url });
  auth = createAuth(pool, cfg);
  app = createApp({ pool, authenticate: sessionAuthenticator(auth, pool), authHandler: auth.handler }).app;
  ids.inst = await one(`insert into institution (name_en) values ('Test University') returning id`, []);
  ids.unit = await one(`insert into org_unit (institution_id, type, name_en) values ($1, 'college', 'Engineering') returning id`, [ids.inst]);
  ids.prog = await one(`insert into program (institution_id, org_unit_id, name_en, degree_level) values ($1, $2, 'BSME', 'bachelor') returning id`, [ids.inst, ids.unit]);
  expect(await seedOAuthClients(pool, cfg)).toEqual(['bi-app', 'mcp-client']);
  expect(await seedOAuthClients(pool, cfg)).toEqual(['bi-app', 'mcp-client']); // idempotent
});
afterAll(async () => { await pool.end(); await db.close(); });

describe('discovery and keys', () => {
  it('publishes the issuer metadata under the issuer and at the root, and the signing keys', async () => {
    const meta = await (await call('/api/auth/.well-known/openid-configuration')).json();
    expect(meta).toMatchObject({ issuer: `${APP}/api/auth`, jwks_uri: `${APP}/api/auth/jwks`, code_challenge_methods_supported: ['S256'] });
    const root = await call('/.well-known/oauth-authorization-server/api/auth');
    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({ issuer: `${APP}/api/auth`, token_endpoint: `${APP}/api/auth/oauth2/token` });
    expect((await call('/.well-known/openid-configuration/api/auth')).status).toBe(200);
    expect(((await (await call('/api/auth/jwks')).json()) as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
  });

  it('offers no self-registration', async () => {
    const reg = await call('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example.org/cb'] }) });
    expect(reg.status).not.toBe(200);
    expect(reg.status).not.toBe(201);
  });
});

describe('a person signing in to the BI', () => {
  beforeAll(async () => {
    await person('lead@test.edu', [['lead', 'org_unit', ids.unit!], ['viewer', 'program', ids.prog!]]);
    await person('admin@test.edu', [['admin', 'institution', ids.inst!]]);
    await person('none@test.edu', []);
    await person('external@test.edu', [['external_reviewer', 'program', ids.prog!]]);
  });

  it('gets a short-lived access token for the BI, verifiable with the published keys, with the BI role and scope', async () => {
    const t = await signInToBi('lead@test.edu');
    expect(t.status).toBe(200);
    expect(t.body.refresh_token).toBeTruthy();
    const { payload, protectedHeader } = await jwtVerify(t.body.access_token!, await keys(), { issuer: `${APP}/api/auth`, audience: BI });
    expect(protectedHeader.alg).toBe('EdDSA');
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);
    expect(payload).toMatchObject({
      client_id: 'bi-app', email: 'lead@test.edu', name: 'Full lead@test.edu', ams_institution_id: ids.inst, bi_role: 'steward',
      bi_scope: [{ type: 'org_unit', id: ids.unit, role: 'steward' }, { type: 'program', id: ids.prog, role: 'viewer' }],
    });
    expect(payload.ams_user_id).toMatch(/^[0-9a-f-]{36}$/);
    const idt = await jwtVerify(t.body.id_token!, await keys(), { issuer: `${APP}/api/auth`, audience: 'bi-app' });
    expect(idt.payload).toMatchObject({ bi_role: 'steward', email: 'lead@test.edu', sub: payload.sub });
    const info = await call('/api/auth/oauth2/userinfo', { headers: { authorization: `Bearer ${t.body.access_token}` } });
    expect(await info.json()).toMatchObject({ sub: payload.sub, bi_role: 'steward', email: 'lead@test.edu' });
  });

  it('signs a public client (an MCP client) in with PKCE and no secret', async () => {
    const t = await signInToBi('admin@test.edu', { id: 'mcp-client', redirect: 'http://localhost:7777/callback' });
    expect(t.status).toBe(200);
    const { payload } = await jwtVerify(t.body.access_token!, await keys(), { audience: BI });
    expect(payload).toMatchObject({ client_id: 'mcp-client', bi_role: 'admin', bi_scope: [{ type: 'institution', id: ids.inst, role: 'admin' }] });
  });

  it('refuses a person with no role that grants BI access, and an external reviewer', async () => {
    for (const email of ['none@test.edu', 'external@test.edu']) {
      const t = await signInToBi(email);
      expect(t.status, email).toBe(403);
      expect(t.body.error).toBe('access_denied');
    }
  });

  it('refuses a refresh once the person is disabled in the AMS, and takes the new role on the next refresh', async () => {
    const p = await person('moving@test.edu', [['viewer', 'program', ids.prog!]]);
    const t = await signInToBi('moving@test.edu');
    expect(t.status).toBe(200);
    const refresh = (token: string) => call('/api/auth/oauth2/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: 'bi-app', client_secret: SECRET, resource: BI }),
    });
    await db.su.query(`update role_assignment set role = 'lead', scope_type = 'org_unit', scope_id = $2 where user_id = $1`, [p.id, ids.unit]);
    const r1 = await refresh(t.body.refresh_token!);
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as Record<string, string>;
    expect(b1.refresh_token).toBeTruthy();
    expect(b1.refresh_token).not.toBe(t.body.refresh_token);
    expect((await jwtVerify(b1.access_token!, await keys(), { audience: BI })).payload).toMatchObject({ bi_role: 'steward' });
    await db.su.query(`update app_user set active = false where id = $1`, [p.id]);
    const r2 = await refresh(b1.refresh_token!);
    expect(r2.status).toBe(403);
  });

  it('rotates the refresh token: a used one works no more, and replaying it ends the whole chain', async () => {
    await person('rotate@test.edu', [['viewer', 'program', ids.prog!]]);
    const t = await signInToBi('rotate@test.edu');
    const refresh = (token: string) => call('/api/auth/oauth2/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: 'bi-app', client_secret: SECRET, resource: BI }),
    });
    const r1 = await refresh(t.body.refresh_token!);
    const next = (await r1.json() as Record<string, string>).refresh_token!;
    expect(next).not.toBe(t.body.refresh_token);
    expect((await refresh(t.body.refresh_token!)).status).not.toBe(200);
    expect((await refresh(next)).status).not.toBe(200);
  });

  it('refuses a wrong secret, an unlisted redirect address and an unknown client', async () => {
    const bad = await signInToBi('lead@test.edu', { id: 'bi-app', secret: 'x'.repeat(40), redirect: CALLBACK });
    expect([400, 401]).toContain(bad.status);
    expect(bad.body.error).toBe('invalid_client');
    const signIn = await call('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: APP }, body: JSON.stringify({ email: 'lead@test.edu', password: 'a-long-password-1' }) });
    const q = (client: string, redirect: string) => new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, scope: 'openid', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: BI });
    for (const [client, redirect] of [['bi-app', 'https://evil.example.org/cb'], ['nobody', CALLBACK]] as const) {
      const az = await call(`/api/auth/oauth2/authorize?${q(client, redirect)}`, { headers: { cookie: cookieOf(signIn) } });
      expect(az.headers.get('location') ?? '').not.toContain('evil.example.org');
      expect(az.headers.get('location') ?? '').not.toContain('code=');
    }
  });

  it('sends a person who is not signed in to the AMS sign-in page with the request, signed', async () => {
    const q = new URLSearchParams({ response_type: 'code', client_id: 'bi-app', redirect_uri: CALLBACK, scope: 'openid', state: 's', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: BI });
    const az = await call(`/api/auth/oauth2/authorize?${q}`);
    expect(az.status).toBe(302);
    const to = new URL(az.headers.get('location')!, APP);
    expect(to.pathname).toBe('/login');
    expect(to.searchParams.get('client_id')).toBe('bi-app');
    expect(to.searchParams.get('sig')).toBeTruthy();
  });

  it('disables a client the setting no longer lists', async () => {
    await seedOAuthClients(pool, { ...cfg, OAUTH_CLIENTS: [cfg.OAUTH_CLIENTS[0]!] });
    expect((await db.su.query(`select "disabled" from "oauthClient" where "clientId" = 'mcp-client'`)).rows[0].disabled).toBe(true);
    await seedOAuthClients(pool, cfg);
    expect((await db.su.query(`select "disabled" from "oauthClient" where "clientId" = 'mcp-client'`)).rows[0].disabled).toBe(false);
  });
});
