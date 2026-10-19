---
id: TASK-080
title: 'Quality Management screens: cycles list, new cycle, cycle page, My work'
description: >-
  The Quality Management menu becomes real: list and filters, launch a cycle, the cycle page with stages, inputs,
  process and outputs, and My work
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
  - id: TASK-079
    name: 'Cycle templates: Settings section, editor and shipped defaults'
    url: /TASKS.md#TASK-079
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-19T12:00:00.000Z'
---
# TASK-080 — Quality Management screens: cycles list, new cycle, cycle page, My work

Plan: Screens. Replaces the placeholder at /quality-management. Cycle page: stages as a timeline and a list with responsible unit, owner, dates, status, inputs (missing ones flagged, never blocking), process text and checklist, output slots and their state; approvals decided by the named approver; Arabic dir=auto; responsive at 375/768/1280; "Internally approved", never "met"/"compliant" (DEC-005).

Built (2026-10-19). Quality Management has three tabs, addressable as `?tab=standards|cycles|my-work`, and a cycle page at `/quality-management/cycles/$id` (`?stage=<id>` opens one stage). Full width, no side panels; every new string goes through `t()` (keys `qmc.*`, files added to `CONVERTED_UI`); Arabic content has `dir="auto"`.

- **Cycles tab:** list with filters (status, unit or program, template, what it is about, due: late or in the next 14 days, "Only mine") and a search of the title; per row the title, anchor and subject, responsible unit, status chip, progress (stages done of N), the next stage with its owner and end date, a Late / Due soon chip and a "Needs an owner or unit" flag. A draft is started with Start or deleted (Trash, Undo toast); a running cycle is cancelled with a required reason. People without `cycle:manage` see it read-only with the one-line note.
- **One launch dialog** (`components/cycles/launch-cycle-dialog.tsx`) behind both "New cycle" and the ⋯ menu's "Create cycle" (extracted from TASK-086; the anchor is fixed there). It asks for the anchor (institution, unit, program or an IQF standard), a published template that fits (or none: blank), the subject, responsible unit, start date and lead, makes the DRAFT, then shows the resolved unit and owner of every stage and approver of every approval before it starts: what the rules could not settle is flagged ("Not found: choose one") and editable at once (with Undo). "Start the cycle" activates; "Keep as a draft" leaves it; "Open the cycle" links to the new page (replacing TASK-086's temporary link).
- **Cycle page:** header (title, anchor, subject, responsible unit, lead, dates, period, template version, progress, previous cycle link, status, cancel reason), the stages on a timeline (bars as percentages, never a sideways scroll) and as cards: responsible unit, owner, dates, status and Late; inputs (satisfied or Missing, never blocking; a link to the producing stage or to the previous cycle; a picker for `pick` inputs: document, evidence item or standard); process text and a checklist (who and when); output slots with state: note (edit, save, mark final), document (upload, replace, download, remove), approval (named approver and the three buttons "Internally approved", "Internally approved with conditions", "Returned for changes", a comment required for the last two; nobody else gets them, whatever their role) and report ("Report engine pending" with a manual mark-final until TASK-085). Stage actions: start, complete (says which required outputs are not final instead of sending a refused request), skip with a reason, reopen, edit (name, process, unit, owner, dates; `cycle:manage`). A return reopens the earlier stage and says so. A blank draft is built by hand (add stage, output, input, who signs, remove) and then started. Edit cycle (title, lead, unit, dates, period), cancel with a reason, delete a draft (Trash, Undo).
- **My work:** the stages I own and the approvals waiting for me with due dates and Late flags, each linking to the stage on its cycle page; the menu shows "My work (N)" only while something waits.
- **Permissions in the UI mirror the API:** `cycle:manage` (the cycle's `canManage`) for the cycle's own settings, owners, units and dates; a stage owner or `cycle:work` works a stage (`canWork`); only the named approver decides (`canDecide`); everyone else is read-only.
- **API/core gaps found and filled (no new business rule):** the cycle list gained `nextStage` (first stage not done, with owner, end date, late), `late` and `dueSoon` on each row and the filters `due=late|soon` and `aboutId` (anchor, subject or responsible unit), because the list screen needs them and could not get them from the 36 routes. Core test extended. No migration. The launch API has no dry run, so "before it starts" is the draft step of the dialog: cancelling there leaves a draft (delete it from the list, Undo available).
- Tests: web `cycles-ui.test.tsx` (list, filters, unresolved flags, launch dialog, start, cancel, delete with Undo, cycle page flows by owner and by approver, return reopens the earlier stage, edit with Undo, blank draft building, previous cycle link, My work, read-only, menu count) and the updated `standards-ops-ui.test.tsx`; core `cycles.test.ts`; responsive pages `qm-cycles*`, `qm-cycle-page*`, `qm-my-work` and the Arabic interface for the list, page and My work (`e2e/responsive.mjs`, 375/768/1280).
