---
id: TASK-108
title: Meaning-based search and similar requirements; keep vectors current
description: >-
  Switch embeddings from mapping-only to a library feature: search the standards by meaning (Arabic and English), see
  similar requirements, keep vectors current when text changes, and show their status in Settings.
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
related_decisions:
  - id: DEC-023
    name: Embeddings rank IQF mapping candidates; vectors are stored in plain PostgreSQL arrays
    url: /DECISIONS.md#DEC-023
modified:
  by: agent/claude-code
  at: '2026-10-22T09:00:00.000Z'
---
# TASK-108 — Meaning-based search and similar requirements; keep vectors current

DEC-023 built embed(), the embedding table, hybrid ranking and the Settings model; today only the IQF mapping stage uses them and they are OFF by default and not yet measured (TASK-056 decides the default from `pnpm analysis:eval-mapping`). Add: (1) re-embed on edit/publish via a job and a Rebuild action with a cost estimate; (2) a library search box that ranks requirements by hybrid meaning + code/term match; (3) a 'Similar requirements' list on a requirement and in the Map to IQF dialog; (4) read tool for the assistant over framework text; (5) status in Settings -> AI (counts, model, last run). Framework text only (DEC-023 point 5): evidence, datasets, memories, requests are never embedded; assistant memory search (TASK-068) needs its own decision. Scores are internal ranking, never shown as coverage or confidence.
