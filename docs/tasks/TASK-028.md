---
title: Engagement API routes and permissions
description: Hono routes through secured() with engagement permissions
status: pending
priority: P0
id: TASK-028
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T12:38:24.850Z'
roadmap_item:
  id: ROADMAP-003
  name: M2 — Engagements and roadmaps
  url: /ROADMAP.md#ROADMAP-003
depends_on:
  - id: TASK-024
    name: 'Engagement service: create, members, lead handover'
    url: /TASKS.md#TASK-024
  - id: TASK-025
    name: Roadmap editing, guardrails and phase advance
    url: /TASKS.md#TASK-025
  - id: TASK-026
    name: Template-update review
    url: /TASKS.md#TASK-026
  - id: TASK-027
    name: Requirement workspace service
    url: /TASKS.md#TASK-027
related_decisions:
  - id: DEC-010
    name: One middleware chain for every request and background job
    url: /DECISIONS.md#DEC-010
modified:
  by: agent/claude-code
  at: '2026-10-05T12:38:24.850Z'
---
# TASK-028 — Engagement API routes and permissions

# Engagement API routes and permissions
Every route declares requires(...); pnpm test:routes must stay green. New permissions for engagement read, write, manage members, roadmap edit. Typed client types flow to the SPA.
