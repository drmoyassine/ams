import { createHash } from 'node:crypto';
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import { genericOAuth, jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import type pg from 'pg';
import { biAccessOf, type BiAssignment } from '@ams/core';
import { linkIdentity, resolveBiPrincipal, resolveIdentity } from '@ams/db';
import { BI_CLAIMS, ROLES, type Env, type OAuthClientConfig, type Role } from '@ams/shared';
import type { Authenticator } from './chain.js';

export type AuthConfig = Pick<
  Env,
  'AUTH_SECRET' | 'APP_URL' | 'OIDC_DISCOVERY_URL' | 'OIDC_CLIENT_ID' | 'OIDC_CLIENT_SECRET' | 'OIDC_PROVIDER_ID'
> & Partial<Pick<Env, 'BI_OAUTH_AUDIENCE' | 'OAUTH_CLIENTS'>>;

/** Token lifetimes of the BI's sign-in (contract 6.2), in seconds. */
export const BI_TOKEN_TTL = { access: 600, id: 3600, refresh: 30 * 24 * 3600 } as const;

const SCOPE_TYPES = new Set(['institution', 'org_unit', 'program']);

/**
 * The claims every token for the BI carries (DEC-035): the AMS user, institution, BI role and data scope, read fresh for each token
 * (and each refresh). A person who is unknown, inactive or has no role that grants BI access gets no token: refusing here is how a
 * person disabled in the AMS loses the BI at their next token.
 */
async function biClaims(pool: pg.Pool, authUserId: string | undefined) {
  const principal = authUserId ? await resolveBiPrincipal(pool, authUserId) : null;
  const assignments = (principal?.assignments ?? [])
    .filter((a): a is BiAssignment => (ROLES as readonly string[]).includes(a.role) && SCOPE_TYPES.has(a.scopeType))
    .map((a) => ({ role: a.role as Role, scopeType: a.scopeType, scopeId: a.scopeId }));
  const access = principal ? biAccessOf(assignments) : null;
  if (!principal || !access) {
    throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: 'this person has no access to the BI in the AMS' });
  }
  return {
    [BI_CLAIMS.userId]: principal.userId, [BI_CLAIMS.institutionId]: principal.institutionId,
    [BI_CLAIMS.role]: access.role, [BI_CLAIMS.scope]: access.scope,
    email: principal.email, name: principal.fullName,
  };
}

/** Better Auth on the shared PostgreSQL pool: email + password always, generic OIDC when configured, the BI's issuer when configured. */
export function createAuth(pool: pg.Pool, cfg: AuthConfig) {
  const oidc = cfg.OIDC_DISCOVERY_URL && cfg.OIDC_CLIENT_ID && cfg.OIDC_CLIENT_SECRET
    ? [genericOAuth({
      config: [{
        providerId: cfg.OIDC_PROVIDER_ID,
        discoveryUrl: cfg.OIDC_DISCOVERY_URL,
        clientId: cfg.OIDC_CLIENT_ID,
        clientSecret: cfg.OIDC_CLIENT_SECRET,
        scopes: ['openid', 'profile', 'email'],
      }],
    })]
    : [];
  // The AMS as the BI's authorization server (DEC-035, contract 6.2): OAuth 2.1 with PKCE and OpenID Connect, tokens signed with the
  // keys published at /api/auth/jwks. Only the clients of OAUTH_CLIENTS exist (seedOAuthClients); none needs a consent screen
  // because an administrator listed it, and nobody can register one.
  const issuer = cfg.BI_OAUTH_AUDIENCE
    ? [jwt(), oauthProvider({
      loginPage: '/login',
      consentPage: '/login',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      resources: [{ identifier: cfg.BI_OAUTH_AUDIENCE, name: 'BI', accessTokenTtl: BI_TOKEN_TTL.access, refreshTokenTtl: BI_TOKEN_TTL.refresh }],
      accessTokenExpiresIn: BI_TOKEN_TTL.access,
      idTokenExpiresIn: BI_TOKEN_TTL.id,
      refreshTokenExpiresIn: BI_TOKEN_TTL.refresh,
      allowDynamicClientRegistration: false,
      customAccessTokenClaims: ({ user }) => biClaims(pool, user?.id),
      customIdTokenClaims: ({ user }) => biClaims(pool, user.id),
      customUserInfoClaims: ({ user }) => biClaims(pool, user.id),
    })]
    : [];
  return betterAuth({
    database: pool,
    secret: cfg.AUTH_SECRET,
    baseURL: cfg.APP_URL,
    // Accounts are created by administrators (or the seed), never by self sign-up.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    plugins: [...oidc, ...issuer] as BetterAuthPlugin[],
  });
}
export type Auth = ReturnType<typeof createAuth>;

/** The way the oauth-provider plugin stores a client secret (SHA-256, base64url without padding): only the hash is kept. */
const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('base64url');

/**
 * Makes the oauth-provider's clients match OAUTH_CLIENTS (startup, idempotent): each listed client is created or updated and linked
 * to the BI's resource; a client this setting created earlier and no longer lists is disabled. Auth tables sit outside tenant RLS
 * (migrations 0002, 0069) and are written by the auth layer only, as here.
 */
export async function seedOAuthClients(pool: pg.Pool, cfg: Pick<AuthConfig, 'BI_OAUTH_AUDIENCE' | 'OAUTH_CLIENTS'>): Promise<string[]> {
  if (!cfg.BI_OAUTH_AUDIENCE) return [];
  const clients: OAuthClientConfig[] = cfg.OAUTH_CLIENTS ?? [];
  const audience = cfg.BI_OAUTH_AUDIENCE;
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query(
      `insert into "oauthResource" ("id", "identifier", "name", "accessTokenTtl", "refreshTokenTtl", "disabled", "createdAt", "updatedAt")
       values ($1, $2, 'BI', $3, $4, false, now(), now())
       on conflict ("identifier") do update set "accessTokenTtl" = excluded."accessTokenTtl", "refreshTokenTtl" = excluded."refreshTokenTtl", "disabled" = false, "updatedAt" = now()`,
      [`config:${audience}`, audience, BI_TOKEN_TTL.access, BI_TOKEN_TTL.refresh]);
    for (const c of clients) {
      await db.query(
        `insert into "oauthClient" ("id", "clientId", "clientSecret", "name", "redirectUris", "tokenEndpointAuthMethod", "grantTypes",
           "responseTypes", "requirePKCE", "skipConsent", "scopes", "disabled", "metadata", "createdAt", "updatedAt")
         values ($1, $2, $3, $4, $5, $6, '["authorization_code","refresh_token"]', '["code"]', true, true,
           '["openid","profile","email","offline_access"]', false, '{"source":"OAUTH_CLIENTS"}', now(), now())
         on conflict ("clientId") do update set "clientSecret" = excluded."clientSecret", "name" = excluded."name",
           "redirectUris" = excluded."redirectUris", "tokenEndpointAuthMethod" = excluded."tokenEndpointAuthMethod",
           "grantTypes" = excluded."grantTypes", "responseTypes" = excluded."responseTypes", "requirePKCE" = true, "skipConsent" = true,
           "scopes" = excluded."scopes", "disabled" = false, "metadata" = excluded."metadata", "updatedAt" = now()`,
        [`config:${c.id}`, c.id, c.secret ? hashSecret(c.secret) : null, c.name, JSON.stringify(c.redirectUris), c.secret ? 'client_secret_post' : 'none']);
      await db.query(
        `insert into "oauthClientResource" ("id", "clientId", "resourceId", "createdAt") values ($1, $2, $3, now())
         on conflict ("clientId", "resourceId") do nothing`, [`config:${c.id}:${audience}`, c.id, audience]);
    }
    await db.query(
      `update "oauthClient" set "disabled" = true, "updatedAt" = now()
       where "metadata"->>'source' = 'OAUTH_CLIENTS' and not ("clientId" = any($1::text[]))`, [clients.map((c) => c.id)]);
    await db.query('commit');
    return clients.map((c) => c.id);
  } catch (e) {
    await db.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    db.release();
  }
}

/**
 * Step 1 of the chain. A valid Better Auth session is not enough: the user must also map to an active app_user
 * (provisioned by an administrator). A first SSO sign-in is linked by verified email address.
 */
export function sessionAuthenticator(auth: Auth, pool: pg.Pool): Authenticator {
  return async (req) => {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return null;
    const found = await resolveIdentity(pool, session.user.id);
    if (found) return found;
    return session.user.emailVerified ? linkIdentity(pool, session.user.id, session.user.email) : null;
  };
}
