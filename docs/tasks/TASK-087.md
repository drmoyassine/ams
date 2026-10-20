---
id: TASK-087
title: 'Simplify cycles: evidence collection, one owner'
description: >-
  Cycles are no longer about standards: a cycle is about an evidence item (collect it regularly, have it reviewed), has one
  owner that every stage follows unless overridden, and the unit is derived; Create cycle and Set cycle plan leave the
  standards menus; accreditation is reserved and Quality Assurance / report cycles are parked
status: completed
priority: P1
last_updated: '2026-10-20'
generated:
  by: agent/claude-code
  at: '2026-10-20T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-013
  name: 'Quality Management: cycles and reporting'
  url: /ROADMAP.md#ROADMAP-013
depends_on:
  - id: TASK-080
    name: 'Quality Management screens: cycles list, new cycle, cycle page, My work'
    url: /TASKS.md#TASK-080
  - id: TASK-081
    name: Cycle recurrence, academic terms and plans with inheritance
    url: /TASKS.md#TASK-081
  - id: TASK-086
    name: 'IQF in operation: Link evidence, Assign scope, Assign champion, Create cycle'
    url: /TASKS.md#TASK-086
related_decisions:
  - id: DEC-030
    name: 'Quality Management is simplified: cycles are not linked to standards; a cycle has one owner; evidence collection first, accreditation and Quality Assurance / report cycles later'
    url: /DECISIONS.md#DEC-030
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-20T12:00:00.000Z'
---
# TASK-087 — Simplify cycles: evidence collection, one owner

Owner decision 2026-10-20 (DEC-030): the cycle model was too confusing, so it is simplified. Plan: docs/quality-management-plan.md ("Simplified 2026-10-20").

Built (2026-10-20), no migration:
- **Anchors.** A new cycle or plan anchored on a requirement or a standard version is refused by the services (`launchCycle`, `setPlan`; an existing plan on a standard can still be changed or removed, and existing ones are read and listed). Unit, program and institution cycles and plans stay creatable through the API so the engine and its tests keep working; no picker offers them. `accreditation` (engagement) stays a reserved anchor kind for TASK-082. Shared: `CYCLE_OFFERED_ANCHOR_KINDS`, `CYCLE_RETIRED_ANCHOR_KINDS`, `fitsEvidenceCycle()` (a template fits an evidence cycle when it names no anchor or names `evidence_item`).
- **One owner.** `cycle.lead_user_id` is the owner; the screens say "Owner" (no Lead, no Responsible unit in the cycle header, the launch dialog, the list columns or filters, the stage dialogs). `cycle.responsible_unit_id` stays NOT NULL and is DERIVED when not given: the evidence item's owner unit, else a unit the owner heads, else a unit the owner holds a role in (by name), else the institution's top unit (`deriveResponsibleUnit`). Stage owners default to the cycle owner (template rule `cycle_lead`, shown as "Cycle owner"; a stage added by hand follows it); changing the cycle's owner moves the not finished stages that still had the old owner (no new column: a stage "follows" when its owner is the cycle's owner) and leaves the others; the cycle page shows "Cycle owner" or "Own owner" per stage, and the stage dialog offers the cycle's owner first. The unresolved count (the "needs an owner" flag) counts owners and approvers only.
- **Template rules.** New person rule `head_of_evidence_unit` (the head of the unit that owns the evidence item the cycle is about). The editor offers Cycle owner, a named role, Head of the evidence's owner unit (approvers too); a rule an older template holds is listed while it is held; the unit rule is no longer edited. Settings -> Quality Management labels templates made only for other anchors "For Quality Assurance / report cycles (coming)"; the template editor offers only the evidence item anchor (plus the ones a template already holds).
- **Evidence collection.** `packages/shared/src/cycle-defaults.ts` gains the default template `evidence_collection` ("Evidence collection", Arabic name; anchor `evidence_item`): Collect (output: a note "New version of the evidence"), then Review (an approval by the head of the evidence's owner unit, "Internally approved"). `installDefaultTemplates` is idempotent, so "Restore missing defaults" gives it to an existing install. When a new version (file or address) is added to an evidence item while the Collect stage of a running cycle about THAT item is in progress, `noteEvidenceVersion` writes the output's note and makes it final (completing the stage stays with the owner). A plan on an evidence item that names no one to narrow it is about the item itself: one run per period, no subject (`isSelfPlan`; a skip of such a period is stored without a subject).
- **Launching.** The launch dialog asks four things (template, evidence item, owner, start date); the owner defaults to the plan's owner, else the evidence item's owner, else the person; templates that only fit QA anchors are not offered; the review step shows only "Choose an owner for stage X" / "Choose who signs Y" when a rule could not settle it. The owner of a plan may launch and start a run of that plan without cycle:manage (`launchCycle`, `activateCycle`; `DueRun.canLaunch`). Runs of plans on a standard or a requirement cannot be launched (`canLaunch` false).
- **Screens.** Evidence page: the card has a Cycle section ("Collect this regularly", "Start a cycle now", "Stop repeating": removed when it never made a cycle, switched off when it did; the plan with its next due date; the open cycle as a link; the past cycles) and a "Cycle…" menu item. The plan dialog is rewritten for evidence only (`components/cycles/plan-dialog.tsx`). Plans tab: no kind filter, no unit or subject columns, "New plan" asks which evidence item, plans on other anchors are listed and not changed. Cycles tab: filters are status, template, due, only mine and search. Due to launch has no unit or program filter. My work lists the runs due of plans I own with a Start (the shared launch dialog); the menu count includes them (`MyWork.dueRuns`). Standards: the ⋯ menu is Link evidence · Assign scope · Assign champion (Map to IQF on external requirements), and the hover cards show scope and champion only.
- **Removed.** `components/standard-ops/create-cycle-dialog.tsx`; the standard-anchored `plan-dialog` (moved to `components/cycles/plan-dialog.tsx` and rewritten); the standard plan wiring in `use-standard-ops.tsx`; `PlanLines` and its use in the hover cards; `planSourceLabel`; the unit rule field of the template editor and `unitRuleLabels`; the tests of all of these.
- Tests (full run 1,888 tests in 179 files, including the database, route-permission and migration tests): shared `cycle-defaults`; core `cycles.test.ts` (refused anchors, derived unit, Evidence collection launch, owner cascade, new version makes the output final), `plan-service.test.ts` (legacy plans written by SQL keep working; new ones refused; evidence plans; My work due runs; the owner starts a run), `defaults.test.ts`; api `plans.test.ts`; web `evidence-cycle-ui.test.tsx` (new), `cycles-ui.test.tsx`, `plans-ui.test.tsx`, `quality-management-ui.test.tsx`, `standards-ops-ui.test.tsx`; responsive states in e2e/responsive.mjs (evidence card Cycle section, plan dialog, start dialog, empty section, New cycle review, cycle page owner cascade, My work with a due run and its Start dialog; the states of the deleted UI are gone).

Not done: accreditation cycles (TASK-082), Quality Assurance / report cycles (their own task later), `requirementContexts` still computes the plans of a standard for the API although no screen shows them, notifications.
