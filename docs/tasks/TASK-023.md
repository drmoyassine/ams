---
title: Applicability matcher and requirement instantiation
description: Match applies_when tags to a subject and create engagement_requirement rows
status: pending
priority: P0
id: TASK-023
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T12:38:14.792Z'
roadmap_item:
  id: ROADMAP-003
  name: M2 — Engagements and roadmaps
  url: /ROADMAP.md#ROADMAP-003
related_decisions:
  - id: DEC-002
    name: Accreditor frameworks are versioned configuration; no accreditor-specific code
    url: /DECISIONS.md#DEC-002
modified:
  by: agent/claude-code
  at: '2026-10-05T12:38:14.792Z'
---
# TASK-023 — Applicability matcher and requirement instantiation

# Applicability matcher and requirement instantiation
PRD §7.3 and §8.3. scope, degree_level, program_tags, engagement_kind; empty means always. Assessable requirements only; non-matching rows are created with applicable false so a lead can switch them on with a reason. No accreditor identity is ever consulted.
