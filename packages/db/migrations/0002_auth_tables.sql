-- The login role used by the API and worker must be able to SET ROLE to the restricted application roles.
GRANT ams_app, ams_worker TO CURRENT_USER;
--> statement-breakpoint
-- Better Auth core tables (schema produced by better-auth's own migration compiler for the password +
-- generic OAuth/OIDC configuration). Authentication runs before any identity exists, so these tables sit outside
-- tenant RLS and the application roles get no privileges on them (credentials are unreachable from ams_app/ams_worker).
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);
--> statement-breakpoint
create table "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
--> statement-breakpoint
create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);
--> statement-breakpoint
create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);
--> statement-breakpoint
create index "session_userId_idx" on "session" ("userId");
--> statement-breakpoint
create index "account_userId_idx" on "account" ("userId");
--> statement-breakpoint
create index "verification_identifier_idx" on "verification" ("identifier");
--> statement-breakpoint

-- Maps an authenticated Better Auth user to the AMS identity (step 1 of the middleware chain). Returns nothing for
-- unknown or deactivated users: signing in does not provision access, an administrator must create the app_user.
CREATE FUNCTION app_resolve_identity(p_auth_user_id text)
RETURNS TABLE (user_id uuid, institution_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT id, institution_id FROM app_user WHERE auth_user_id = p_auth_user_id AND active $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_identity(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_identity(text) TO ams_app;

--> statement-breakpoint
-- First SSO sign-in: attach the Better Auth user to the pre-created app_user with the same verified email.
CREATE FUNCTION app_link_identity(p_auth_user_id text, p_email text)
RETURNS TABLE (user_id uuid, institution_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE app_user SET auth_user_id = p_auth_user_id
  WHERE auth_user_id IS NULL AND active AND lower(email) = lower(p_email)
  RETURNING id, institution_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_link_identity(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_link_identity(text, text) TO ams_app;
