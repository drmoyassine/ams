---
id: TASK-084
title: Assistant and cycles
description: >-
  The assistant reads cycles (what is late, what waits on me) and can propose a cycle as a change the person confirms
status: pending
priority: P3
last_updated: '2026-10-15'
generated:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-083
    name: Start a cycle from the ⋯ menu, and Cycles panels
    url: /TASKS.md#TASK-083
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
---
# TASK-084 — Assistant and cycles

Plan: AI-aware. Read-only tools over cycles, stages, owners, dates, statuses and missing inputs; a `create_cycle` change operation through the existing confirmation flow (DEC-027); "Ask the assistant to draft it" in the Start-a-cycle dialog. Drafting report text and summaries stay deferred.
