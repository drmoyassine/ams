---
id: TASK-078
title: 'Cycles: schema, permissions and core services'
description: >-
  The five cycle tables, cycle permissions, core services and API, with responsible unit and owner resolution, Trash,
  Undo and audit
status: completed
priority: P1
last_updated: '2026-10-19'
generated:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-013
  name: 'Quality Management: cycles and reporting'
  url: /ROADMAP.md#ROADMAP-013
depends_on:
  - id: TASK-077
    name: 'Quality Management: cycles and reporting (design)'
    url: /TASKS.md#TASK-077
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-19T12:00:00.000Z'
---
# TASK-078 — Cycles: schema, permissions and core services

Plan: docs/quality-management-plan.md (Schema). Migration with `cycle_template`, `cycle`, `cycle_stage`, `cycle_output`, `cycle_input` (tenant RLS, audit, Trash kind `cycle`); permissions `cycle:read`, `cycle:manage`, `cycle:work`; Zod schema for the template's `stages`; core services: launch a cycle from a template (resolve responsible unit and owner per stage, dates from offsets, wire inputs to outputs), start/complete/skip stages (completed only when required outputs are final), fill outputs (document upload, note, approval with approve / approve with conditions / return, where return reopens the producing stage), cancel with a reason; anchors checked by the service; Undo descriptors; db, core and API tests. Report outputs wait for TASK-085.

Built (2026-10-19; no screens, those are TASK-080, and the template editor is TASK-079):
- Data (migration 0059_cycles, with the snapshot of the whole current schema): the five tables as in the plan, plus `cycle_stage.unit_unresolved` / `owner_unresolved`, `cycle_output.approver_unresolved` (a rule that found nobody, or several, leaves the field empty and flagged: never guessed) and `cycle_input.pick_kind`. Tenant RLS, `stamp_actor` and the audit trigger on all five; the application role writes them, the worker role has SELECT only. Triggers keep the rules whatever the code does: status moves and completion of a cycle, the shape fixed once a cycle starts (stages, outputs and inputs are added or removed only in a draft), a stage completes only when its required outputs are final, outputs are filled only while their stage is in progress, an approval is decided only by its named approver, a final output does not change (reopen it first), who finalised an output and when are stamped by the database, every person and unit named belongs to the same institution, only a draft cycle is deleted, a published template does not change. Trash kind `cycle` (a draft with its stages, outputs and inputs; started cycles are cancelled with a reason).
- Shared (`packages/shared/src/cycles.ts`): value sets, the template stage definition (unit rule, owner rule, offsets, outputs, inputs, child) with `validateTemplateStages` (unique keys, inputs read earlier stages' outputs, the previous cycle or a pick, no loops), DTOs, launch and edit inputs. Permissions `cycle:read` (everyone who reads), `cycle:manage` (admin, lead), `cycle:work` (admin, lead, engagement lead, co-lead, contributor); a stage owner and a named approver always act on their own.
- Core (`packages/core/src/cycles/`): template CRUD (draft, publish with version+1, retire, reinstate, revise, delete a never-published draft), `launchCycle` (anchor and subject checked per kind; unit and owner per stage from the rules against the org chart; dates from the offsets; inputs wired to earlier outputs and to the previous run found automatically), activate / back to draft / cancel, stage start / complete / skip / reopen / checklist / edit, building a blank draft by hand (add or remove stages, outputs, inputs), outputs (note, document through the object store, report slot as a stub with `reportPending`, finalize, reopen), approvals (`decideApproval`: approved, approved with conditions, returned; "returned" reopens the stage that made what was reviewed), picks, My work, read with the anchor, subject, unit, template and people named. Every mutation reports an Undo (decisions, cancellations and replacing a file are not undone). A unit that is the responsible unit of a cycle is not deleted.
- API (`apps/api/src/routes/cycles.ts`, 36 routes, each `requires(...)`) and the typed web client (`apps/web/src/lib/cycles-api.ts`).
- Tests: database (tenant isolation, worker read-only, every guard), core (templates and validation, rule resolution including unresolved and ambiguous, wiring, previous-cycle inputs, stage and approval rules, returned reopens, permissions, Undo, Trash, tenants, NFC), API (a permission per route, owner-viewer works own stage, only the approver decides, upload and download, X-Undo), shared schemas, web client.

Not done: screens (TASK-080), templates editor and defaults (TASK-079), recurrence, plans and terms (TASK-081), nesting and the Accreditations side (TASK-082), assistant tools (TASK-084), real report outputs (TASK-085: a report slot says "report pending" and can be marked final by hand until then).
