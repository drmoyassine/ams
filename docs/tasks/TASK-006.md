---
id: TASK-006
title: Authentication with Better Auth
description: Password + generic OIDC; SAML spike against QuickLaunch
status: completed
priority: P0
assignee: ''
tags:
  - ams
last_updated: '2026-10-05'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:52.561Z'
roadmap_item:
  id: ROADMAP-001
  name: M0 — Scaffold and integrity foundation
  url: /ROADMAP.md#ROADMAP-001
depends_on:
  - id: TASK-005
    name: Hono API with the five-step middleware chain
    url: /TASKS.md#TASK-005
related_bugs: []
related_decisions:
  - id: DEC-015
    name: Better Auth for authentication (OIDC/SAML + password)
    url: /DECISIONS.md#DEC-015
modified:
  by: agent/claude-code
  at: '2026-10-05T08:58:25.569Z'
---
# TASK-006 — Authentication with Better Auth

Sessions in PostgreSQL. Seed admin from env. Record the SAML spike outcome as a decision update if a broker is needed.
