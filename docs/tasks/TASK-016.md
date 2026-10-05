---
id: TASK-016
title: Framework core services
description: >-
  packages/core/framework: create/edit tree, notes with authority rules (6.3), report templates, version lifecycle draft
  -> in_review -> published -> retired, new version from existing
status: pending
priority: P0
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T09:37:24.166Z'
roadmap_item:
  id: ROADMAP-002
  name: M1 — Framework library
  url: /ROADMAP.md#ROADMAP-002
depends_on:
  - id: TASK-014
    name: Published-frozen triggers and publish gate
    url: /TASKS.md#TASK-014
  - id: TASK-015
    name: Framework JSON schemas (config validation)
    url: /TASKS.md#TASK-015
related_decisions:
  - id: DEC-002
    name: Accreditor frameworks are versioned configuration; no accreditor-specific code
    url: /DECISIONS.md#DEC-002
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
modified:
  by: agent/claude-code
  at: '2026-10-05T09:37:24.166Z'
---
# TASK-016 — Framework core services

Authority rules: required needs a verified quote; only humans set institution_defined or promote ai_suggested. Services take (ctx, input) and never open connections.
