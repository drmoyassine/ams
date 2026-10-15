---
id: TASK-086
title: 'IQF in operation: Link evidence, Assign scope, Assign champion, Create cycle'
description: >-
  The IQF tree in Quality Management gets the menu Link evidence, Assign scope, Assign champion, Create cycle; scope
  levels in Settings; scope and champions cascade top-down and to mapped external requirements, with overrides
status: pending
priority: P1
last_updated: '2026-10-15'
generated:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-078
    name: 'Cycles: schema, permissions and core services'
    url: /TASKS.md#TASK-078
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
---
# TASK-086 — IQF in operation: Link evidence, Assign scope, Assign champion, Create cycle

Plan: docs/quality-management-plan.md (Standards in operation). `scope_level` (Settings -> Organization -> Institution; Institution, Unit, Program, Course placeholder), `requirement_scope`, `requirement_champion`; effective scope and champion resolved top-down, then through mappings for external requirements (union of scopes; champion only when the mapped nodes agree); overrides at any level; carried to the next version with mappings and evidence links. The IQF tree view in Quality Management with the new ⋯ menu; "Request evidence" leaves the menu (requested through cycles); Settings -> IQF stays authoring only.
