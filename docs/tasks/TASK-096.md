---
id: TASK-096
title: 'Reports in Accreditations: milestones produce reports'
description: >-
  A milestone with a report deliverable creates its report, submitting completes the milestone, and recurring
  milestones create a report each period.
status: pending
priority: P1
last_updated: '2026-10-21'
generated:
  by: agent/claude-code
  at: '2026-10-21T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-005
  name: M4 — Reports and submissions
  url: /ROADMAP.md#ROADMAP-005
depends_on:
  - id: TASK-091
    name: Report model and engine core
    url: /TASKS.md#TASK-091
  - id: TASK-094
    name: Report workflow, internal approval and submission snapshot
    url: /TASKS.md#TASK-094
modified:
  by: agent/claude-code
  at: '2026-10-21T09:00:00.000Z'
---
# TASK-096 — Reports in Accreditations: milestones produce reports

Replaces the report part of TASK-082. Engagement milestones already carry `deliverable.report_template_key`, `report_id` and `recurrence`; nothing fills them yet.
