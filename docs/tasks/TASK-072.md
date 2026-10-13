---
id: TASK-072
title: Org chart: visual builder (tree and chart view)
description: >-
  Org units are edited in a drag-and-drop tree and drawn as a chart (zoom, pan, collapse, right-to-left aware, export as
  image), with a head and programs on each unit
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
modified:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
---
# TASK-072 — Org chart: visual builder (tree and chart view)

Section E.1 of docs/organization-plan.md. Reuses the tree drag-and-drop, selection, Trash and Undo/Redo; configurable levels and types; names in both languages; each unit records its source (manual, image, directory). Lives in the Institution tab's Org chart section, with its Docs.
