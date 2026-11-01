---
title: 'Outcomes and links: ILO, PEO, PLO, performance indicators and CLO with configurable mapping levels'
description: >-
  Versioned outcome records on the institution, program and course; links CLO-PLO (with level), PLO-ILO, PLO-PEO;
  coverage checks (every PLO reaches mastery, every course maps to a PLO, orphans and over-coverage).
status: completed
priority: P1
id: TASK-112
last_updated: '2026-11-01'
generated:
  by: agent/claude-code
  at: '2026-11-01T12:25:31.245Z'
roadmap_item:
  id: ROADMAP-014
  name: 'Assessment of learning: outcomes, plans, results and closing the loop'
  url: /ROADMAP.md#ROADMAP-014
depends_on:
  - id: TASK-104
    name: Program schema
    url: /TASKS.md#TASK-104
  - id: TASK-105
    name: 'Courses: entity, schema, tab and import'
    url: /TASKS.md#TASK-105
related_decisions:
  - id: DEC-036
    name: Outcome mapping levels are configuration; the default is I/R/M and D is read as R
    url: /DECISIONS.md#DEC-036
modified:
  by: agent/claude-code
  at: '2026-11-01T13:49:20.981Z'
---
# TASK-112 — Outcomes and links: ILO, PEO, PLO, performance indicators and CLO with configurable mapping levels

Done (2026-11-01): migration 0073 (learning_outcome for ILO/PEO/PLO/performance indicator/CLO, outcome_link with database checks, institution.outcome_levels), services in packages/core/src/outcomes, routes mounted as OutcomeRoutes (own typed client), Settings -> Organization tabs Courses and Learning outcomes, the program Outcomes view with the curriculum map and coverage checks. Approved outcomes are retired, never deleted. Tests: packages/core/src/outcomes/outcomes.test.ts, apps/web/src/outcomes-ui.test.tsx.
