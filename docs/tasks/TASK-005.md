---
id: TASK-005
title: Hono API with the five-step middleware chain
description: authenticate → authorize(requires) → transaction with SET LOCAL → validate → handle; OpenAPI
status: pending
priority: P0
assignee: ''
tags:
  - ams
last_updated: '2026-10-05'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:51.277Z'
roadmap_item:
  id: ROADMAP-001
  name: M0 — Scaffold and integrity foundation
  url: /ROADMAP.md#ROADMAP-001
depends_on:
  - id: TASK-004
    name: RLS via session settings and audit trigger
    url: /TASKS.md#TASK-004
related_bugs: []
related_decisions:
  - id: DEC-010
    name: One middleware chain for every request and background job
    url: /DECISIONS.md#DEC-010
modified:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:51.277Z'
---
# TASK-005 — Hono API with the five-step middleware chain

Route registration helper requires a requires(permission, scope) declaration; the app refuses to start otherwise. Transaction helper sets app.user_id, app.institution_id, app.request_id. @hono/zod-openapi generates the spec. Serves the SPA build in production.
