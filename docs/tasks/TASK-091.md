---
id: TASK-091
title: Report model and engine core
description: >-
  Create a report from a template: report and section tables, requirement codes resolved, section owners from
  requirement owners or champions, statuses, permissions, Trash, Undo, audit and API.
status: completed
priority: P0
last_updated: '2026-10-25'
generated:
  by: agent/claude-code
  at: '2026-10-21T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-005
  name: M4 — Reports and submissions
  url: /ROADMAP.md#ROADMAP-005
modified:
  by: agent/claude-code
  at: '2026-10-25T10:21:33.124Z'
---
# TASK-091 — Report model and engine core

PRD §10.1, §10.2, §10.4 step 1. Tables `report`, `report_section` (round field reserved for M5), created from `report_template.structure` of any framework version (external or IQF). Section owners default to the requirement's owner or, for IQF standards, the champion (TASK-086). Never 'met'/'compliant' (DEC-005). Plan: docs/reports-and-cycles-plan.md.
