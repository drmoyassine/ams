---
title: 'The AMS signs people in to the BI: OAuth 2.1 + OIDC issuer with BI role and data scope claims'
description: >-
  The AMS is the BI's authorization server (DEC-035): discovery and JWKS, authorization code with PKCE for the clients
  listed in OAUTH_CLIENTS, 10-minute access tokens for BI_OAUTH_AUDIENCE carrying bi_role and bi_scope derived from role
  assignments, refusal of people without BI access, refresh rotation, and the sign-in page continuing a client's request
status: completed
priority: P1
id: TASK-109
last_updated: '2026-10-27'
generated:
  by: agent/claude-code
  at: '2026-10-27T07:02:29.928Z'
roadmap_item:
  id: ROADMAP-011
  name: 'M9 — P1: governed-metric adapter'
  url: /ROADMAP.md#ROADMAP-011
related_decisions:
  - id: DEC-035
    name: >-
      The AMS is the BI's authorization server: OAuth 2.1 with PKCE and OpenID Connect, tokens verified by the BI with
      published keys, carrying a BI role and data scope derived from AMS role assignments
    url: /DECISIONS.md#DEC-035
modified:
  by: agent/claude-code
  at: '2026-10-27T07:02:29.928Z'
---
# TASK-109 — The AMS signs people in to the BI: OAuth 2.1 + OIDC issuer with BI role and data scope claims

Requested by the BI (drmoyassine/ai-native-bi#10, AMS issue 3). Built 2026-10-27:
- **Issuer** (`apps/api/src/auth.ts`): Better Auth's `jwt` and `@better-auth/oauth-provider` plugins, on only when `BI_OAUTH_AUDIENCE` is set. Discovery under `/api/auth` and at the root (`/.well-known/oauth-authorization-server/api/auth`, `/.well-known/openid-configuration/api/auth`), JWKS at `/api/auth/jwks` (EdDSA).
- **Clients** from `OAUTH_CLIENTS` only (`seedOAuthClients` at start-up: created or updated, linked to the BI resource, the ones no longer listed disabled); PKCE for all, no dynamic registration, no consent screen.
- **Claims**: `ams_user_id`, `ams_institution_id`, `email`, `name`, `bi_role`, `bi_scope`, read at every token and refresh through `app_bi_principal` (migration 0069, SECURITY DEFINER) and mapped by `packages/core/src/bi-identity` (`biAccessOf`). No BI access, inactive or unknown: 403 `access_denied`.
- **Sign-in page**: after signing in, a request that came from a client goes back to the issuer (`apps/web/src/lib/oauth-continue.ts`).
- Tests: `apps/api/src/bi-identity.test.ts` (discovery, the whole flow for a confidential and a public client, verification with the published keys, refusals, refresh rotation and replay, deprovisioning and role change at refresh, wrong secret and redirect, the sign-in redirect, disabling an unlisted client), `packages/core/src/bi-identity/access.test.ts`, `oauth-continue.test.ts`, the config tests.

Not built: dynamic registration with a consent screen, an explicit BI role, an audit event per sign-in, the org chart read for the BI (contract open question 6).
