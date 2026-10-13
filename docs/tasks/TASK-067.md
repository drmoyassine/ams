---
id: TASK-067
title: Assistant phase 2: bulk edits confirmed in the chat
description: >-
  The assistant proposes changes to a draft, asks for confirmation in the chat, and applies them as one undoable group (built:
  change sets, recipes, one-time confirmation token, one undo group with Redo, marking of texts the assistant wrote, evaluation set)
status: completed
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
  at: '2026-10-13T14:00:00.000Z'
---
# TASK-067 — Assistant phase 2: bulk edits confirmed in the chat

Phase 2 of docs/assistant-plan.md (DEC-027). Built 2026-10-13; the plan's Status section says what is where.

- **Change sets** (`packages/shared/src/assistant-changes.ts`, `packages/core/src/assistant/changes/`): an ordered list of typed operations {op, targets/filter, params}. The model picks operations and parameters; ordinary code reads the current data, simulates the operations in memory and produces exact steps (one core-service call each), counts, 2 to 3 real before/after examples per operation, skipped items with reasons, named deletes and the problems that make it impossible (cycle, code collision, frozen version, permission, bad pattern).
- **Recipes** (deterministic): swap_title_and_description (reuses `placeWording`, both directions), set_field_by_filter, copy_field, prefix_or_replace_text (literal or regex, NFC, no direction marks), recode (collision report, links by code counted), reparent_by_rule, delete_by_filter, bulk_set_assessable, bulk_set_level_label; plus set_fields, set_note_fields, move, create_requirement, merge, split, accept_suggested_links, dismiss_suggested_links, rewrite_text (the model writes the text per item in batches, `draft_rewrites`), create_draft (a separate confirmed step). A filter engine shared by the recipes and the read tool `find_requirements`.
- **Tools** (propose only): `propose_changes`, `create_draft_proposal`, `find_requirements`, `draft_rewrites`; prompt `assistant.v2` (v1 kept), `assistant_rewrite.v1`. The registry has no tool that applies anything.
- **Confirmation and apply** (API, five-step chain): `POST /api/assistant/change-proposals/{messageId}/{partId}/confirm|apply|decline`. A one-time token (`assistant_confirmation`, written only by the confirm endpoint, ten minutes, SHA-256 stored, consumed atomically) tied to the person, the message part and the hash of the exact operations; apply re-plans on the current data and refuses (stale, nothing changed) when the result is not exactly what was confirmed; all steps run in one transaction as the person; one failing step rolls back everything.
- **Undo and Redo as one group**: `assistant_change_set` stores the ordered undo descriptors the services reported; the apply reports ONE small descriptor (`POST /api/assistant/changes/{id}/undo`); undo replays them in one transaction and what it reports becomes the redo (`/redo`), so the toast, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and the Undo / Redo buttons in the chat card all work. Audit: one `assistant_change_set` event with counts, never the words.
- **Texts written by the assistant** (`assistant_written_text`): marker on the requirement with Keep and Revert (an ordinary, undoable edit); unreviewed texts show as a non-blocking validation warning.
- **UI**: the proposal card in the chat (all states), Undo / Redo in the card, "Written by the assistant" marker; works as the full-screen sheet on a phone.
- **Evaluation**: `packages/core/eval/assistant-instructions.json` (40 sample instructions, 13 in Arabic, on a fixture tree); unit tests assert exact rows; `pnpm assistant:eval` also asks a real model when keys are configured.
- Not in this task: IQF proposals as an operation (links only), streaming of progress, a nightly clean-up of expired confirmations.
