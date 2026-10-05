---
id: TASK-010
title: M0 acceptance tests
description: The three M0 done-when tests
status: completed
priority: P0
assignee: ''
tags:
  - ams
last_updated: '2026-10-05'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:57.833Z'
roadmap_item:
  id: ROADMAP-001
  name: M0 — Scaffold and integrity foundation
  url: /ROADMAP.md#ROADMAP-001
depends_on:
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
related_bugs: []
related_decisions:
  - id: DEC-010
    name: One middleware chain for every request and background job
    url: /DECISIONS.md#DEC-010
modified:
  by: agent/claude-code
  at: '2026-10-05T09:09:55.671Z'
---
# TASK-010 — M0 acceptance tests

1) Contributor scoped to program A cannot read program B rows (API and direct SQL with session settings). 2) Unprotected route fails startup/CI. 3) An API write creates audit_event with the caller's id.
