---
title: Due-rule engine
description: Pure functions that resolve fixed, anchor, after and null due rules, with date_needed and recurrence
status: completed
priority: P0
id: TASK-022
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T12:38:12.805Z'
roadmap_item:
  id: ROADMAP-003
  name: M2 — Engagements and roadmaps
  url: /ROADMAP.md#ROADMAP-003
related_decisions:
  - id: DEC-002
    name: Accreditor frameworks are versioned configuration; no accreditor-specific code
    url: /DECISIONS.md#DEC-002
  - id: DEC-003
    name: Universal five-phase lifecycle with per-engagement editable roadmaps
    url: /DECISIONS.md#DEC-003
modified:
  by: agent/claude-code
  at: '2026-10-05T12:46:25.655Z'
---
# TASK-022 — Due-rule engine

# Due-rule engine
PRD §7.4. packages/core, no database. fixed MM-DD with year_offset from review_year; anchor to key_dates; after another milestone's completion; null manual; unresolved gives due_date null and date_needed true and resolves when the anchor is entered. Tested against the Appendix A WSCUC and ABET dates, including leap days.
