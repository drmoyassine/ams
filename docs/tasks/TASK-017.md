---
id: TASK-017
title: Framework JSON import and export
description: Export a framework version to one JSON file and import it (PRD 7.7) with schema validation; deterministic round-trip
status: pending
priority: P0
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T09:37:25.759Z'
roadmap_item:
  id: ROADMAP-002
  name: M1 — Framework library
  url: /ROADMAP.md#ROADMAP-002
depends_on:
  - id: TASK-016
    name: Framework core services
    url: /TASKS.md#TASK-016
related_decisions:
  - id: DEC-002
    name: Accreditor frameworks are versioned configuration; no accreditor-specific code
    url: /DECISIONS.md#DEC-002
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
modified:
  by: agent/claude-code
  at: '2026-10-05T09:37:25.759Z'
---
# TASK-017 — Framework JSON import and export

Import creates a draft version. Round-trip test: export, import, export is identical modulo ids.
