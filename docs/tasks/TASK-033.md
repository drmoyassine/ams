---
title: Org chart editor
description: 'Tree editor over org units: add, rename, move, deactivate'
status: completed
priority: P0
id: TASK-033
last_updated: '2026-10-06'
generated:
  by: agent/claude-code
  at: '2026-10-06T05:43:32.066Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-032
    name: Settings shell, organization identity and branding
    url: /TASKS.md#TASK-032
related_decisions:
  - id: DEC-016
    name: Internal quality framework and glossary unify terminology; mappings live on each external standard
    url: /DECISIONS.md#DEC-016
modified:
  by: agent/claude-code
  at: '2026-10-06T05:52:18.220Z'
---
# TASK-033 — Org chart editor

# Org chart editor
Units are college, school, department, admin unit, other. Moving cannot create a cycle. A unit with active children or programs cannot be deactivated.
