---
id: TASK-067
title: Assistant phase 2: bulk edits confirmed in the chat
description: >-
  The assistant proposes changes to a draft, asks for confirmation in the chat, and applies them as one undoable group
status: pending
priority: P1
last_updated: '2026-10-13'
generated:
  by: agent/claude-code
  at: '2026-10-13T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-066
    name: In-app assistant phase 1: conversations, memory, read-only tools
    url: /TASKS.md#TASK-066
  - id: TASK-065
    name: Redo in the undo system
    url: /TASKS.md#TASK-065
related_decisions:
  - id: DEC-027
    name: The in-app assistant is a companion that inherits the user's privileges, edits only drafts, and keeps scoped memory
    url: /DECISIONS.md#DEC-027
modified:
  by: agent/claude-code
  at: '2026-10-13T09:00:00.000Z'
---
# TASK-067 — Assistant phase 2: bulk edits confirmed in the chat

Phase 2 of docs/assistant-plan.md (DEC-027).

- Write tools produce proposed operations, never writes: edit fields, notes, move/re-parent (moveMany), create, delete (to Trash), merge/split, rename/re-code, accept or dismiss suggested links.
- Rule edits (swap or fill fields, re-code, re-parent by rule, delete by filter) are done by deterministic recipes the model selects and parameterises; ordinary code transforms every row. Text edits (translate, tidy OCR errors, write short titles) are written by the model in batches within the cap and marked as AI-written until accepted.
- Dry run through the same core services, so an invalid change is refused before the person is asked.
- In-chat confirmation: the assistant states what it will do, with the count and two or three examples; the apply step accepts only a one-time token issued by the chat's Do it button, tied to that exact change set. A changed proposal needs a new confirmation.
- Drafts only: it may create a draft; it never touches a published version; at most 500 changes per apply.
- Apply is one undoable group (Undo and Redo); deletes go to the Trash.
- Evaluation set of 30 to 40 sample instructions with the change sets they should produce.
Start after the owner has tried phase 1 and the first real run has shown which bulk edits matter.
