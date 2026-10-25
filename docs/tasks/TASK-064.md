---
id: TASK-064
title: In-app assistant for bulk edits (plan)
description: >-
  Plan for an in-app AI assistant (bubble and side panel) that proposes bulk edits, confirms them in the chat and applies them as
  one undoable action; nothing built yet
status: completed
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
  - id: DEC-027
    name: The in-app assistant is a companion that inherits the user's privileges, edits only drafts, and keeps scoped memory
    url: /DECISIONS.md#DEC-027
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
  - id: DEC-024
    name: 'Background work runs as three services from one codebase: worker, parser, agent'
    url: /DECISIONS.md#DEC-024
modified:
  by: agent/claude-code
  at: '2026-10-12T15:00:00.000Z'
---
# TASK-064 — In-app assistant for bulk edits (plan)

Planning task. The plan is in docs/assistant-plan.md: a bubble opening a side panel, where a person describes a bulk change; the assistant reads the standards through read-only tools, proposes a change set (rule edits done by deterministic recipes, text edits written by the model within a cap), describes it in the chat, and applies it only when the person presses Do it, as one undoable group through the existing services. Runs as a job in the agent service; framework content only; never publishes or approves.

Decided 2026-10-12 (DEC-027): a companion that inherits the user's privileges; the analysis model by default; edits only drafts (it may create one), no preview table but a confirmation in the chat before any change (a one-time token issued by the button), Undo and Redo; conversations kept; scoped memory (conversation, personal, workspace) read through the same authorization as the screens; evidence out of scope. Phases: plumbing, memory and read-only answers, rule-based bulk edits with in-chat confirmation and undo/redo, per-item text edits, later reach.
