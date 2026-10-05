---
id: TASK-013
title: 'M1 schema: framework library tables'
description: >-
  Drizzle schema + SQL migration for PRD 6.2 and 6.3: accreditor, framework, framework_version, source_document,
  source_page, requirement, requirement_note, report_template, with provenance fields, CHECK constraints, RLS and audit
  triggers
status: completed
priority: P0
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T09:37:19.113Z'
roadmap_item:
  id: ROADMAP-002
  name: M1 — Framework library
  url: /ROADMAP.md#ROADMAP-002
depends_on: []
related_decisions:
  - id: DEC-002
    name: Accreditor frameworks are versioned configuration; no accreditor-specific code
    url: /DECISIONS.md#DEC-002
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
modified:
  by: agent/claude-code
  at: '2026-10-05T09:39:43.584Z'
---
# TASK-013 — M1 schema: framework library tables

Tables and columns exactly as PRD 6.2/6.3. Authority and provenance enums enforced by CHECK. RLS by institution_id. Tests in packages/db.
