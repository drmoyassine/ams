---
id: TASK-040
title: Datasets with manual upload, templates and data requests
description: Dataset evidence with a dataset spec, generated XLSX/CSV templates, validated uploads as versions, data request tasks
status: pending
priority: P0
last_updated: '2026-10-06'
generated:
  by: agent/claude-code
  at: '2026-10-06T12:47:47.135Z'
roadmap_item:
  id: ROADMAP-004
  name: M3 — Evidence and datasets
  url: /ROADMAP.md#ROADMAP-004
depends_on:
  - id: TASK-039
    name: Evidence repository, versions and reasoned links
    url: /TASKS.md#TASK-039
related_decisions:
  - id: DEC-014
    name: Dataset evidence with a source adapter; governed-metric integration optional
    url: /DECISIONS.md#DEC-014
modified:
  by: agent/claude-code
  at: '2026-10-06T12:47:47.135Z'
---
# TASK-040 — Datasets with manual upload, templates and data requests

PRD 9.4 and 9.6: dataset_spec (definition, columns, grain, periods, data owner, source manual_upload), template generated from the columns, upload validated against column types into a new version with supplied_by and as_of, data request to the data owner. Bound report tables come with M4.
