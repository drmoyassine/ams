import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import type pg from 'pg';
import { linkIdentity, resolveIdentity } from '@ams/db';
import type { Env } from '@ams/shared';
import type { Authenticator } from './chain.js';

export type AuthConfig = Pick<
  Env,
  'AUTH_SECRET' | 'APP_URL' | 'OIDC_DISCOVERY_URL' | 'OIDC_CLIENT_ID' | 'OIDC_CLIENT_SECRET' | 'OIDC_PROVIDER_ID'
>;

/** Better Auth on the shared PostgreSQL pool: email + password always, generic OIDC when configured. */
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
  return betterAuth({
    database: pool,
    secret: cfg.AUTH_SECRET,
    baseURL: cfg.APP_URL,
    // Accounts are created by administrators (or the seed), never by self sign-up.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    plugins: oidc,
  });
}
export type Auth = ReturnType<typeof createAuth>;

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
