---
id: TASK-064
title: In-app assistant for bulk edits (plan)
description: >-
  Plan for an in-app AI assistant (bubble and side panel) that proposes bulk edits, previews them and applies them as
  one undoable action; nothing built yet
status: pending
priority: P2
last_updated: '2026-10-12'
generated:
  by: agent/claude-code
  at: '2026-10-12T15:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
related_decisions:
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
  - id: DEC-024
    name: Background work runs as three services from one codebase: worker, parser, agent
    url: /DECISIONS.md#DEC-024
modified:
  by: agent/claude-code
  at: '2026-10-12T15:00:00.000Z'
---
# TASK-064 — In-app assistant for bulk edits (plan)

Planning task. The plan is in docs/assistant-plan.md: a bubble opening a side panel, where a person describes a bulk change; the assistant reads the standards through read-only tools, proposes a change set (rule edits done by deterministic recipes, text edits written by the model within a cap), shows a before/after preview, and applies it only when the person clicks, as one undoable group through the existing services. Runs as a job in the agent service; framework content only; never publishes or approves.

Decisions needed before building: who can use it; which model; whether the preview is always required; whether conversations are kept; evidence is out of scope. Phases: plumbing and read-only answers, rule-based bulk edits with preview/apply/undo, per-item text edits, later reach.
