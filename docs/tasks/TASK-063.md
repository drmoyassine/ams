---
id: TASK-063
title: Multi-select, bulk delete and drag and drop in the requirement trees
description: >-
  Requirements can be ticked (click, ctrl/cmd, shift, keyboard) and deleted or moved together, and dragged to re-parent and
  re-order with mouse, touch or keyboard, in the quality framework and in an external standard; one batch move service
  with one Undo
status: completed
priority: P1
last_updated: '2026-10-12'
generated:
  by: agent/claude-code
  at: '2026-10-12T18:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-062
    name: Trash, Undo and the in-app confirmation dialog
    url: /TASKS.md#TASK-062
related_decisions:
  - id: DEC-026
    name: Deleted items stay in a 30-day Trash; undo is offered for reversible actions
    url: /DECISIONS.md#DEC-026
modified:
  by: agent/claude-code
  at: '2026-10-12T18:00:00.000Z'
---
# TASK-063 — Multi-select, bulk delete and drag and drop in the requirement trees

UX streamlining items 3 and 4. Builds on TASK-062 (`deleteMany`, `previewDelete`, `deleteAllRequirements`, the Undo header).

Built:
- `packages/shared/src/tree-move.ts`: the pure rules, used by the server and the screens. `planMoves` (positions counted with every moved item
  taken out; cycles and depth refused; display order of every changed list renumbered gap-free), `planPlacements` (Undo), `resolveDrop`
  (before / after / inside to parent and index), `listDropSlots` (the keyboard's places), `appendMoves` (Move to…), `limitsFor`.
- `packages/core/src/framework/move-many.ts`: `moveMany(ctx, versionId, { moves } | { placements })`, `POST /api/framework-versions/{id}/requirements/move-many`.
  Atomic, one transaction, one Undo descriptor that restores every moved item to its parent and position. Codes never change.
- Web, one shared layer for the quality framework (`pages/settings/iqf-requirements.tsx`), an external standard
  (`pages/version/external-requirements.tsx`) and the version page's list (`pages/version/requirements-tab.tsx`): `components/tree/tree.tsx`
  (provider, rows, gutter, toolbar, bulk bar), `lib/tree-store.ts` (per-row state outside React), `lib/tree-selection.ts`, `lib/tree-dnd.ts`.
- `@dnd-kit/core` 6.3.1 (mouse, touch, keyboard sensors, drag overlay, auto-scroll). `sortable` was not needed: a tree that re-parents does not fit
  its model; the places are our own.
- "Delete all standards in this version" (drafts only) is in the version menu and now also in the quality framework's "More actions" menu.
- Tests: shared (rules, equivalence of the fast slot list with `resolveDrop`), core (`move-many.test.ts`), API (`move-many.test.ts`, route coverage),
  web pure (`tree-selection`, `tree-dnd`), web UI against the real API and DB (`tree-ui.test.tsx`: selection, bulk delete and Undo, keyboard model,
  keyboard drag with Undo and rollback, Move to…, read-only states, 600 rows), `e2e/responsive.mjs` (selection bar, bulk dialog, keyboard and pointer drag at 375/768/1280, and a 600-row measurement in Chromium).

Rules and findings:
- Depth: the internal framework goes as deep as it names levels (`level_labels`); an external standard up to 8 (the cap the structure of a standard already has). Move and indent had no depth rule before; indent still has none.
- Codes: a move never renumbers. The IQF's `editQualityItem` derives the parent from the code (2.3 belongs under standard 2), so an item moved elsewhere keeps its code and will go back under the standard its code names if its code is edited. The drop notice says so; nothing was changed silently.
- Moving marks the rows it changes as edited by a person (existing trigger), including siblings that were renumbered.
- An Undo of a move is refused, with a reason, if the item it sat after has since been moved or deleted.

Not done: the single-item move/indent/outdent keep their own Undo and do not renumber gap-free; no virtualisation (not needed at 600 rows); a drag on a touch screen was not run on a real device (the touch sensor is configured; Chromium without touch was used).
