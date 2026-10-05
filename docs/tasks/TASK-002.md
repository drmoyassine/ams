---
id: TASK-002
title: Docker images and Compose
description: app and worker images; Compose with postgres and minio; env-only config
status: pending
priority: P0
assignee: ''
tags:
  - ams
last_updated: '2026-10-05'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:47.008Z'
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
  - id: DEC-008
    name: Host-agnostic deployment on open standards
    url: /DECISIONS.md#DEC-008
modified:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:47.008Z'
---
# TASK-002 — Docker images and Compose

Images: app (Hono API serving the built SPA) and worker. Compose adds postgres:16 and minio with healthchecks and volumes. .env.example documents every variable. No provider-specific service.
