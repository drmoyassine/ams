---
id: TASK-073
title: Org chart from an uploaded image
description: >-
  Upload a picture or PDF of an org chart; the vision model proposes the tree; the person reviews and applies it as one
  undoable change (a Docs-pattern import)
status: pending
priority: P3
last_updated: '2026-10-13'
generated:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-072
    name: Org chart: visual builder (tree and chart view)
    url: /TASKS.md#TASK-072
  - id: TASK-075
    name: Documents and AI import foundation: registry, Docs tab, Documents area
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
# TASK-073 — Org chart from an uploaded image

Section E.2 of docs/organization-plan.md. The image and the names on it go to the AI vision model (decided, DEC-028). Proposal beside the image, editable, applied as one undoable group; never overwrites units a person edited.
