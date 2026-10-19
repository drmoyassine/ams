---
id: TASK-079
title: 'Cycle templates: Settings section, editor and shipped defaults'
description: >-
  Settings -> Quality Management lists and edits cycle templates (stages, owners, dates, inputs, outputs, anchors they
  fit) with versions and shipped defaults
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
  - id: TASK-078
    name: 'Cycles: schema, permissions and core services'
    url: /TASKS.md#TASK-078
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-19T12:00:00.000Z'
---
# TASK-079 — Cycle templates: Settings section, editor and shipped defaults

Plan: Templates. Draft -> published -> retired, version +1 on publish, running cycles keep their version. Defaults (data, never code, DEC-002): annual program report, periodic program review, admin unit review, internal audit, course assessment (semesterly), blank custom. Import of the institution's own templates through the Docs tab pattern comes later (TASK-075 engine).

Built (2026-10-19):
- Settings -> Quality Management (`/settings/quality-management`, menu item for everyone with `org:read`; editing needs `cycle:manage`, everyone else sees it read-only with the usual note). List: name EN/AR, anchors it fits, version, status, stages, filter by status, New template, Duplicate, Revise (published/retired -> draft), Retire / Offer again, delete a never-published draft (Undo through the X-Undo toast).
- Editor (`/settings/quality-management/$templateId`, `apps/web/src/pages/settings/quality-management/`): name EN/AR, description, anchor kinds; stages in order (up/down buttons, keyboard accessible; no drag) each with names, process, checklist, unit rule, owner rule, start and length in days, outputs (kind, required, report template key, approver rule) and inputs (earlier stage's output picked from the stages above, previous cycle's output, or something picked). Live checks in plain words per stage with `validateTemplateStages` (reads a later stage, own stage, circle, missing stage or output), a missing name or number blocks only the save (the stored shape needs it), Publish runs the full check and lists what is wrong, a draft saves unfinished. Stage timeline preview. Published/retired shows read-only with "Revise to edit". Interface text goes through `t()` (`qmt.*`), Arabic fields `dir="auto"`.
- Shipped defaults as data (`packages/shared/src/cycle-defaults.ts`): annual program report (Collect -> Self-evaluation -> Review by the head of the unit -> QA review -> Final report, last year's final report read by Collect via previous cycle), periodic program review, administrative unit review, internal audit, course assessment (every semester), custom (blank); English and Arabic names. `installDefaultTemplates(ctx)` (core) is idempotent by key, writes PUBLISHED version-1 templates with origin `default` only when the key is absent; route `POST /api/cycle-templates/install-defaults` (`cycle:manage`); "Add the default templates" when none exist, "Restore missing defaults" when some are missing.
- No migration. Tests: shared (defaults valid, Arabic, internal wording), core `cycles/defaults.test.ts`, api `cycles.test.ts`, web `quality-management-ui.test.tsx` and `editor-model.test.ts`, responsive pages in `e2e/responsive.mjs` (list, new dialog, editor with five stages, a draft with a mistake, refused Publish, read-only; Arabic interface for the list and editor).
