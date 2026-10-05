---
id: TASK-008
title: Worker skeleton with pg-boss
description: Job runner using the same identity-carrying transaction helper
status: completed
priority: P0
assignee: ''
tags:
  - ams
last_updated: '2026-10-05'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:55.117Z'
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
  by: agent/claude-code
  at: '2026-10-05T09:03:51.451Z'
---
# TASK-008 — Worker skeleton with pg-boss

Jobs record the queuing user's id or a named system identity; RLS and audit apply inside jobs. One example job end to end.
