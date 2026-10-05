# CLAUDE.md

Loaded at the start of every Claude session in this repo. This file covers project identity, skills, and the doc framework. For detailed working conventions see `AGENTS.md`.

## What this is

<!-- PROJECT: Replace this section with a 2-3 sentence description of your project. -->
**AMS — Accreditation Management System** — *Describe your product here.*

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

## Critical constraints

<!-- PROJECT: Add your project-specific constraints here. Things that cause bugs if forgotten — infrastructure gotchas, RLS rules, agent runtime constraints, etc. -->

## Verification surfaces

<!-- PROJECT: Add your project-specific verification surfaces here. Where to check agent failures, MCP tools, permissions, logs, etc. -->

## When in doubt

Read `VISION.md` first. Then check `DECISIONS.md`. Use `vef why <id>` or `vef refs <id>` for deterministic retrieval. If still unsure, run the relevant skill:
```
/tasks list
/decisions list
/roadmap list
```
