---
title: 'M2 schema: engagement, milestone, engagement_requirement, RLS and invariants'
description: Tables, forward-only migration, RLS by engagement membership, audit, and the roadmap guardrail triggers
status: completed
priority: P0
id: TASK-021
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T12:38:10.889Z'
roadmap_item:
  id: ROADMAP-003
  name: M2 — Engagements and roadmaps
  url: /ROADMAP.md#ROADMAP-003
related_decisions:
  - id: DEC-003
    name: Universal five-phase lifecycle with per-engagement editable roadmaps
    url: /DECISIONS.md#DEC-003
  - id: DEC-010
    name: One middleware chain for every request and background job
    url: /DECISIONS.md#DEC-010
modified:
  by: agent/claude-code
  at: '2026-10-05T12:43:05.740Z'
---
# TASK-021 — M2 schema: engagement, milestone, engagement_requirement, RLS and invariants

# M2 schema: engagement, milestone, engagement_requirement, RLS and invariants
PRD §6.4 and §6.9 (12, 13). engagement, milestone, engagement_requirement with RLS (institution tenant plus engagement membership), audit trigger, locked-milestone delete guard, required-skip needs reason, exactly one engagement_lead mirrored by engagement.lead_user_id. Engagement scope added to role resolution.
