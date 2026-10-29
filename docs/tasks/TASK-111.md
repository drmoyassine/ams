---
title: 'Draft the institution''s quality framework from documents: headings per window, one organise call, review, apply'
description: >-
  A new import target iqf_tree and a reusable organise stage turn policy and standards documents into Standards and
  Sub-standards with titles, traced to pages and quotes, applied as an undoable group of draft items.
status: in-progress
priority: P1
id: TASK-111
last_updated: '2026-10-29'
generated:
  by: agent/claude-code
  at: '2026-10-28T11:44:14.902Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
modified:
  by: agent/claude-code
  at: '2026-10-29T05:36:37.617Z'
---
# TASK-111 — Draft the institution's quality framework from documents: headings per window, one organise call, review, apply

Done (2026-10-28): the `organise` stage of the import engine (migration 0071); prompts `iqf_outline` and `iqf_organise`; the `iqf_tree` target (Standard / Sub-standard with code, title, optional Arabic title, description; apply as the person, skip existing codes, Undo/Redo through the Trash); tests; docs/ai-import.md section 2.6. Page rotation per document (migration 0072, `parseDocument({ rotation })`, "Turn pages" on the Docs row, `POST /api/documents/{id}/rotate`).

Open: run it on the owner's real files (needs the Reading model configured in Settings -> AI; the PUC scan needs one quarter turn); automatic detection of sideways scans; the "From this document" filter on the IQF list and "Evidence for those items" on the Evidence list (meaning to be confirmed with the owner); load the PUC standard as an external standard so it maps onto the IQF.
