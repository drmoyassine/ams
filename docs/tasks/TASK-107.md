---
id: TASK-107
title: Documents to furnish and update the IQF and published standards
description: >-
  A Docs tab on the IQF (and on a published standard, which opens a new draft first): upload documents or URLs,
  analyse them, review proposals, and merge into the draft version without touching human edits.
status: pending
priority: P1
last_updated: '2026-10-22'
generated:
  by: agent/claude-code
  at: '2026-10-22T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-102
    name: Sources by URL for every document import
    url: /TASKS.md#TASK-102
related_decisions:
  - id: DEC-023
    name: Embeddings rank IQF mapping candidates; vectors are stored in plain PostgreSQL arrays
    url: /DECISIONS.md#DEC-023
modified:
  by: agent/claude-code
  at: '2026-10-22T09:00:00.000Z'
---
# TASK-107 — Documents to furnish and update the IQF and published standards

The compiler already merges into an existing DRAFT of an external standard by code (adds new, updates AI-written rows, keeps human edits). Gaps: the IQF has no Docs tab or analysis; a published version is frozen so documents must go to a new draft. Build: IQF Docs tab (same engine on the internal framework, authority classes adapted), 'Add documents' on a published version that offers 'Start a new version', URL sources (TASK-102), and a clear result report (added, updated, kept human edits, notes). DECIDED 2026-10-22 (owner): documents may also PROPOSE EDITS to the wording of existing human-written requirements, shown as a diff (current text beside the proposed text, with the quote it came from) that a person accepts or declines per item; never applied silently, never to a published version (new draft first), Undo after applying.
