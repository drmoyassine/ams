---
title: Roadmap editing, guardrails and phase advance
description: Edit milestones within PRD §8.5 and advance phases manually
status: pending
priority: P0
id: TASK-025
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T12:38:18.920Z'
roadmap_item:
  id: ROADMAP-003
  name: M2 — Engagements and roadmaps
  url: /ROADMAP.md#ROADMAP-003
depends_on:
  - id: TASK-024
    name: 'Engagement service: create, members, lead handover'
    url: /TASKS.md#TASK-024
related_decisions:
  - id: DEC-003
    name: Universal five-phase lifecycle with per-engagement editable roadmaps
    url: /DECISIONS.md#DEC-003
modified:
  by: agent/claude-code
  at: '2026-10-05T12:38:18.920Z'
---
# TASK-025 — Roadmap editing, guardrails and phase advance

# Roadmap editing, guardrails and phase advance
Rename, describe, assign owner, change due date (origin modified); add local milestones; reorder within a phase; skip optional; un-skip. Prevented: deleting locked milestones, skipping required without reason, adding or removing phase types, changing the self-study report template. Key-date changes re-resolve due dates. Advance phase is enabled only when required milestones are done or skipped. Progress is completed required over required.
