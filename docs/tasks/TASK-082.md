---
id: TASK-082
title: Nested cycles and cycles in Accreditations
description: >-
  A stage can run child cycles (yearly annual report during maintenance, interim report when the decision asks, ISO
  surveillance); cycles anchored to an engagement appear in Accreditations; engagements can have an org unit as
  subject
status: pending
priority: P2
last_updated: '2026-10-15'
generated:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-081
    name: Cycle recurrence, academic terms and plans with inheritance
    url: /TASKS.md#TASK-081
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
---
# TASK-082 — Nested cycles and cycles in Accreditations

Plan: Worked examples, items 2, 5, 6. `cycle.parent_cycle_id`, `parent_stage_id`; stage definition `child`; re-accreditation as the next run; `engagement.subject_type` gains `org_unit`; example templates for ABET, WSCUC and ISO maintenance shipped as data. Today's roadmap (milestones) stays as it is.
