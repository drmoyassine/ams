---
title: 'Quality Management: cycles and reporting'
description: >-
  Operate the Internal Quality Framework through cycles (stages with inputs, process, outputs, owner and dates) at any level,
  with reports as stage outputs and inputs; one engine shared with Accreditations
quarter: Q4
status: In Progress
priority: P1
id: ROADMAP-013
last_updated: '2026-10-20'
generated:
  by: agent/claude-code
  at: '2026-10-19T09:00:00.000Z'
vision_theme:
  id: one-platform-many-frameworks
  name: Accreditor frameworks are configuration, not code
  url: /VISION.md#one-platform-many-frameworks
modified:
  by: agent/claude-code
  at: '2026-10-19T09:00:00.000Z'
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
  - id: DEC-031
    name: 'An evidence item is a title, a type (document or dataset) and a definition, collected by one method on an optional schedule; collecting is not a staged cycle, reports are'
    url: /DECISIONS.md#DEC-031
related_tasks:
  - id: TASK-077
    name: 'Quality Management: cycles and reporting (design)'
    url: /TASKS.md#TASK-077
  - id: TASK-078
    name: 'Cycles: schema, permissions and core services'
    url: /TASKS.md#TASK-078
  - id: TASK-079
    name: 'Cycle templates: Settings section, editor and shipped defaults'
    url: /TASKS.md#TASK-079
  - id: TASK-080
    name: 'Quality Management screens: cycles list, new cycle, cycle page, My work'
    url: /TASKS.md#TASK-080
  - id: TASK-081
    name: Cycle recurrence, academic terms and plans with inheritance
    url: /TASKS.md#TASK-081
  - id: TASK-082
    name: Nested cycles and cycles in Accreditations
    url: /TASKS.md#TASK-082
  - id: TASK-083
    name: Start a cycle from the ⋯ menu, and Cycles panels
    url: /TASKS.md#TASK-083
  - id: TASK-084
    name: Assistant and cycles
    url: /TASKS.md#TASK-084
  - id: TASK-085
    name: Report outputs in cycles (shared report engine)
    url: /TASKS.md#TASK-085
  - id: TASK-086
    name: 'IQF in operation: Link evidence, Assign scope, Assign champion, Create cycle'
    url: /TASKS.md#TASK-086
  - id: TASK-087
    name: 'Simplify cycles: evidence collection, one owner'
    url: /TASKS.md#TASK-087
  - id: TASK-089
    name: 'Evidence schema: definition, dataset, collection method, schedule'
    url: /TASKS.md#TASK-089
  - id: TASK-090
    name: 'Evidence collection runs: scheduler, BI call, request, form, manual'
    url: /TASKS.md#TASK-090
  - id: TASK-097
    name: QA report templates on the IQF and shipped defaults
    url: /TASKS.md#TASK-097
  - id: TASK-098
    name: Report output on cycles
    url: /TASKS.md#TASK-098
  - id: TASK-099
    name: Offer report cycles in the UI
    url: /TASKS.md#TASK-099
  - id: TASK-101
    name: Assistant reads cycles, collection runs and reports
    url: /TASKS.md#TASK-101
---
# ROADMAP-013 — Quality Management: cycles and reporting

# Quality Management: cycles and reporting

The operating side of the Internal Quality Framework, next to Accreditations (external). One engine: a cycle is ordered stages, each with inputs, process, outputs, a responsible unit, an owner and dates; reports are stage outputs or inputs. Cycles can be built at any level (institution, unit, program, a standard or sub-standard, a requirement, an evidence item, an accreditation), recur (term, year, N years, after the previous one), nest (maintenance runs a yearly annual report), and are inherited down the IQF and to mapped external standards with overrides. The IQF gets its operating menu: Link evidence, Assign scope, Assign champion, Create cycle; external standards get the same, inherited through their mappings. Design: docs/quality-management-plan.md, DEC-029. Shares the report engine with Accreditations (M4, ROADMAP-005).

Status (2026-10-20): simplified by the owner (DEC-030, TASK-087): cycles are about evidence items, have one owner, and are not linked to standards; accreditation cycles (TASK-082) and Quality Assurance / report cycles come later; TASK-083 is cancelled. The data model, services, API, template editor, screens, plans and the standards in operation (TASK-078 to TASK-081, TASK-086) are built.

Status (2026-10-20, later): evidence is not collected by cycles any more (DEC-031, TASK-089): an evidence item carries its own definition, type (document or dataset), one collection method (manual, online form, request, BI; survey reserved) and an optional schedule, and the cycle UI no longer offers evidence items (cycles are for reports and Quality Assurance, coming). TASK-090 makes the schedules run: the scheduler, the runs, the BI call and callback, the request, the form and the owner's task.
