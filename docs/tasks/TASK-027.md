---
title: Requirement workspace service
description: Statuses, owners, reviewers, working notes and applicability override
status: completed
priority: P0
id: TASK-027
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T12:38:22.873Z'
roadmap_item:
  id: ROADMAP-003
  name: M2 — Engagements and roadmaps
  url: /ROADMAP.md#ROADMAP-003
depends_on:
  - id: TASK-024
    name: 'Engagement service: create, members, lead handover'
    url: /TASKS.md#TASK-024
related_decisions:
  - id: DEC-005
    name: Official accreditation status is separate from internal readiness; no compliance scores
    url: /DECISIONS.md#DEC-005
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
modified:
  by: agent/claude-code
  at: '2026-10-05T13:06:25.672Z'
---
# TASK-027 — Requirement workspace service

# Requirement workspace service
PRD §8.4. contributor to ready_for_review, reviewer to approved or needs_work; the label is Internally approved and never compliant or met (DEC-005). Applicability override needs a reason. History comes from the audit trail.
