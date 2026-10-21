---
id: TASK-105
title: 'Courses: entity, schema, tab and import'
description: >-
  A real Course record with a declared schema, linked to programs many-to-many, a Courses tab under Settings ->
  Organization with a Docs tab, and the Course scope level listing real courses.
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
depends_on:
  - id: TASK-106
    name: Entity schema registry and data dictionary
    url: /TASKS.md#TASK-106
related_decisions:
  - id: DEC-033
    name: 'Every AI-powered document place also takes a URL; cycle templates take resources; programs and courses have schemas; every entity has a declared schema'
    url: /DECISIONS.md#DEC-033
modified:
  by: agent/claude-code
  at: '2026-10-21T12:00:00.000Z'
---
# TASK-105 — Courses: entity, schema, tab and import

Plan 2.4. `course`, `course_program` (role core/elective/service, year, term); Trash and Undo; import target from a course catalogue; DEC-028's two-tab Organization screen becomes three tabs (recorded in DEC-033).
