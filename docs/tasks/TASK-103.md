---
id: TASK-103
title: Cycle template resources and AI-proposed stages
description: >-
  A cycle template gets a Docs tab of documents and URLs kept as resources, and an import target that proposes stages
  from them for review and applies them to the draft template.
status: pending
priority: P2
last_updated: '2026-10-21'
generated:
  by: agent/claude-code
  at: '2026-10-21T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-102
    name: Sources by URL for every document import
    url: /TASKS.md#TASK-102
  - id: TASK-106
    name: Entity schema registry and data dictionary
    url: /TASKS.md#TASK-106
related_decisions:
  - id: DEC-033
    name: 'Every AI-powered document place also takes a URL; cycle templates take resources; programs and courses have schemas; every entity has a declared schema'
    url: /DECISIONS.md#DEC-033
modified:
  by: agent/claude-code
  at: '2026-10-21T12:00:00.000Z'
---
# TASK-103 — Cycle template resources and AI-proposed stages

Plan 2.2. New scope kind `cycle_template`; target proposes stages (name, process, checklist, outputs, inputs, owner rule, offsets); applied to a draft only, one undoable change; resources shown on cycles made from the template.
