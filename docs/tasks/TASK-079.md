---
id: TASK-079
title: 'Cycle templates: Settings section, editor and shipped defaults'
description: >-
  Settings -> Quality Management lists and edits cycle templates (stages, owners, dates, inputs, outputs, anchors they
  fit) with versions and shipped defaults
status: pending
priority: P1
last_updated: '2026-10-15'
generated:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-013
  name: 'Quality Management: cycles and reporting'
  url: /ROADMAP.md#ROADMAP-013
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
# TASK-079 — Cycle templates: Settings section, editor and shipped defaults

Plan: Templates. Draft -> published -> retired, version +1 on publish, running cycles keep their version. Defaults (data, never code, DEC-002): annual program report, periodic program review, admin unit review, internal audit, course assessment (semesterly), blank custom. Import of the institution's own templates through the Docs tab pattern comes later (TASK-075 engine).
