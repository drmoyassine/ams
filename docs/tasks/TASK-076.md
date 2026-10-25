---
id: TASK-076
title: 'Programs from documents: upload, AI parse, drafts'
description: >-
  On the Programs tab, upload a catalogue or program list, press Import, review the proposed programs beside the source
  page, and apply them as one undoable change
status: completed
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
  - id: TASK-075
    name: 'Documents and AI import foundation: registry, Docs tab, Documents area'
    url: /TASKS.md#TASK-075
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
# TASK-076 — Programs from documents: upload, AI parse, drafts

Section C of docs/organization-plan.md. Extractor for programs (name in English and Arabic, degree level, owning unit, code, duration, mode, whatever the document states); unit matching uses the org chart, an unknown unit becomes a proposed unit; re-importing a newer document proposes only what changed; Programs gets a Docs tab.

Built: import target `programs` (`packages/core/src/org/programs-import.ts`, prompt `import-programs.v1`) registered for the `programs` scope; Programs tab has a Docs tab with Import; review, apply and Undo/Redo use the shared engine. Tests: `org/programs-import.test.ts`, `programs-docs-ui.test.tsx`, responsive states.
