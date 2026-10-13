---
id: TASK-071
title: Translate the IQF and the standards into the secondary language
description: >-
  A background translation job and a side-by-side review screen store translations beside the English, flag them out of
  date when the English changes, and label external-standard translations as not the official wording
status: pending
priority: P2
last_updated: '2026-10-13'
generated:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-070
    name: Languages: secondary language, UI language and content switchers
    url: /TASKS.md#TASK-070
related_decisions:
  - id: DEC-028
    name: Organization has two tabs; one secondary language; translations of standards are unofficial; per-person UI language; org-chart images may go to the vision model; every AI-import place gets a Docs tab
    url: /DECISIONS.md#DEC-028
  - id: DEC-021
    name: Framework analysis may send the institution's IQF text to the AI
    url: /DECISIONS.md#DEC-021
modified:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
---
# TASK-071 — Translate the IQF and the standards into the secondary language

Section D of docs/organization-plan.md. content_translation table (entity, language, field, text, origin, reviewed, source hash); translate job in the agent service (framework text only, DEC-021; glossary-aware; spend cap; progress); review screen (accept, edit, retranslate; filters needs review and out of date); the existing translation_en becomes the English row; the assistant can offer to translate a selection.
