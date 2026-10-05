---
id: TASK-015
title: Framework JSON schemas (config validation)
description: >-
  Zod schemas in packages/shared for lifecycle_template, decision/finding/response vocabularies, applies_when,
  rating_method and report_template.structure (PRD 7.1-7.6, 10.2) with example fixtures from Appendix A
status: pending
priority: P0
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T09:37:22.494Z'
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
  at: '2026-10-05T09:37:22.494Z'
---
# TASK-015 — Framework JSON schemas (config validation)

One schema set reused by API, SPA and worker. No accreditor-specific branches (DEC-002).
