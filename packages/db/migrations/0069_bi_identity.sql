-- The AMS as the BI's authorization server (DEC-035, docs/ams-bi-contract-v0.md 6.2).
-- 1. The tables of Better Auth's jwt (signing keys) and oauth-provider plugins, as its own migration compiler produces them for
--    @better-auth/oauth-provider 1.7.7. Like the core auth tables (0002) they sit outside tenant RLS and the application roles get
--    no privileges on them: keys, client secrets and tokens are unreachable from ams_app and ams_worker.
create table "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text);
--> statement-breakpoint
create table "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" text references "user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb);
--> statement-breakpoint
create table "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);
--> statement-breakpoint
create table "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);
--> statement-breakpoint
create table "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);
--> statement-breakpoint
create table "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);
--> statement-breakpoint
create table "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);
--> statement-breakpoint
create table "oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null);
--> statement-breakpoint
create index "oauthClient_userId_idx" on "oauthClient" ("userId");
--> statement-breakpoint
create index "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");
--> statement-breakpoint
create index "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");
--> statement-breakpoint
create index "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");
--> statement-breakpoint
create index "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");
--> statement-breakpoint
create index "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");
--> statement-breakpoint
create index "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");
--> statement-breakpoint
create index "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");
--> statement-breakpoint
create index "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");
--> statement-breakpoint
create index "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");
--> statement-breakpoint
create index "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");
--> statement-breakpoint
create index "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");
--> statement-breakpoint
create index "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");
--> statement-breakpoint
create index "oauthConsent_userId_idx" on "oauthConsent" ("userId");
--> statement-breakpoint
create unique index "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");
--> statement-breakpoint

-- 2. A person's BI access, read before any identity exists (the token issuer runs inside authentication). One row per active,
--    unexpired role assignment of an active user, an engagement assignment resolved to the engagement's subject (the institution
--    or a program); one row with a null role when the user has none. The mapping to BI roles is in packages/core (bi-identity).
CREATE FUNCTION app_bi_principal(p_auth_user_id text)
RETURNS TABLE (user_id uuid, institution_id uuid, email text, full_name text, role text, scope_type text, scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.institution_id, u.email, u.full_name, ra.role,
         CASE WHEN ra.scope_type = 'engagement' THEN e.subject_type ELSE ra.scope_type END,
         CASE WHEN ra.scope_type = 'engagement' THEN e.subject_id ELSE ra.scope_id END
  FROM app_user u
  LEFT JOIN role_assignment ra ON ra.user_id = u.id AND ra.institution_id = u.institution_id
    AND (ra.expires_at IS NULL OR ra.expires_at > now())
  LEFT JOIN engagement e ON ra.scope_type = 'engagement' AND e.id = ra.scope_id AND e.institution_id = u.institution_id
  WHERE u.auth_user_id = p_auth_user_id AND u.active
    AND (ra.id IS NULL OR ra.scope_type <> 'engagement' OR e.id IS NOT NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_bi_principal(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_bi_principal(text) TO ams_app;
