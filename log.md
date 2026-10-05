---
okf_version: "0.2"
title: "AMS — Accreditation Management System Log"
generated:
  by: "process:vef-init"
  at: "2026-10-05T07:51:04.640Z"
---

# Log

Chronological log of decisions, discoveries, and session learnings. This is the **single-source memory** — durable context that survives across sessions. Newest entries first.

> **OKF reserved filename.** `log.md` follows the [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) convention. It links to DECISIONS.md; decisions remain the canonical record.

---

## 2026-10-05 — First deploy to Easypanel

Deployed `compose.yaml` (branch `claude/check-and-proceed-i4izas`) as Compose service `management/ams` on the owner's Easypanel (Easypanel would not create a new project: project limit; owner chose `management`). Source is the private repo over an SSH deploy key (`easypanel-ams`, read-only). Domain `ams-app.4ky7uo.easypanel.host` -> compose service `app`, port 3000. Env (generated secrets, `APP_URL`, seeded admin `admin@ams.local`) lives only in the Easypanel service. Containers `app`, `worker`, `postgres`, `garage` were running; `garage-init` completed (the app depends on it). CI run 10 (compose-smoke) is green on Docker, including login and the protected route.

Notes: the Easypanel MCP `deployComposeService` call times out client-side at 60 s while the build continues; check containers afterwards. `listProjectsAndServices` returns every service's env vars (secrets) — avoid it. The public URL was not reachable from the build sandbox (egress proxy), so end-to-end on the live URL is owner-verified.

---

## 2026-10-05 — M0 complete (ROADMAP-001)

All ten M0 tasks are done. The three done-when tests live in `apps/api/src/m0-acceptance.test.ts` (program-scoped isolation through the API and SQL; a route without `requires(...)` fails startup and `pnpm test:routes`; an API write yields an `audit_event` with the caller's id). ROADMAP-002 (M1, framework library) is now In Progress; do not start it without the framework fixtures (TASK-011, TASK-012).

Open items carried forward:
- **SAML** is proven only against a mock IdP; integrate with `sso()` (admin-only provider registration) and verify against QuickLaunch.
- **Queue sweeper** for jobs committed but never published (see TASK-008 note).
- **Better Auth rate limiting** needs `advanced.ipAddress.trustedProxies` / header config when deployed behind a reverse proxy (it logs a warning without it).
- **Playwright browser e2e** is not set up; `pnpm test:e2e` is the Compose smoke script until the SPA has real flows.
- **Object storage is Garage, not MinIO** (owner decision, 2026-10-05; `minio/mc` and the quay MinIO images were unavailable to CI). Compose runs `dxflrs/garage:v1.0.1` with `deploy/garage.toml`; `scripts/garage-init.mjs` (compose service `garage-init`) assigns the single-node layout and imports the S3 key from env via the Garage admin API v1, creates the bucket and grants access. Keys must be Garage-shaped: id `GK`+24 hex, secret 64 hex. Written without access to Garage's docs (blocked from this sandbox) and without a Docker daemon, so it is verified only by CI. **PRD §18.1/§18.3/§18.4 and the M0 kickoff prompt still say MinIO; the PRD is the owner's to amend.**

---

## 2026-10-05 — M0 tasks 001–006: scaffold, schema, RLS, API chain, auth

Learnings a future session needs:
- **Postgres access.** Everything goes through `withIdentity()` (`packages/db/src/identity.ts`): it does `SET LOCAL ROLE ams_app|ams_worker` and sets `app.user_id`, `app.institution_id`, `app.request_id`, `app.actor_type`. RLS is **not FORCEd**: the table owner bypasses it, the restricted roles never do, so never query as the owner in request code. `GRANT ams_app, ams_worker TO CURRENT_USER` is in migration 0002 so the login user can switch roles.
- **Worker role cannot approve.** `ams_worker` has no UPDATE on `extraction_item.status`/`reviewed_by` (column-level grants) and no writes to domain tables; tested in `packages/db/src/rules.test.ts`.
- **Audit.** `audit_row()` is SECURITY DEFINER; the app roles have no INSERT on `audit_event`. Append-only is enforced by triggers that also block the owner and TRUNCATE.
- **Enum columns** need CHECK constraints (Drizzle's `enum` is type-only); use the `oneOf()` helper in `schema.ts`.
- **Route enforcement.** Routes are registered only via `secureRoute()` (`apps/api/src/chain.ts`); `assertAllRoutesDeclared` runs at startup and in `pnpm test:routes`. Authentication endpoints use `rawPublicRoute()`. Coarse permission is checked in the chain; permissions whose scope comes from the request body are re-checked in the service with `assertPermitted`.
- **zod 4** is required by `@hono/zod-openapi` 1.x; the workspace uses zod ^4 everywhere.
- **Better Auth 1.7**: generic OIDC registers as a social provider (`POST /api/auth/sign-in/social` with `provider`, callback `/api/auth/callback/<id>`). Self sign-up is disabled; administrators (or the seed) create `app_user` rows; a first SSO login is linked to a pre-created `app_user` by verified email (`app_link_identity`). Auth tables are unreachable by the app roles.
- **Tests need PostgreSQL.** `TEST_DATABASE_ADMIN_URL` defaults to `postgres://postgres:postgres@localhost:5432/postgres` (vitest config). Test files run serially because migrations create cluster-level roles.

- **Jobs (TASK-008).** `enqueueJob(ctx, …)` inserts the `job` row as the caller and publishes to pg-boss in `ctx.afterCommit` (after commit only). The worker's `runJob()` re-reads the row under the envelope's identity (RLS) and checks `created_by` and type match before running, then writes status as that identity with role `ams_worker`. pg-boss tables live in its own `pgboss` schema, reachable only by the owner connection, never by `ams_app`/`ams_worker`. Known gap: if the process dies between commit and publish, the row stays `queued` with no queue entry; a sweeper is needed before real workloads (M7).
- **Typed client.** Routes are defined with `secured()` and chained with `.openapi()` so `ApiRoutes` carries the types to `hc<ApiRoutes>` in the SPA (a wrapper that returned `void` lost them).
- pnpm peer-variant duplicates of drizzle-orm broke types once pg-boss was added; a root `@opentelemetry/api` devDependency plus `pnpm dedupe` fixed it.

**SAML spike (TASK-006) result.** `@better-auth/sso` completed an SP-initiated SAML login end to end against a local mock IdP (samlify): SP metadata is generated, the AuthnRequest redirect is produced, a signed assertion with matching audience and `InResponseTo` is accepted, a user and session are created (`apps/api/src/saml-spike.test.ts`). **No broker appears necessary on this evidence, but the real institutional IdP (QuickLaunch) was not available and has not been exercised**; that remains to be verified with its metadata. Not yet integrated into `createAuth()`: doing so needs the `sso()` plugin, the `ssoProvider` table, and registration restricted to administrators (`providersLimit: 0`, since by default any signed-in user may register a provider).

---

## 2026-10-05 — AMS project seeded

PRD v1.5 committed as `docs/PRD.md`. Seeded VEF records from it: six vision themes, decisions DEC-002…DEC-015 (configuration-not-code, lifecycle roadmaps, response sub-cycle, official vs internal, authority + quote verification, single PostgreSQL, host-agnostic, SPA + Hono, middleware chain, liteparse, AI SDK, AI data handling, dataset evidence, Better Auth), roadmap items ROADMAP-001…011 mirroring milestones M0–M9 and the liteparse track, and tasks TASK-001…012 for M0 and the framework fixtures.

Learnings to carry forward:
- VEF roadmap status has no "Planned"/"Not started" value; not-yet-started milestones use `Deferred` until started. (Candidate VEF improvement.)
- ABET EAC fixture (TASK-012) is blocked on the official *Criteria for Accrediting Engineering Programs* document.
- The NBAQ 2017 handbook PDF has a corrupted embedded text layer; parsing must escalate (PRD Appendix D, LP3).

## 2026-10-05 — Framework adopted

Adopted `vibe-engineering-framework` through `vef setup`; `vef check` confirmed deterministic core enforcement. Framework docs (VISION, ROADMAP, TASKS, DECISIONS) are the public reading surfaces over canonical records. Claude Code skills (`/tasks`, `/roadmap`, `/decisions`, `/bugs`, `/apply`) were installed in `.claude/skills/`.
