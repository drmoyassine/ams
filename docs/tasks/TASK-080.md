---
id: TASK-080
title: 'Quality Management screens: cycles list, new cycle, cycle page, My work'
description: >-
  The Quality Management menu becomes real: list and filters, launch a cycle, the cycle page with stages, inputs,
  process and outputs, and My work
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
  - id: TASK-079
    name: 'Cycle templates: Settings section, editor and shipped defaults'
    url: /TASKS.md#TASK-079
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
---
# TASK-080 — Quality Management screens: cycles list, new cycle, cycle page, My work

Plan: Screens. Replaces the placeholder at /quality-management. Cycle page: stages as a timeline and a list with responsible unit, owner, dates, status, inputs (missing ones flagged, never blocking), process text and checklist, output slots and their state; approvals decided by the named approver; Arabic dir=auto; responsive at 375/768/1280; "Internally approved", never "met"/"compliant" (DEC-005).
