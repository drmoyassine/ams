---
title: ICS calendar export
description: Calendar file of all milestones with due dates
status: completed
priority: P0
id: TASK-029
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T12:38:26.842Z'
roadmap_item:
  id: ROADMAP-003
  name: M2 — Engagements and roadmaps
  url: /ROADMAP.md#ROADMAP-003
depends_on:
  - id: TASK-024
    name: 'Engagement service: create, members, lead handover'
    url: /TASKS.md#TASK-024
related_decisions:
  - id: DEC-008
    name: Host-agnostic deployment on open standards
    url: /DECISIONS.md#DEC-008
modified:
  by: agent/claude-code
  at: '2026-10-05T13:13:18.411Z'
---
# TASK-029 — ICS calendar export

# ICS calendar export
PRD §8.2. Standards-only (RFC 5545), all-day events, stable UIDs so a re-import updates rather than duplicates, milestones without a due date are omitted.
