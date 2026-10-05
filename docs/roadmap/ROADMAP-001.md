---
id: ROADMAP-001
title: M0 — Scaffold and integrity foundation
description: Workspace, Compose, schema for org/access/shared tables, auth, RLS, audit, middleware chain, SPA shell, worker, CI
quarter: Q4
status: In Progress
priority: P0
tags:
  - ams
last_updated: '2026-10-05'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:30.131Z'
vision_theme:
  id: integrity-by-construction
  name: Integrity is enforced by the system, not by discipline
  url: /VISION.md#integrity-by-construction
related_decisions:
  - id: DEC-007
    name: One PostgreSQL database; not a database per accreditation standard
    url: /DECISIONS.md#DEC-007
  - id: DEC-008
    name: Host-agnostic deployment on open standards
    url: /DECISIONS.md#DEC-008
  - id: DEC-009
    name: React SPA (Vite) + Hono API on Node; not Next.js; Frontbase not used for the core
    url: /DECISIONS.md#DEC-009
  - id: DEC-010
    name: One middleware chain for every request and background job
    url: /DECISIONS.md#DEC-010
  - id: DEC-015
    name: Better Auth for authentication (OIDC/SAML + password)
    url: /DECISIONS.md#DEC-015
modified:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:57.833Z'
related_tasks:
  - id: TASK-001
    name: Scaffold pnpm workspace
    url: /TASKS.md#TASK-001
  - id: TASK-002
    name: Docker images and Compose
    url: /TASKS.md#TASK-002
  - id: TASK-003
    name: Schema and migrations for org, access and shared tables
    url: /TASKS.md#TASK-003
  - id: TASK-004
    name: RLS via session settings and audit trigger
    url: /TASKS.md#TASK-004
  - id: TASK-005
    name: Hono API with the five-step middleware chain
    url: /TASKS.md#TASK-005
  - id: TASK-006
    name: Authentication with Better Auth
    url: /TASKS.md#TASK-006
  - id: TASK-007
    name: React SPA shell
    url: /TASKS.md#TASK-007
  - id: TASK-008
    name: Worker skeleton with pg-boss
    url: /TASKS.md#TASK-008
  - id: TASK-009
    name: CI pipeline
    url: /TASKS.md#TASK-009
  - id: TASK-010
    name: M0 acceptance tests
    url: /TASKS.md#TASK-010
---
# ROADMAP-001 — M0 — Scaffold and integrity foundation

Done when: a contributor scoped to one program cannot read another program's rows; a route without requires(...) fails startup and CI; a write through the API produces an audit_event with the caller's id. PRD §18.4 M0.
