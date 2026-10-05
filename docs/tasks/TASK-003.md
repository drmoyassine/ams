---
id: TASK-003
title: Schema and migrations for org, access and shared tables
description: Drizzle schema + SQL migrations for PRD §6.1 and §6.8
status: pending
priority: P0
assignee: ''
tags:
  - ams
last_updated: '2026-10-05'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:48.373Z'
roadmap_item:
  id: ROADMAP-001
  name: M0 — Scaffold and integrity foundation
  url: /ROADMAP.md#ROADMAP-001
depends_on:
  - id: TASK-001
    name: Scaffold pnpm workspace
    url: /TASKS.md#TASK-001
related_bugs: []
related_decisions:
  - id: DEC-007
    name: One PostgreSQL database; not a database per accreditation standard
    url: /DECISIONS.md#DEC-007
modified:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:48.373Z'
---
# TASK-003 — Schema and migrations for org, access and shared tables

Tables: institution, org_unit, program, app_user, role_assignment (incl. engagement_lead, co_lead), comment, audit_event, job, extraction_item. Every table has id, institution_id, created/updated by/at. Migrations are committed SQL.
