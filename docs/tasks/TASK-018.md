---
id: TASK-018
title: Framework API routes and permissions
description: >-
  Hono routes via secured(): framework:read, framework:write, framework:publish permissions; OpenAPI; route-coverage
  test passes
status: completed
priority: P0
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T09:37:27.483Z'
roadmap_item:
  id: ROADMAP-002
  name: M1 — Framework library
  url: /ROADMAP.md#ROADMAP-002
depends_on:
  - id: TASK-016
    name: Framework core services
    url: /TASKS.md#TASK-016
  - id: TASK-017
    name: Framework JSON import and export
    url: /TASKS.md#TASK-017
related_decisions:
  - id: DEC-002
    name: Accreditor frameworks are versioned configuration; no accreditor-specific code
    url: /DECISIONS.md#DEC-002
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
modified:
  by: agent/claude-code
  at: '2026-10-05T09:55:35.877Z'
---
# TASK-018 — Framework API routes and permissions

Extend ROLE_PERMISSIONS in packages/shared. Publish limited to admin/lead.
