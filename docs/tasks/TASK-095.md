---
id: TASK-095
title: 'Report export: DOCX, PDF, XLSX evidence index, ZIP package'
description: >-
  Export the report as DOCX and PDF in template order with generated blocks and RTL for Arabic, the evidence index as
  XLSX and a self-contained ZIP.
status: pending
priority: P1
last_updated: '2026-10-21'
generated:
  by: agent/claude-code
  at: '2026-10-21T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-005
  name: M4 — Reports and submissions
  url: /ROADMAP.md#ROADMAP-005
depends_on:
  - id: TASK-093
    name: 'Report generated blocks: compliance matrix, evidence index, feedback response'
    url: /TASKS.md#TASK-093
  - id: TASK-094
    name: Report workflow, internal approval and submission snapshot
    url: /TASKS.md#TASK-094
modified:
  by: agent/claude-code
  at: '2026-10-21T09:00:00.000Z'
---
# TASK-095 — Report export: DOCX, PDF, XLSX evidence index, ZIP package

PRD §10.5. One internal function `renderReport()` as the only import point of the rendering libraries (like parseDocument(), DEC-011). Real-document pass: the WSCUC report and a PUC report in Arabic.
