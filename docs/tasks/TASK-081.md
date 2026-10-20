---
id: TASK-081
title: Cycle recurrence, academic terms and plans with inheritance
description: >-
  Cycles repeat (term, year, N years, after the previous one); academic terms in Settings; cycle plans on anchors
  inherit down the IQF and to mapped external requirements, with override and opt-out; next runs proposed for QA to
  launch
status: completed
priority: P2
last_updated: '2026-10-19'
generated:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-013
  name: 'Quality Management: cycles and reporting'
  url: /ROADMAP.md#ROADMAP-013
depends_on:
  - id: TASK-080
    name: 'Quality Management screens: cycles list, new cycle, cycle page, My work'
    url: /TASKS.md#TASK-080
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-19T18:00:00.000Z'
---
# TASK-081 — Cycle recurrence, academic terms and plans with inheritance

Plan: Worked examples, items 1, 3, 4. `cycle_plan`, `academic_term`, `cycle.plan_id`, `cycle.period_label`; inheritance: own plan or nearest ancestor's; an external requirement follows its mapped IQF node's plan unless it has its own; proposed runs listed for QA (auto-launch per template later, DEC-029).

Built (2026-10-19; migration 0062). The model, the engine, plans with inheritance, the scheduler that PROPOSES (QA launches, DEC-029) and the screens. Every new string goes through `t()` (keys `calendar.*`, `plans.*`, `ops.menu.plan`, `quality.tab.plans`; new files added to `CONVERTED_UI`); full width, no side panels; Arabic names `dir="auto"`.

- **Schema (`0062_cycle_plans.sql`, forward-only, tenant RLS, stamp and audit triggers, the worker may only SELECT):** `academic_term` (name, name_ar, kind `term|year`, start/end, active, display_order; a trigger refuses overlap among ACTIVE entries of a kind, re-checked on update), `cycle_plan` (anchor kind and id, template, responsible unit, owner, `recurrence` jsonb `{every, unit: term|year|month}` or `{after: 'previous_ends', setBy: 'decision', dates?}`, `first_start`, `applies_to` jsonb `{kinds, unitTypes, programLevels, ids}`, `mode` own|opt_out, active; same-institution checks for template, unit, owner, anchor and the explicit list; one plan or opt-out per anchor and template), `cycle_plan_skip` (plan, subject, period start, reason; unique), `cycle.plan_id` and `cycle.period_start` (a run names its plan and the period it covers; `period_label` is filled with the label). Plans sit OUTSIDE the immutable framework tables, so they work on published versions. A requirement is keyed by (framework_id, code) like scope and champion; a whole standard (the IQF) by its framework (`anchor_kind` `framework`; its runs are about the standard's newest published version). Anchors: institution, unit, program, framework, requirement, evidence item.
- **Academic calendar** (Settings -> Organization -> Institution): years and terms with dates and English and Arabic names ("AY2026-27", "Fall 2026"); add, edit, switch off, move up or down, delete (confirm, Undo). Same pattern as Scope levels; `org:write` to change, `org:read` to see. API `/api/academic-terms`.
- **Recurrence engine** (`packages/core/src/cycles/recurrence.ts`, pure): `periodsFor(recurrence, firstStart, calendar, horizon)` gives the periods (start, end, label) and the gaps. Every term = each term of the calendar from the first one that has not ended before the first start (label = the term's name); every N terms; every year / every N years = the year entries ("AY2026-27", or a span over N years in a row: "2026-2029"); every N months from the first start ("Oct 2026"); after the previous one ends = the first run at the first start and the dates a person sets afterwards (`POST /api/cycle-plans/{id}/next-date`), labelled "2026-2032" once the next date is known. Where the horizon reaches past what the calendar defines, a gap says so ("No term defined for that period"): nothing is guessed.
- **Plans with inheritance** (`packages/core/src/cycles/plans.ts`, pure, tested; `plan-service.ts` loads it): per template, a node's effective plan is its own, else (external standards) the first not-opted-out plan of its APPROVED mapped IQF nodes in code order, else its nearest ancestor's, else a plan on the whole standard; with the source ("Own", "From Standard 3", "From IQF 3.2", "From the whole standard"). `opt_out` stops that template at the node and below. "Back to inherited" removes the node's own plan or opt-out. The subjects of a plan are the anchor's effective scope (TASK-086) narrowed by `applies_to`; with no scope anywhere `applies_to` alone names them. DECISION taken here: a plan makes runs about ITS OWN anchor (a plan on Standard 4 makes one run per subject per period about Standard 4, covering its sub-standards); inheritance and opt-out decide which plan a node, and the external requirements mapped to it, show as in effect ("covered by the IQF's annual report"), so a mapped requirement does not make a second run of the same cycle.
- **Scheduler** (`due.ts`): `listDueRuns` (`GET /api/due-cycle-runs`, computed on request; no job, no automatic launch; notifications will hook onto `proposeForPlan`, which has no side effects) proposes, per active plan with a published template and per subject, each period that is under way or begins within the horizon (default 120 days) and has no run (not cancelled) and was not skipped. `POST /api/cycle-plan-skips` records "Skip this period" with a required reason (Undo). Launching goes through the existing `POST /api/cycles` with `planId` and `periodStart`: it sets `plan_id`, `period_start` and `period_label`, refuses the same period twice, and finds `previous_cycle_id` as the subject's previous run of the SAME plan (what `previous_cycle` inputs read).
- **Screens:** "Set cycle plan…" in the ⋯ menu of a standard (the institution's own and external; `cycle:manage`): the plans in effect with their source and Opt out / Override / Back to inherited, and the form (template, every term / year / month / when the previous one ends, every N, first start, responsible unit, owner, applies to: kinds, program levels, unit types, an explicit list). Cycles tab: a "Due to launch" section (filters: template, who it is about, due or coming up, look-ahead; select several and "Review and launch" in the shared launch dialog, one run after another, with template, subject, period and plan filled in; "Skip this period" with a reason; calendar gaps named). A "Plans" tab: every plan with what it is attached to, template, recurrence, next run, subjects covered, the gap note, "New plan" (institution, unit, program, the whole quality framework, an evidence item), Change, and the form to set the next date of a plan that waits for a decision. Hover cards list the plans in effect with their source.
- **Expressible end to end (tests):** course assessment every semester on an evidence item and on a standard, for every program (one run per program per term); the IQF annual report every year for every program (plan on the whole standard).
- Tests: pure recurrence (`recurrence.test.ts`) and plans (`plans.test.ts`: own, ancestor, whole standard, mapped, opt-out, applies_to x scope); core `plan-service.test.ts` (calendar, due runs, skip, launch from a proposal sets plan, period and previous, inheritance on a real database, decision dates, permissions, tenant); db `plans.test.ts` (overlap, RLS, worker read-only, same-institution checks, anchor shapes); api `plans.test.ts` (permissions, Undo, launch through `/api/cycles`); web `plans-ui.test.tsx`; the updated menu assertions of `standards-ops-ui.test.tsx`; responsive pages `settings-organization-academic-calendar`, `qm-cycles-due*`, `qm-plans*`, `quality-management-plan-*` (and the Arabic interface for the calendar, due list, plans and plan dialog) at 375/768/1280.
- Not done, on purpose: nesting (TASK-082), the ⋯ "Start a cycle" changes (TASK-083), the assistant (TASK-084), automatic launch (a template flag may come later; no column now), inheritance of plans down the org chart (units and programs take their own plan only), notifications.
