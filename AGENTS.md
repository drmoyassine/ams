# AGENTS.md

Detailed working conventions for AI agents in this repo. Companion to `CLAUDE.md` (which covers identity + doc framework). This file covers *how to work*.

## Doc framework

This repo uses the [vibe-engineering-framework](https://github.com/drmoyassine/vibe-engineering-framework) documentation system. See `CLAUDE.md` for the skills table and doc-framework overview.

## Deterministic queries

Use `vef list`, `show`, `refs`, `why`, `graph`, and `search` for read-only project retrieval. Every query supports versioned JSON through `--json`; none modifies files or invokes an agent.

## Canonical record storage

Structured records live in `docs/vision/`, `docs/roadmap/`, `docs/tasks/`, and `docs/decisions/`; each collection's `_index.md` owns ledger-level prose. The root `VISION.md`, `ROADMAP.md`, `TASKS.md`, and `DECISIONS.md` files are generated committed ledgers. Never edit their generated item blocks directly.

Automated agents must author semantic proposal data and use `vef create`/`vef update`; they must not serialize
canonical item Markdown, inverse links, or ledgers. Preview is the default and writes require `--write --actor <id>`.
VEF owns IDs when omitted, dates, `modified` provenance, relationship closure, journaling, and validation. If a write
is interrupted, stop for an explicit `vef recover <id> --forward|--rollback` direction. If doctor reports malformed
writer leases, confirm no writer is active and run `vef recover leases`; never delete lease files as a recovery policy.
Direct human item editing is an escape hatch; after it, run:

```bash
vef setup
vef check
```

## Editing workflow

1. **Read before you write** — never patch a file you haven't seen this session.
2. **Batch independent edits** into one response.
3. **Run the build + tests** after non-trivial changes; read the whole output.
4. **Migrations are forward-only.** Destructive changes (drops, mass updates) need explicit owner approval.

```bash
pnpm install
docker compose up -d postgres minio   # local services
pnpm db:migrate && pnpm db:seed        # schema + fixtures
pnpm dev                                # api + web + worker in watch mode
pnpm typecheck && pnpm lint
pnpm test          # unit + integration
pnpm db:test       # RLS, triggers, audit
pnpm test:routes   # every route declares requires(...)
pnpm test:e2e      # Playwright on the Compose stack
npx vef check      # project-memory gate
```
These scripts are created in M0; keep this block accurate.

## Decision discipline

- Before making or reversing an architectural/product decision, check `DECISIONS.md` (`/decisions list`).
- Don't re-litigate settled decisions; record new or reversed ones via `/decisions add` / `supersede`.
- All decisions — including those made by AI agents — go in DECISIONS.md, never in memory files.

## Doc maintenance

- After completing direction-changing work, run the relevant skill:
  - `/tasks reconcile` — validate task schemas, detect orphans
  - `/roadmap reconcile` — validate roadmap schemas
  - `/decisions reconcile` — validate decision schemas + cross-links
- Run `/apply` to migrate scattered content into the canonical schema.
- `vef setup` is the adoption/upgrade lifecycle write; `vef create` and `vef update` are the day-to-day record writers. `vef check` is the strict read-only local/CI gate; `vef doctor` explains blockers. Review and commit `.vef/`, `docs/`, regenerated ledgers, adapters, and the managed enforcement workflow together. Existing adapter files are never overwritten.

## AMS working loop (one task at a time)

1. **Pick the task.** `vef list tasks --status pending` → choose the lowest-numbered unblocked task in the current roadmap item. `vef why <TASK>` shows the decisions that constrain it. Read the PRD sections it cites.
2. **Mark it in progress** via `/tasks` (or `vef update <TASK> --from proposal.yml --write --actor <agent-id>` with `status: in-progress`).
3. **Write the test first** where the task has a "done when" or an invariant. Then implement.
4. **Run the full verification surface** (see CLAUDE.md). Read the whole output.
5. **Close the loop in the same change:** mark the task `completed`; add or supersede a decision with `/decisions add` if you made or changed one; add a `log.md` entry for anything a future session must know; update `ARCHITECTURE.md` if structure changed; if behaviour diverges from `docs/PRD.md`, stop and ask the owner rather than editing the PRD yourself.
6. **Commit** code, `docs/`, ledgers and `.vef/` together. `vef check` must pass.

## AMS conventions

- **Spec precedence:** `docs/PRD.md` > accepted decisions in `DECISIONS.md` > `ARCHITECTURE.md` > code comments. A conflict is a question for the owner, not a judgement call.
- **Names follow the PRD data model** (§6): table and column names, enums and statuses exactly as specified unless a decision says otherwise.
- **Service functions** in `packages/core/<module>` take `(ctx, input)` where `ctx` carries the transaction and caller; they never open their own connection.
- **Zod schemas** live in `packages/shared` and are reused by API validation, OpenAPI, the SPA and the worker.
- **Fixtures** (WSCUC, ABET EAC, PUC) live in `packages/db/fixtures/` and are the test data for every milestone. Accreditor source documents used in tests stay in the private fixture folder and are never published.
- **Milestone gate:** do not start tasks of the next roadmap item until the current item's "done when" tests pass; then set the roadmap item to `Completed` and the next to `In Progress`.
- **Scope discipline:** PRD §3.4 lists what not to build. Do not add services, queues, rule engines or frameworks beyond the stack decisions.
