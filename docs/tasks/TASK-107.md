---
id: TASK-107
title: Documents to furnish and update the IQF and published standards
description: >-
  A Docs tab on the IQF (and on a published standard, which opens a new draft first): upload documents or URLs, analyse
  them, review proposals, and merge into the draft version without touching human edits.
status: completed
priority: P1
last_updated: '2026-10-26'
generated:
  by: agent/claude-code
  at: '2026-10-22T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on: []
related_decisions:
  - id: DEC-023
    name: Embeddings rank IQF mapping candidates; vectors are stored in plain PostgreSQL arrays
    url: /DECISIONS.md#DEC-023
modified:
  by: agent/claude-code
  at: '2026-10-26T10:53:04.063Z'
---
# TASK-107 — Documents to furnish and update the IQF and published standards

# TASK-107 — Documents to furnish and update the IQF and published standards

Done (2026-10-26), upload-based. The IQF has its Documents tab (the shared Docs tab, "document" not "source") and its analysis runs through the same generic engine as an external standard's, on the institution's own papers: the internal prompt variants (survey, structure, extract, recover v2) are chosen per run and recorded in promptVersions; the survey asks what the document is institution-side; the structure stage records the model's level labels on the run and never applies them (DEC-016 — the worker guard in migration 0068 refuses level_labels on an internal version at the database); embed and map are routed around (the framework is the frame); and the wording stage proposes edits to items a person wrote as wording_proposal rows — current text beside proposed text with the verified quote and page behind it and the reason — accepted or declined one by one from the review inbox above the Requirements tab. An acceptance is one edit on the item (back to review, undoable) and declines its sibling pendings; no-ops are never proposed; an accept whose item changed since is refused. A published version takes no analysis: the Documents tab offers "Start a new version" instead. DECIDED 2026-10-22 (owner): wording proposals are diffs a person accepts or declines, never applied silently, never to a published version. DECIDED 2026-10-26 (owner): upload-based only — URL sources come with TASK-102, which this task no longer depends on.
