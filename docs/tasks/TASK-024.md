---
title: 'Engagement service: create, members, lead handover'
description: 'Wizard transaction in packages/core: members, lead, requirements, milestones, current phase'
status: pending
priority: P0
id: TASK-024
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T12:38:16.801Z'
roadmap_item:
  id: ROADMAP-003
  name: M2 — Engagements and roadmaps
  url: /ROADMAP.md#ROADMAP-003
depends_on:
  - id: TASK-021
    name: 'M2 schema: engagement, milestone, engagement_requirement, RLS and invariants'
    url: /TASKS.md#TASK-021
  - id: TASK-022
    name: Due-rule engine
    url: /TASKS.md#TASK-022
  - id: TASK-023
    name: Applicability matcher and requirement instantiation
    url: /TASKS.md#TASK-023
related_decisions:
  - id: DEC-003
    name: Universal five-phase lifecycle with per-engagement editable roadmaps
    url: /DECISIONS.md#DEC-003
  - id: DEC-010
    name: One middleware chain for every request and background job
    url: /DECISIONS.md#DEC-010
modified:
  by: agent/claude-code
  at: '2026-10-05T12:38:16.801Z'
---
# TASK-024 — Engagement service: create, members, lead handover

# Engagement service: create, members, lead handover
PRD §8.1 steps 1, 2, 3, 5 and §4 leadership rules. One transaction. Exactly one engagement_lead; only an admin or the current lead hands over, audited, outgoing lead becomes a member. Only published framework versions. Step 4 (create the self-study report) and step 6 (copy evidence links, carry forward feedback) wait for M4, M3 and M5 and are recorded as such. Admin may act as lead.
