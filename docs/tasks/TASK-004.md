---
id: TASK-004
title: RLS via session settings and audit trigger
description: Row-level security by institution and scope; append-only audit_event trigger
status: completed
priority: P0
assignee: ''
tags:
  - ams
last_updated: '2026-10-05'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:49.742Z'
roadmap_item:
  id: ROADMAP-001
  name: M0 — Scaffold and integrity foundation
  url: /ROADMAP.md#ROADMAP-001
depends_on:
  - id: TASK-003
    name: Schema and migrations for org, access and shared tables
    url: /TASKS.md#TASK-003
related_bugs: []
related_decisions:
  - id: DEC-010
    name: One middleware chain for every request and background job
    url: /DECISIONS.md#DEC-010
modified:
  by: agent/claude-code
  at: '2026-10-05T08:50:03.075Z'
---
# TASK-004 — RLS via session settings and audit trigger

Policies read current_setting('app.user_id') and current_setting('app.institution_id'). Audit trigger writes actor, action, target, before, after on insert/update/delete. audit_event is append-only (no update/delete).
