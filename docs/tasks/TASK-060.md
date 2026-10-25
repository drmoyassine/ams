---
id: TASK-060
title: 'Compiler follow-ups: small gaps found while building steps A-F'
description: >-
  Backlog of known small gaps in the analysis, review and parser paths, none blocking the first real run
status: pending
priority: P2
last_updated: '2026-10-12'
generated:
  by: agent/claude-code
  at: '2026-10-12T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-055
    name: Create from files and the split-view review of an external standard's requirements
    url: /TASKS.md#TASK-055
related_decisions:
  - id: DEC-022
    name: External standards drafted by analysis are gated by publishing, not by per-line approval
    url: /DECISIONS.md#DEC-022
modified:
  by: agent/claude-code
  at: '2026-10-12T09:00:00.000Z'
---
# TASK-060 — Compiler follow-ups: small gaps found while building steps A-F

Pick up as the real runs show which matter.
- Undo for a deleted AI-made item that a person wants back (the dismissal record exists; no screen restores it).
- Arabic-letter numbering (أ ب ج) is not read as a sequence by the gap finder.
- Re-reading a file that now has fewer pages leaves the old extra pages (the worker cannot delete pages).
- The same new IQF item can be proposed twice when similar requirements fall in different chunks of about 20; deleting (not rejecting) a pending suggested link makes a later run propose it again.
- Merge keeps links by code, so links naming the merged code are not moved (the result says how many).
- Merge and split are audited through the row-level triggers, not a labelled event.
- Drag-and-drop re-parenting (only the Move dialog exists); the source viewer shows stored page text, not the PDF page image.
- No check that the parser service is alive (nothing records a heartbeat), so the readiness checklist cannot test it.
- OCR spend no longer counts against an analysis run's cap (it happens in the parser); a USD cap prices OCR at the analysis model's price.
- The `ocr` and `ai_extract` job types have no handlers; remove them or implement them.
- The Mappings tab suggestions are not covered by the phone-width layout check (no seed data there).
- `vef setup` and `vef check` have never been run on the task, roadmap and decision ledgers (vef is not installed in the build sandbox).
