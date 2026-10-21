---
id: TASK-106
title: Entity schema registry and data dictionary
description: >-
  One declared schema per entity in packages/shared, from which the API, the AI extraction schemas, the review
  choices, the BI contract and a read-only data dictionary are derived.
status: pending
priority: P1
last_updated: '2026-10-21'
generated:
  by: agent/claude-code
  at: '2026-10-21T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
related_decisions:
  - id: DEC-033
    name: 'Every AI-powered document place also takes a URL; cycle templates take resources; programs and courses have schemas; every entity has a declared schema'
    url: /DECISIONS.md#DEC-033
modified:
  by: agent/claude-code
  at: '2026-10-21T12:00:00.000Z'
---
# TASK-106 — Entity schema registry and data dictionary

Plan docs/schema-and-sources-plan.md 2.5. First entities: evidence item, evidence version, dataset spec, program, course, org unit, framework requirement, cycle template. A test fails when declared schema and database columns disagree. `GET /api/bi/v0/schema/{entity}` and docs/data-dictionary.md; Settings -> Data dictionary (read-only, export JSON/CSV).
