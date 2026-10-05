# Claude Code — session prompt: M0 (Scaffold and integrity foundation)

Paste the block below as the first message of a Claude Code session opened at the repository root.

---

You are building AMS, specified in `docs/PRD.md`. Project memory is managed with the vibe-engineering-framework (VEF).

**Before writing code:**
1. Read `CLAUDE.md` and `AGENTS.md` in full, then `docs/PRD.md` §0, §2, §6.1, §6.8, §6.9, §17 and §18.
2. Run `npx vef show ROADMAP-001` and `npx vef list tasks --status pending`. Run `npx vef why` on each M0 task (TASK-001…TASK-010) to see the decisions that constrain it.
3. Reply with a short plan: the order you will take TASK-001…TASK-010, the files you expect to create, and any question where the PRD or a decision is ambiguous. Wait for my go-ahead.

**Then work task by task** using the AMS working loop in `AGENTS.md`:
- Mark the task in progress → write tests first where there is a "done when" or invariant → implement → run the verification surface → mark completed → log learnings → commit code, `docs/`, ledgers and `.vef/` together with `npx vef check` passing.
- One commit per task. Stop after each task and summarise: what changed, test results, anything I need to decide.

**Hard rules for this milestone:**
- Stack exactly as DEC-007…DEC-010 and DEC-015: pnpm workspace layout of PRD §18.3; Hono on Node; React SPA with Vite; PostgreSQL 16 + Drizzle with committed SQL migrations; Better Auth; MinIO via the S3 API; pg-boss. No other frameworks or hosted services.
- The five-step middleware chain is the only path to the database, for API routes and worker jobs alike. A route without `requires(...)` must make startup and CI fail.
- RLS policies read `current_setting('app.user_id')` and `current_setting('app.institution_id')`; the audit trigger records the actor from the same settings; `audit_event` is append-only.
- For TASK-006, implement password + generic OIDC first; then run the SAML spike and report the result instead of guessing. If SAML needs a broker, propose a decision update rather than changing the stack yourself.
- Do not start ROADMAP-002 work. M0 is done only when TASK-010's three tests pass:
  1. A contributor scoped to program A cannot read program B's rows (through the API and through SQL with session settings).
  2. Registering a route without `requires(...)` fails startup and CI.
  3. A write through the API produces an `audit_event` row carrying the caller's id.

When all three pass, set ROADMAP-001 to `Completed`, ROADMAP-002 to `In Progress`, add a `log.md` entry for M0, and stop.
