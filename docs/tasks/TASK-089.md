---
id: TASK-089
title: 'Evidence schema: definition, dataset, collection method, schedule'
description: >-
  Fix the evidence item the BI builds against: a title, a type (document or dataset), a definition, one collection method with
  its settings (manual, online form, request, BI; survey reserved) and an optional schedule; "description" and the type "data" go;
  collecting is no longer a cycle, so the evidence item leaves the cycle screens
status: completed
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
  - id: TASK-081
    name: Cycle recurrence, academic terms and plans with inheritance
    url: /TASKS.md#TASK-081
  - id: TASK-087
    name: 'Simplify cycles: evidence collection, one owner'
    url: /TASKS.md#TASK-087
related_decisions:
  - id: DEC-031
    name: 'An evidence item is a title, a type (document or dataset) and a definition, collected by one method on an optional schedule; collecting is not a staged cycle, reports are'
    url: /DECISIONS.md#DEC-031
  - id: DEC-030
    name: 'Quality Management is simplified: cycles are not linked to standards; a cycle has one owner; evidence collection first, accreditation and Quality Assurance / report cycles later'
    url: /DECISIONS.md#DEC-030
modified:
  by: agent/claude-code
  at: '2026-10-20T15:00:00.000Z'
---
# TASK-089 — Evidence schema: definition, dataset, collection method, schedule

Owner decision 2026-10-20 (DEC-031). The BI team builds against this schema (docs/ams-bi-contract-v0.md, sections 3 and 4), so it was fixed first. Plan: docs/quality-management-plan.md (the note under "Simplified 2026-10-20"). Migration 0064_evidence_schema.sql (journal idx 64, `when` 1792040000000, forward-only).

Built (2026-10-20):
- **Renamed.** `evidence_item.description` is `definition` in the column, the shared schemas, the API, the screens (labels "Definition"), the tests; the type `data` is `dataset` in the rows, the check, the enums, the API, the screens ("Dataset", the library filter "Datasets") and the contract. The dataset's own `dataset_spec.definition` is merged into the item's (copied when the item has none; APPENDED after a blank line when both have text and differ, so nothing is lost) and the column is dropped; the specification keeps its grain and columns, and the form and the public/one-time-link form pages show the item's definition. The two database rules that named the old type (`dataset_spec_rules`, `evidence_request_rules`) say `dataset`.
- **Collection method** (`evidence_item.method`, default `manual`; `method_config` jsonb, default `{}`), ONE per item: `manual {instructions?, expectedFormat?}`, `form {}` (a dataset only; the existing online form, responses and spreadsheet template are unchanged), `request {assigneeUserId | assigneeEmail (exactly one), note?}`, `bi {endpointKey?, query?, period?, timeoutSeconds?}` (the endpoint is a NAME resolved from the server's environment and cannot hold an address; the query is `{metric, dimensions?, filters?}` as strict data, never SQL; either type, a dataset recommended), `survey {}` (reserved: accepted by the enum and the API, shown disabled "coming"). `checkMethod()` in `packages/shared/src/evidence.ts` validates per method and the method against the type; the database checks the same (form needs a dataset, one assignee, endpoint name shape) and a trigger keeps the owner, the owner unit and the assignee inside the institution.
- **Schedule** (`schedule` jsonb, null = none; `next_due_at`, `last_run_at`): `{every: day|week|month|quarter|semester|year, startDate, dueAfterDays, timezone}`. `packages/core/src/evidence/schedule.ts` is pure: `nextOccurrences(schedule, from, count, terms)` (calendar arithmetic from the start date, each date placed at its local midnight in the schedule's time zone so daylight saving never moves it; a skipped midnight starts at the first instant of the date, a repeated one at the first; a semester is each term of the academic calendar from `academic_term`, and fewer terms than asked for is a `no_term` gap, never a guess), `nextDue(schedule, now, terms)` (the end of the due day of the earliest period not yet over), `startOfLocalDay`, `localDate`. The services keep `next_due_at` when a schedule is set or cleared; the item DTO adds `scheduleGap: 'no_term'` read live from the calendar. Nothing runs from a schedule yet (TASK-090).
- **API.** `POST` and `PATCH /api/evidence` take `definition`, `type`, `ownerUserId`, `method`, `methodConfig`, `schedule`; `GET` returns them with `ownerName`, `nextDueAt`, `lastRunAt`, `scheduleGap`; `description` and `data` are refused (400, strict). Changing the method clears the old settings; settings alone are checked against the current method; a dataset collected by its form cannot become a document until another method is chosen. No new routes (the dataset routes keep their paths `/api/evidence/{id}/data-definition` and `/data`, now tagged dataset); every route still declares `requires(...)`.
- **Screens.** One item form (`components/evidence-item-form.tsx`) for "+ Evidence" and "Edit details": Title, Type (Document | Dataset), Definition, Collection method (Manual | Online form | Request | BI | Survey (coming), with its settings), Schedule (Repeats: No schedule or every day to year; start date, due after in days, time zone) and Owner. The closed card shows method, schedule and next due as chips (and "No term defined" for a semester the calendar cannot place); the open card shows a Collection section (method settings, schedule, next due, last run, owner) after the Definition. The dataset panel is "Dataset" with Edit columns / Save columns.
- **Removed from the cycle UI** (DEC-031): the Cycle section of the evidence card ("Collect this regularly", "Start a cycle now", "Stop repeating") and its "Cycle…" menu item (`evidence-cycle-section.tsx`), New cycle on the Cycles tab (the launch dialog now only reviews a run a plan proposes, so its evidence picker went), New plan and Change on the Plans tab and the plan dialog (`components/cycles/plan-dialog.tsx`), the tests of all of these and their strings. The engine, its data and its API are untouched; existing cycles and plans are listed; the Evidence collection template stays defined, is not offered, and Settings labels it "coming" like the report and Quality Assurance ones (`isComingCycleTemplate` replaces `fitsEvidenceCycle`).
- **Docs.** DEC-031; docs/ams-bi-contract-v0.md 3.1, 3.3, 3.6 (and 4, 5, 8, 9) rewritten to this schema (an evidence need is a collection run, TASK-090); the note in docs/quality-management-plan.md; docs/status.md; ARCHITECTURE.md; log.md; TASK-090 (pending).
- Tests (full run 1,954 tests in 183 files, database, route-permission and migration tests included): shared `evidence.test.ts` (11: the settings of each method, the schedule, the create and update inputs), core `schedule.test.ts` (19: day, week, month, quarter, semester, year, daylight saving in London, New York and Havana, time zones, gaps, `nextDue`), core `evidence-schema.test.ts` (14: method settings per method, schedule validation, type rename, owner, definition on the form), updates to the core evidence, dataset, forms and requests tests; database `evidence-schema.test.ts` (14: the migration over seeded old data, the checks and triggers, isolation, the worker, audit); API `evidence.test.ts` (new fields and refusals); web `evidence-schema-ui.test.tsx` (12: the form per method and schedule, chips, Collection section, Edit details, the removed cycle UI) with `evidence-ui`, `data-ui`, `forms-ui`, `cycles-ui`, `plans-ui` and `quality-management-ui` updated; responsive states in e2e/responsive.mjs (the item form with each method and a schedule, the chips, the Collection section, Edit details at 375/768/1280; the states of the deleted UI are gone).

Decisions taken here (not in the brief): a dataset's definition is appended, not dropped, when both texts differ; a dataset whose form is open or has responses becomes `method = form`, every other row `manual`; a `request` item must name its person or address when saved; the due time is the end of the due day in the schedule's time zone; `scheduleGap` is read live while `next_due_at` is recomputed when the item is saved (TASK-090 recomputes it when the calendar changes); the dataset routes keep their paths.

Not done: any run, scheduler, BI call or notification (TASK-090); the dataset's governed-metric source configuration and the `bi` method overlap and are to be reconciled (TASK-090, M9); the PRD §6 table still lists the old evidence item columns (the PRD is not edited without the owner; DEC-031 wins).
