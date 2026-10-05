---
id: TASK-009
title: CI pipeline
description: Migrations on throwaway Postgres + MinIO, unit and e2e tests, route-permission enumeration, vef check
status: completed
priority: P0
assignee: ''
tags:
  - ams
last_updated: '2026-10-05'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:56.464Z'
roadmap_item:
  id: ROADMAP-001
  name: M0 — Scaffold and integrity foundation
  url: /ROADMAP.md#ROADMAP-001
depends_on:
  - id: TASK-002
    name: Docker images and Compose
    url: /TASKS.md#TASK-002
related_bugs: []
related_decisions:
  - id: DEC-008
    name: Host-agnostic deployment on open standards
    url: /DECISIONS.md#DEC-008
  - id: DEC-010
    name: One middleware chain for every request and background job
    url: /DECISIONS.md#DEC-010
modified:
  by: agent/claude-code
  at: '2026-10-05T09:04:48.818Z'
---
# TASK-009 — CI pipeline

Add an application workflow alongside the managed .github/workflows/vef.yml. Fail on any route lacking requires(...).
