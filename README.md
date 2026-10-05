# AMS — Accreditation Management System

A configurable, host-agnostic system for running institutional and programmatic accreditation (WSCUC, ABET, NBAQ, PUC, …) on one platform: framework libraries built from accreditor documents with page-level citations, engagement roadmaps that produce self-studies and continue into maintenance, tracked accreditor responses, and one reusable evidence and data base.

- **Specification:** [docs/PRD.md](docs/PRD.md)
- **Why / what / when:** [VISION.md](VISION.md) · [DECISIONS.md](DECISIONS.md) · [ROADMAP.md](ROADMAP.md) · [TASKS.md](TASKS.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [log.md](log.md)
- **Agent instructions:** [AGENTS.md](AGENTS.md) (all agents) · [CLAUDE.md](CLAUDE.md) (Claude Code)

Project memory is managed with [vibe-engineering-framework](https://github.com/drmoyassine/vibe-engineering-framework): `npx vef list tasks --status pending`, `npx vef why TASK-005`, `npx vef check`.

Stack: TypeScript · React (Vite) · Hono · PostgreSQL + Drizzle · Better Auth · S3-compatible storage · pg-boss · liteparse · Vercel AI SDK (Anthropic) · Docker.
