---
id: TASK-014
title: Published-frozen triggers and publish gate
description: >-
  Database enforcement of PRD 6.9 invariants 1-3: rows of a published/retired framework_version cannot change; publish
  gate; sample reports never create requirements
status: pending
priority: P0
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T09:37:20.778Z'
roadmap_item:
  id: ROADMAP-002
  name: M1 — Framework library
  url: /ROADMAP.md#ROADMAP-002
depends_on:
  - id: TASK-013
    name: 'M1 schema: framework library tables'
    url: /TASKS.md#TASK-013
related_decisions:
  - id: DEC-002
    name: Accreditor frameworks are versioned configuration; no accreditor-specific code
    url: /DECISIONS.md#DEC-002
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
modified:
  by: agent/claude-code
  at: '2026-10-05T09:37:20.778Z'
---
# TASK-014 — Published-frozen triggers and publish gate

Triggers, not service code. Do not relax a trigger to make a test pass. Tests: every table under a published version rejects insert/update/delete; publish refused while any item is not approved, a required note lacks a verified quote, or an AI item lacks a source reference.
