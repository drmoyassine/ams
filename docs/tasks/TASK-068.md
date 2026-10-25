---
id: TASK-068
title: 'Assistant follow-ups: memory merging, meaning-based memory search, report chip'
description: >-
  Nightly merge of duplicate memories with contradiction flags, an amendment to DEC-023 before embedding memory text,
  the report run as a context chip
status: pending
priority: P3
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
    name: 'In-app assistant phase 1: conversations, memory, read-only tools'
    url: /TASKS.md#TASK-066
related_decisions:
  - id: DEC-027
    name: The in-app assistant is a companion that inherits the user's privileges, edits only drafts, and keeps scoped memory
    url: /DECISIONS.md#DEC-027
  - id: DEC-023
    name: Embeddings rank IQF mapping candidates; vectors are stored in plain PostgreSQL arrays
    url: /DECISIONS.md#DEC-023
modified:
  by: agent/claude-code
  at: '2026-10-13T09:00:00.000Z'
---
# TASK-068 — Assistant follow-ups: memory merging, meaning-based memory search, report chip

Left over from phase 1 (docs/assistant-plan.md).

- Nightly job in the agent service: merge duplicate memories and flag contradictions for a person to settle (it never picks one).
- Meaning-based retrieval of memory: needs an amendment to DEC-023 first (embeddings are limited to framework text); until then memory is found by words and codes.
- The report tab's selected run as a context chip.
- Version-page layout at about 1280px with the panel open (the title wraps tightly).
- Retrying a failed turn resends the same text; offer to edit it first.
