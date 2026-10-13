---
id: TASK-075
title: Documents and AI import foundation: registry, Docs tab, Documents area
description: >-
  One shared pattern for places where the AI reads uploaded documents and fills drafts: an upload registry, a reusable
  Docs tab (who uploaded, when, status, import history), a general Documents area, and the standards' Sources becoming
  their Docs tab
status: pending
priority: P2
last_updated: '2026-10-13'
generated:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-069
    name: Organization screen: Institution and Programs tabs, institution logo, read-only Settings
    url: /TASKS.md#TASK-069
related_decisions:
  - id: DEC-028
    name: Organization has two tabs; one secondary language; translations of standards are unofficial; per-person UI language; org-chart images may go to the vision model; every AI-import place gets a Docs tab
    url: /DECISIONS.md#DEC-028
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
modified:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
---
# TASK-075 — Documents and AI import foundation: registry, Docs tab, Documents area

Section A of docs/organization-plan.md.
- import_document table (scope kind and id, file, name, type, size, hash, language, uploader, time, read status, pages; Trash on delete); standards keep source_document and the Docs list reads both through one adapter. Evidence is never listed or sent to the AI.
- One Docs tab component: list with who and when, upload (many files), open, re-read, delete, Import, and the history of imports with their reports; permissions follow the scope (read to see, write to upload and import).
- Version page: Sources becomes the Docs tab beside Requirements, Mappings and Report; the IQF page and the Organization sections get a Docs tab.
- Settings -> Documents: every upload the person may see, filters by place, uploader, date, type, status, each linking to where it is used.
- Import engine: a target registry (Zod schema, versioned prompt, validator, proposal writer) and an `import` job in the agent service (read through the parser, extract, verify, propose) with budget, cancel, resume and a report; proposals are reviewed in an editable table beside the source page and applied as one undoable change; never overwrites a person's edits.
