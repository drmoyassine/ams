# CLAUDE.md

Loaded at the start of every Claude session in this repo. This file covers project identity, skills, and the doc framework. For detailed working conventions see `AGENTS.md`.

## What this is

**AMS — Accreditation Management System.** A configurable, host-agnostic system for running accreditation across many accreditors (WSCUC, ABET, NBAQ, PUC, …) on one platform. Every engagement gets a roadmap that produces a self-study and continues into maintenance; every submission opens a tracked accreditor-response sub-cycle; evidence and datasets are stored once and reused. AI extracts accreditor frameworks with page-level citations; humans publish.

**The specification is `docs/PRD.md`.** Read §0 before any work. Build in the milestone order of PRD §18.4; each milestone's "done when" test must pass before the next starts. Roadmap items `ROADMAP-001…011` mirror the milestones; tasks hang off them.

**Stack (DEC-007…DEC-015):** TypeScript · React SPA (Vite, TanStack Router/Query, shadcn/ui, Tiptap, TanStack Table) · Hono API on Node (Zod, OpenAPI, typed RPC client) · PostgreSQL 16 + Drizzle (SQL migrations, RLS, triggers) · Better Auth (OIDC/SAML/password) · S3-compatible storage · pg-boss background services (worker · parser · agent, DEC-024) · liteparse (`parseDocument()`) · Vercel AI SDK with configurable providers: Anthropic, OpenAI, Google, OpenRouter, OpenAI-compatible (`aiExtract`/`aiOcr`) · Docker + Compose.

## Skills (invoke directly)

| Skill | What it does | When to use |
|---|---|---|
| **`/tasks`** | Manage canonical `docs/tasks/` items and project TASKS.md | After finishing work, when planning, when auditing |
| **`/roadmap`** | Manage canonical `docs/roadmap/` items and project ROADMAP.md | When direction changes, when breaking down themes |
| **`/bugs`** | Manage GitHub Issues (list, create, resolve, sync) | When triaging failures, when reporting bugs |
| **`/decisions`** | Manage canonical `docs/decisions/` items and project DECISIONS.md | When making architectural/product decisions |
| **`/apply`** | Migrate docs into the framework standard (multi-agent: discover → extract → cross-link → validate) | One-shot — adopting the framework, or migrating bare-ID docs to `id+name+url` |

Skills are **manual invoke only**. No auto-trigger.

## Deterministic CLI queries

Use the read-only CLI when the answer should come directly from canonical project state:

```bash
vef list tasks --status pending
vef show TASK-001
vef refs TASK-001
vef why TASK-001
vef graph --json
vef search "customer outcome" --json
```

Text is the default; `--json` emits the versioned automation contract. Use `type:id` only to disambiguate duplicate IDs in an invalid repository.

For automated structural writes, author proposal data and delegate to `vef create` or `vef update`. Preview first;
add `--write --actor <agent-id>` only after acceptance. Skills never render canonical frontmatter, item files, inverse
links, or ledgers. If a journal is unresolved, stop for an explicit `vef recover <id> --forward|--rollback` choice. If
doctor reports malformed writer leases, confirm no writer is active and use `vef recover leases`; do not delete lease
files manually.

## Doc framework

| Doc | Purpose |
|---|---|
| **VISION.md** | Generated ledger assembled from `docs/vision/_index.md` and structured theme files |
| **ARCHITECTURE.md** | How the system works — data model, key patterns, design decisions |
| **ROADMAP.md** | Generated directional roadmap ledger |
| **TASKS.md** | Generated work-breakdown ledger |
| **DECISIONS.md** | Generated decision ledger |
| **log.md** | Single-source memory — chronological log + session learnings (OKF) |
| **index.md** | Navigation hub / table of contents (OKF) |
| **BUGS** | Bug tracker — **GitHub Issues** (no markdown file — the Issues *are* the source) |

Canonical structured items live in `docs/vision/`, `docs/roadmap/`, `docs/tasks/`, and `docs/decisions/`; each `_index.md` owns collection-level prose. Root structured ledgers are generated and committed for reading and stable links. Automated changes use the transaction commands; direct human item edits remain an escape hatch followed by `vef setup` and `vef check`. `vef doctor` is read-only troubleshooting. Existing adapter files are never overwritten.

**Before making or reversing an architectural/product decision, check DECISIONS.md** (`/decisions list`) — don't re-litigate settled decisions; record new or reversed ones via `/decisions add` / `supersede`.

All structured items use `id + name + url` cross-linking:
```yaml
related_tasks:
  - id: TASK-002
    name: "Implement activeWhen filter"
    url: /TASKS.md#TASK-002
```

### Cross-linking topology

```
log.md (narrative memory)
    ↓ links to (via log_ref)
DECISIONS.md (central decision ledger)
    ↓ bidirectional links (via related_*)
VISION.md ← ROADMAP.md ← TASKS.md

BUGS (GitHub Issues)
    ↓ links to (via related_tasks)
TASKS.md
```

Tasks/Roadmap/Vision link to **DECISIONS.md**, not to log.md. The decision is the source of truth for *"what we decided"*; the log is the narrative history of *how we got there*.

## Requests to and from the BI

The BI (drmoyassine/ai-native-bi) and the AMS talk through GitHub Issues, bridged by `.github/workflows/issue-bridge.yml`:
- **Need something from the BI?** Open an issue here labelled `for-bi`. It is copied to the BI (labelled `from-ams` there) and
  linked; when the BI closes its copy, this issue gets the outcome and is closed.
- **At the start of a session, check `from-bi` issues** (requests the BI made of the AMS). Close one when it is done or declined,
  with a last comment saying what was done (commit or PR) or why not: that comment is what the BI receives.
- The contract stays one-way: the BI asks for a contract change with an issue; the AMS changes `docs/ams-bi-contract-v0.md` and
  the `contract-sync` workflow opens the pull request on the BI.

## Critical constraints

These are the PRD's non-negotiables. Breaking one is a bug even if tests pass.

1. **No accreditor-specific code.** Never branch on accreditor or framework identity. Differences go into framework configuration (PRD §7). (DEC-002)
2. **Every request and job passes the five-step chain**: authenticate → authorize (`requires(...)`) → transaction with `SET LOCAL app.user_id / app.institution_id / app.request_id` → validate (Zod) → handle (a `packages/core` service). Never query the database outside this helper. (DEC-010)
3. **Business rules live only in `packages/core`.** `apps/api` and `apps/worker` are thin. The SPA never touches the database.
4. **Immutability is enforced in the database** (triggers): published framework versions, submission snapshots, `audit_event`, `accreditation_status` history. Do not "fix" a test by relaxing a trigger. (PRD §6.9)
5. **Official ≠ internal.** Never write "compliant", "met", a readiness score or a predicted outcome in UI, exports or code names. Internal approval is labelled "Internally approved". Official status only via `accreditation_status` with a decision document. (DEC-005)
6. **AI proposes, humans publish.** AI output goes to proposal tables/drafts only; the worker's DB role cannot approve, publish or set official status. `required` notes need a verified quote. (DEC-006)
7. **One import point per heavy library**: liteparse only via `parseDocument()`, AI SDK only via `aiExtract`/`aiOcr`, governed metrics only via `datasetSource.fetch()`. No AI calls outside the worker; temperature 0; prompts versioned in the repo. (DEC-011, DEC-012)
8. **Host-agnostic.** Only PostgreSQL, S3 API, OIDC/SAML, SMTP, HTTPS, configured by env. No provider-proprietary services or SDKs. (DEC-008)
9. **The AMS never sends evidence files to AI models.** Framework source documents and accreditor letters may be. A connected BI may receive evidence and process it with its own AI (DEC-013, DEC-019).
10. **Arabic is first-class content.** Store original text, NFC; render with `dir="auto"`; quote matching normalises on the AMS side only.
11. **Migrations are forward-only SQL**, committed with the schema change that needs them.

## Verification surfaces

| Surface | How |
|---|---|
| Unit + integration tests | `pnpm test` (Vitest) |
| End-to-end | `pnpm test:e2e` — `scripts/smoke.sh` against the running Compose stack (health, login, protected route, worker, parser and agent). Playwright browser tests join when the SPA has real flows |
| Responsive layout | `pnpm test:responsive` (`--report-only` to not fail) — `e2e/responsive.mjs` boots the API + built SPA on a fresh test DB (needs PostgreSQL and `pnpm build`), signs in with Chromium and checks the main screens at 375/768/1280px for horizontal scroll; screenshots to `e2e/screenshots/` (gitignored). Playwright is not a repo dependency: uses `PLAYWRIGHT_MODULE` (default `/opt/node-tools/node_modules/playwright/index.mjs`) |
| Route permission coverage | `pnpm test:routes` — enumerates Hono routes; fails on any route without `requires(...)` |
| Database rules | `pnpm db:test` — RLS isolation, immutability triggers, audit trigger. Needs PostgreSQL (`TEST_DATABASE_ADMIN_URL`, default `postgres://postgres:postgres@localhost:5432/postgres`) |
| IQF mapping shortlist (DEC-023) | `pnpm analysis:eval-mapping` (needs `pnpm build`) — shortlist recall@10 of the lexical ranking over the hand-labelled set in `packages/core/eval/mapping-labels.json` (demo standards against the starting template's items); with `EMBED_BASE_URL`, `EMBED_MODEL`, `EMBED_DIMENSION` (and `EMBED_API_KEY`) set it also prints the hybrid (words + meaning) recall next to it. No database; the unit test covers the lexical path only |
| Assistant bulk-edit evaluation (DEC-027) | `pnpm assistant:eval` (needs `pnpm build`) — runs the 40 sample instructions of `packages/core/eval/assistant-instructions.json` through their reference operations over a fixture tree and prints a pass table (the unit test `changes/eval.test.ts` asserts the same, no network); with `ASSISTANT_EVAL_BASE_URL`, `ASSISTANT_EVAL_MODEL`, `ASSISTANT_EVAL_KEY` (or the app's `AI_*` environment) set it also asks the real model for the operations of each instruction and compares what they do. No database |
| Types and lint | `pnpm typecheck && pnpm lint` |
| Project memory | `npx vef check` (also in CI via `.github/workflows/vef.yml`) |
| Local stack | `docker compose up` — app on :3000, Postgres :5432, Garage S3 :3900 (admin :3903) |
| Logs | Structured JSON to stdout from `app`, `worker`, `parser` and `agent` |

(Commands above are created in M0 / TASK-001…009; keep this table accurate when they change.)

## When in doubt

Read `VISION.md` first. Then check `DECISIONS.md`. Use `vef why <id>` or `vef refs <id>` for deterministic retrieval. If still unsure, run the relevant skill:
```
/tasks list
/decisions list
/roadmap list
```
