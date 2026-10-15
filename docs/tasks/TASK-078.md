---
id: TASK-078
title: 'Cycles: schema, permissions and core services'
description: >-
  The five cycle tables, cycle permissions, core services and API, with responsible unit and owner resolution, Trash,
  Undo and audit
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
  - id: TASK-077
    name: 'Quality Management: cycles and reporting (design)'
    url: /TASKS.md#TASK-077
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
---
# TASK-078 — Cycles: schema, permissions and core services

Plan: docs/quality-management-plan.md (Schema). Migration with `cycle_template`, `cycle`, `cycle_stage`, `cycle_output`, `cycle_input` (tenant RLS, audit, Trash kind `cycle`); permissions `cycle:read`, `cycle:manage`, `cycle:work`; Zod schema for the template's `stages`; core services: launch a cycle from a template (resolve responsible unit and owner per stage, dates from offsets, wire inputs to outputs), start/complete/skip stages (completed only when required outputs are final), fill outputs (document upload, note, approval with approve / approve with conditions / return, where return reopens the producing stage), cancel with a reason; anchors checked by the service; Undo descriptors; db, core and API tests. Report outputs wait for TASK-085.
