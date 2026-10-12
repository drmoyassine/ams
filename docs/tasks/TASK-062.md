---
id: TASK-062
title: Trash, Undo and the in-app confirmation dialog
description: >-
  Deleted items stay in a 30-day Trash with restore, a delete removes a whole subtree in one step, reversible actions
  offer Undo (toast and Ctrl/Cmd+Z), and every browser confirm is replaced by an in-app dialog
status: completed
priority: P1
last_updated: '2026-10-12'
generated:
  by: agent/claude-code
  at: '2026-10-12T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-055
    name: Create from files and the split-view review of an external standard's requirements
    url: /TASKS.md#TASK-055
related_decisions:
  - id: DEC-026
    name: Deleted items stay in a 30-day Trash; undo is offered for reversible actions
    url: /DECISIONS.md#DEC-026
modified:
  by: agent/claude-code
  at: '2026-10-12T12:00:00.000Z'
---
# TASK-062 — Trash, Undo and the in-app confirmation dialog

UX streamlining items 1, 2 and 5 (DEC-026). Full inventory, rules and the undo pattern: `docs/trash.md`.

Built:
- Migration `0046_trash`: `trash_item` (tenant RLS, light audit event without the payload), worker grant limited to deleting
  expired rows of its tenant, `trash_expired_institutions()`, `forget_ai_dismissal()`, `trash_drop_dismissals()`, a trigger that clears an
  AI dismissal when a person inserts the row again, and the `purge_trash` job type in the job check.
- `packages/core/src/trash/`: `rows.ts` (read/delete/insert rows as stored, `jsonb_populate_recordset`), `delete.ts`
  (`deleteMany`, `previewDelete`, `deleteAllRequirements`, `deleteVersion`, `deleteFramework`, and the snapshot of notes, source documents with
  pages and file key, pages, templates, links between standards, evidence links, milestones, merged requirements), `restore.ts` (the rules),
  `trash.ts` (list, group contents, count, restore, delete forever, empty, purge). The old services (`deleteRequirement`, `deleteNote`, `deleteSourceDocument`,
  `deleteSourcePage`, `deleteReportTemplate`, `deleteMapping`, `removeLink`, `deleteMilestone`, merge) now write the snapshot.
- Undo descriptors (`ctx.undo`, `X-Undo` header) for delete, create, edit, move, indent, outdent, merge, split, IQF item edit and the starting template; `ConflictError`
  carries `details` for restore choices.
- API: `/api/trash*`, `/api/requirements/delete`, `/delete-preview`, `/api/framework-versions/{id}/requirements/delete-all`, `DELETE` of a version and of a standard, `/unsplit`.
- Worker: `purge_trash` daily schedule in the general `worker` service (`QUEUE_GROUPS`, compose); `ObjectStore.delete`.
- Web: `useConfirm()` (`components/confirm-dialog.tsx`) on the shared `Dialog`, which now moves, traps and returns focus; all seven `window.confirm` calls replaced; ESLint
  rule forbidding `confirm`, `alert`, `prompt` and `window.*` in `apps/web`; the undo bus, `UndoToaster` and Ctrl/Cmd+Z; Settings → Trash page (groups, filter, search,
  contents, restore with the parent-gone choice, delete forever, empty trash) with a badge in the Settings menu; "Delete all standards in this version" and "Delete this version" in the version menu.
- Tests (no network): core trash round trips and rules, db role limits and RLS, API through the chain, worker schedule and tick, UI (confirm dialog, toast, Ctrl+Z, failed undo, delete all, Trash
  page), lint rule; `e2e/responsive.mjs` covers the Trash page, the confirm dialog and the Undo toast.
- Fixed on the way: `updateRequirement` applied the create schema's defaults, so any edit reset the language, assessability and position; the update schema is now written out.

Not done: a Trash badge on the sidebar's Settings entry (only on the Settings menu); drag-and-drop and multi-select UI (a later task builds on `deleteMany` and the descriptor); undo of a review
decision; Trash for evidence items (no delete path exists); the audit event of a restore is the row inserts plus the `trash_item` event, not a labelled "restored" event.
