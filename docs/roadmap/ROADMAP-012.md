---
title: Settings, internal framework and glossary
description: >-
  A Settings area (organization, branding, org chart, programs), the institution's own quality framework and glossary,
  and per-standard mappings to them
quarter: Q4
status: Completed
priority: P0
id: ROADMAP-012
last_updated: '2026-10-28'
generated:
  by: agent/claude-code
  at: '2026-10-06T05:43:17.250Z'
vision_theme:
  id: one-platform-many-frameworks
  name: Accreditor frameworks are configuration, not code
  url: /VISION.md#one-platform-many-frameworks
modified:
  by: agent/claude-code
  at: '2026-10-28T11:44:14.902Z'
related_decisions:
  - id: DEC-016
    name: Internal quality framework and glossary unify terminology; mappings live on each external standard
    url: /DECISIONS.md#DEC-016
related_tasks:
  - id: TASK-032
    name: Settings shell, organization identity and branding
    url: /TASKS.md#TASK-032
  - id: TASK-033
    name: Org chart editor
    url: /TASKS.md#TASK-033
  - id: TASK-034
    name: Programs in Settings
    url: /TASKS.md#TASK-034
  - id: TASK-035
    name: Requirement tree shows each code once
    url: /TASKS.md#TASK-035
  - id: TASK-036
    name: Glossary and term mapping
    url: /TASKS.md#TASK-036
  - id: TASK-037
    name: Internal quality framework
    url: /TASKS.md#TASK-037
  - id: TASK-038
    name: Mappings tab on each external standard
    url: /TASKS.md#TASK-038
  - id: TASK-062
    name: Trash, Undo and the in-app confirmation dialog
    url: /TASKS.md#TASK-062
  - id: TASK-063
    name: Multi-select, bulk delete and drag and drop in the requirement trees
    url: /TASKS.md#TASK-063
  - id: TASK-064
    name: In-app assistant for bulk edits (plan)
    url: /TASKS.md#TASK-064
  - id: TASK-065
    name: Redo in the undo system
    url: /TASKS.md#TASK-065
  - id: TASK-066
    name: In-app assistant, phase 1 (plumbing, conversations, memory, read-only answers)
    url: /TASKS.md#TASK-066
  - id: TASK-067
    name: 'Assistant phase 2: bulk edits confirmed in the chat'
    url: /TASKS.md#TASK-067
  - id: TASK-068
    name: 'Assistant follow-ups: memory merging, meaning-based memory search, report chip'
    url: /TASKS.md#TASK-068
  - id: TASK-069
    name: 'Organization screen: Institution and Programs tabs, institution logo, read-only Settings'
    url: /TASKS.md#TASK-069
  - id: TASK-070
    name: 'Languages: secondary language, UI language and content switchers'
    url: /TASKS.md#TASK-070
  - id: TASK-071
    name: Translate the IQF and the standards into the secondary language
    url: /TASKS.md#TASK-071
  - id: TASK-072
    name: 'Org chart: visual builder (tree and chart view)'
    url: /TASKS.md#TASK-072
  - id: TASK-073
    name: Org chart from an uploaded image
    url: /TASKS.md#TASK-073
  - id: TASK-074
    name: 'Org chart: directory sync (LDAP first, QuickLaunch and Active Directory to be confirmed)'
    url: /TASKS.md#TASK-074
  - id: TASK-075
    name: 'Documents and AI import foundation: registry, Docs tab, Documents area'
    url: /TASKS.md#TASK-075
  - id: TASK-076
    name: 'Programs from documents: upload, AI parse, drafts'
    url: /TASKS.md#TASK-076
  - id: TASK-102
    name: Sources by URL for every document import
    url: /TASKS.md#TASK-102
  - id: TASK-103
    name: Cycle template resources and AI-proposed stages
    url: /TASKS.md#TASK-103
  - id: TASK-104
    name: Program schema
    url: /TASKS.md#TASK-104
  - id: TASK-105
    name: 'Courses: entity, schema, tab and import'
    url: /TASKS.md#TASK-105
  - id: TASK-106
    name: Entity schema registry and data dictionary
    url: /TASKS.md#TASK-106
  - id: TASK-110
    name: >-
      One upload module and one document row: dropping files is the only way to add a document; the standards Docs tab
      is the shared tab
    url: /TASKS.md#TASK-110
  - id: TASK-111
    name: 'Draft the institution''s quality framework from documents: headings per window, one organise call, review, apply'
    url: /TASKS.md#TASK-111
---
# ROADMAP-012 — Settings, internal framework and glossary

# Settings, internal framework and glossary

Between M2 and M3. Settings (admin and leads): organization and branding, org chart, programs, the internal quality framework (built on the framework library), and the glossary that maps internal terms to each external standard's terms. Mappings from external requirements to internal nodes are edited on each external standard's own page, not in global settings. Evidence collected once on an internal node reaches mapped external requirements as suggested links (M3).

Progress (2026-10-13): since this item was completed, the library screens gained a 30-day Trash with restore, Undo and Redo, in-app confirmations, multi-select with bulk delete, drag-and-drop re-parenting and reordering (TASK-062, TASK-063, TASK-065, DEC-026), Settings → AI with saved accounts and per-role models (TASK-051), and the in-app assistant's first phase with scoped memory (TASK-066, DEC-027). The assistant's bulk edits with in-chat confirmation are built (TASK-067); open here: follow-ups (TASK-068). The full picture is in docs/status.md.
