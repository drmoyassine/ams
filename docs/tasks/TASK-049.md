---
id: TASK-049
title: Background work runs as three services (worker, parser, agent); the app prepares Garage itself
description: >-
  One worker becomes worker, parser and agent from one codebase, told apart by WORKER_QUEUES; framework analysis queues
  document reading to the parser instead of parsing; the garage-init compose service is replaced by a bootstrap in the
  app's startup
status: completed
priority: P1
last_updated: '2026-10-11'
generated:
  by: agent/claude-code
  at: '2026-10-11T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-048
    name: Settings -> AI offers OpenAI, Google and any OpenAI-compatible server next to Anthropic
    url: /TASKS.md#TASK-048
related_decisions:
  - id: DEC-010
    name: One middleware chain for every request and background job
    url: /DECISIONS.md#DEC-010
  - id: DEC-024
    name: 'Background work runs as three services from one codebase: worker, parser, agent'
    url: /DECISIONS.md#DEC-024
modified:
  by: agent/claude-code
  at: '2026-10-11T09:00:00.000Z'
---
# TASK-049 — Background work runs as three services (worker, parser, agent); the app prepares Garage itself

Owner decisions: the single worker container becomes three services built from the same code (DEC-024), and `garage-init` goes away, its work moving into the app's startup.

Built:
- Roles by environment: `WORKER_QUEUES` (comma-separated job types, validated against `JOB_TYPES`; unset = all types; empty or unknown refused, including `WORKER_QUEUES=` set but empty) and `WORKER_NAME` (`packages/shared/src/config.ts`). `startWorker` subscribes only to those types (every queue is still created, so a job can be sent to any service) and returns what it subscribed to; the log line is `worker started` with `name` and `queues`.
- `QUEUE_GROUPS` (`packages/shared/src/permissions.ts`): `worker` = export, notify; `parser` = extract_text; `agent` = analyse, ai_extract, ocr. `queues.test.ts` and `config.test.ts` check that every job type is in exactly one group and that `compose.yaml` (parsed with `yaml`, a worker dev dependency) gives each service the same `WORKER_QUEUES`, `WORKER_NAME`, build target and `service_healthy` dependencies.
- Analysis `read` stage no longer parses: a source with a file and no page text gets an `extract_text` job (parser) and the `analyse` job re-queues itself 5 s later, up to 360 looks (about 30 min). The queued job and wait count are kept in `analysis_run.report.readJobs` (no migration). A reading that ends `ok: false` is recorded in `readErrors` and the run goes on, as before; a reading job that fails its last attempt, disappears or never finishes ends the run as failed with `reading "<title>" failed: ...` or `... did not finish in time ...; is the parser service running?`. `JobQueue.send` and `enqueueJob` take an optional `delaySeconds` (pg-boss `startAfter`).
- Docker: targets `worker`, `parser`, `agent` (same entry point; the role comes from compose env); the app health check has a 180 s start period because the app now waits for Garage before listening.
- Compose: `garage-init` removed; `app` has `GARAGE_ADMIN_URL=http://garage:3903` and `GARAGE_ADMIN_TOKEN`, depends on postgres and garage healthy; `worker`, `parser`, `agent` depend on postgres, garage and the app healthy. Comments say only the agent needs outbound internet. `scripts/smoke.sh` checks all three services logged `worker started`.
- Garage bootstrap: `packages/core/src/evidence/garage-bootstrap.ts` (admin API v1: layout, key import, bucket, grant; each step checks first), run from `apps/api/src/main.ts` before the app serves, only when `GARAGE_ADMIN_URL` is set; fatal with a clear message otherwise; waits for Garage (`GARAGE_BOOTSTRAP_ATTEMPTS` x `GARAGE_BOOTSTRAP_DELAY_MS`, default 60 x 2 s). `scripts/garage-init.mjs` and its test are deleted; `garage-bootstrap.test.ts` covers first run, second run, partial state, wrong key format, Garage not ready then ready, never ready, refused token, hard refusal, retried network errors, and the env wrapper.
- Docs: ARCHITECTURE.md (diagram and worker section), CLAUDE.md, AGENTS.md, `.env.example`, DEC-024.

Not done here: no Docker build or `docker compose up` in this sandbox, so the start order and health checks are verified by the parsed-compose test and `docker compose config` only, not on a live stack (CI `compose-smoke` will exercise it). The `parser` still calls a model for the optional OCR of scanned pages (inside `extract_text`), so it needs outbound internet only for that; without it those pages stay `needsOcr`. That OCR no longer counts against an analysis run's budget. `ocr` and `ai_extract` have no handlers yet; the agent subscribes to nothing for them until they exist.
