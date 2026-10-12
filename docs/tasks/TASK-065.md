---
id: TASK-065
title: Redo in the undo system
description: >-
  Undo exists (toast and Ctrl/Cmd+Z); add Redo (Ctrl/Cmd+Shift+Z and a Redo button in the toast) so any undone action
  can be repeated; needed by the assistant (DEC-027)
status: pending
priority: P2
last_updated: '2026-10-12'
generated:
  by: agent/claude-code
  at: '2026-10-12T16:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-063
    name: Multi-select, bulk delete and drag and drop in the requirement trees
    url: /TASKS.md#TASK-063
related_decisions:
  - id: DEC-026
    name: Deleted items stay in a 30-day Trash; undo is offered for reversible actions
    url: /DECISIONS.md#DEC-026
  - id: DEC-027
    name: The in-app assistant is a companion that inherits the user's privileges, edits only drafts, and keeps scoped memory
    url: /DECISIONS.md#DEC-027
modified:
  by: agent/claude-code
  at: '2026-10-12T16:00:00.000Z'
---
# TASK-065 — Redo in the undo system

The undo system (TASK-062/063) reverses an action through a descriptor the server returns (the `X-Undo` header). Redo needs the mirror: when an undo is applied, the response carries the descriptor that re-does the action, and the client keeps a per-screen redo stack (cleared by any new action).

- Each undo route returns its own inverse (the redo descriptor); deletes redo by deleting the same ids again (a new Trash group), moves by `moveMany` with the original target placements, edits by the edited values, creates by restoring from the Trash group.
- Ctrl/Cmd+Shift+Z (and Ctrl+Y) redo; the toast after an undo offers Redo for a few seconds; a refused redo says why (for example the version is no longer a draft).
- The assistant (TASK-064) depends on it: its changes are one undoable group, and the person can undo and redo them.
- Tests: redo after each kind of undo (delete, move, multi-move, edit, create, merge, split), the redo stack clears on a new action, refusal cases.
