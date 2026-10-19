---
id: TASK-081
title: Cycle recurrence, academic terms and plans with inheritance
description: >-
  Cycles repeat (term, year, N years, after the previous one); academic terms in Settings; cycle plans on anchors
  inherit down the IQF and to mapped external requirements, with override and opt-out; next runs proposed for QA to
  launch
status: pending
priority: P2
last_updated: '2026-10-15'
generated:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-013
  name: 'Quality Management: cycles and reporting'
  url: /ROADMAP.md#ROADMAP-013
depends_on:
  - id: TASK-080
    name: 'Quality Management screens: cycles list, new cycle, cycle page, My work'
    url: /TASKS.md#TASK-080
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
---
# TASK-081 — Cycle recurrence, academic terms and plans with inheritance

Plan: Worked examples, items 1, 3, 4. `cycle_plan`, `academic_term`, `cycle.plan_id`, `cycle.period_label`; inheritance: own plan or nearest ancestor's; an external requirement follows its mapped IQF node's plan unless it has its own; proposed runs listed for QA (auto-launch per template later, DEC-029).
