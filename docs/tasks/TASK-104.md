---
id: TASK-104
title: Program schema
description: >-
  Programs get declared columns: code, names, degree level, discipline, owning unit, mode, duration, credits,
  language, campus, status, start year, description, tags, external id.
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
# TASK-104 — Program schema

Plan 2.3. Additive migration, every existing row valid. The Programs import target writes the new fields; the Programs screen shows and edits them.
