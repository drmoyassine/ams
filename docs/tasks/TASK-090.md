---
id: TASK-090
title: 'Evidence collection runs: scheduler, BI call, request, form, manual'
description: >-
  A job fires each evidence item's schedule and makes a run for the period; by the item's collection method it sends the BI API
  request and waits for the answer, sends the request, opens the form or creates the owner's task; a run is pending, requested,
  supplied, late, failed or skipped, and the BI's callback carries a one-time token
status: pending
priority: P1
last_updated: '2026-10-20'
generated:
  by: agent/claude-code
  at: '2026-10-20T15:00:00.000Z'
roadmap_item:
  id: ROADMAP-013
  name: 'Quality Management: cycles and reporting'
  url: /ROADMAP.md#ROADMAP-013
depends_on:
  - id: TASK-089
    name: 'Evidence schema: definition, dataset, collection method, schedule'
    url: /TASKS.md#TASK-089
related_decisions:
  - id: DEC-031
    name: 'An evidence item is a title, a type (document or dataset) and a definition, collected by one method on an optional schedule; collecting is not a staged cycle, reports are'
    url: /DECISIONS.md#DEC-031
modified:
  by: agent/claude-code
  at: '2026-10-20T15:00:00.000Z'
---
# TASK-090 — Evidence collection runs: scheduler, BI call, request, form, manual

Owner decision 2026-10-20 (DEC-031). TASK-089 gave every evidence item a collection method, its settings and a schedule, and a pure `nextOccurrences(schedule, from, count, terms)`; nothing runs from them yet. This task makes them run.

To build:
- **A scheduler job** (pg-boss, in the worker; one import point, DEC-024) that finds the items whose `next_due_at` or next occurrence has come, makes **a run for the period** (idempotent: one run per item and period, whatever the job's retries), and moves `last_run_at` and `next_due_at` on. The semester schedule reads the academic calendar; a period the calendar does not define makes no run and stays flagged (`scheduleGap`). Recompute `next_due_at` when the calendar changes.
- **A run** (`evidence_run`): the item, the period (start, end, label), the due time, a status `pending | requested | supplied | late | failed | skipped`, who or what supplied it (the new evidence version), and the reason for `failed` and `skipped`. `late` is set by the job when the due time passes without a supply; a late run still takes a supply. Same-institution checks, RLS, audit, and the worker's role may write runs but never approve or publish anything (DEC-006).
- **By method**:
  - `bi`: send the BI API request (the endpoint resolved from the server's environment by `endpointKey`, never a typed address; the structured query and period grain from the item; the timeout) and wait for the response; a refusal, an error or a timeout makes the run `failed` with the reason, to be retried or skipped by a person. A **per-run one-time token** for the BI's callback (stored as a hash, expiring, used once) lets the BI supply asynchronously: the supply becomes a new evidence version with `as_of` and lineage, and the run `supplied`. See docs/ams-bi-contract-v0.md 3.6 and 4.
  - `request`: send the evidence request to the person or the email address (the existing evidence request service and one-time link, DEC-018), with the item's note; the run is `requested` until it is answered.
  - `form`: open the dataset's online form for the period (the existing form, DEC-020); responses join the data when a person adds them, which supplies the run.
  - `manual`: create the owner's task (it appears in My work) with the item's instructions and expected format; a new version added by the owner supplies the run.
  - `survey`: reserved; makes no run.
- **Screens**: the evidence card lists its runs (status, period, due, what supplied it) with Skip this period (a reason) and a manual "Run now" for a person who may write evidence; a Late flag; the owner's task in My work.
- **Notifications** (in-app, with the notification work of TASK-088): a run is due, requested, late or failed.
- Tests: scheduler idempotency and the period boundaries across daylight saving, one per method (the BI call against a stub endpoint, its failure, its timeout, the callback token used once and expired), late, skip, the calendar gap; database rules; API; web; responsive states.

Open for the owner: whether a failed BI run retries by itself (and how often) or waits for a person; whether a late run keeps asking; how the dataset's `source_kind`/`source_config` (governed metric, PRD 9.4) and the `bi` method are reconciled (the proposal: the method says WHEN and by WHOM it is collected, the source configuration says WHAT the governed metric is).
