---
id: TASK-040
title: Datasets with manual upload, templates and data requests
description: Dataset evidence with a dataset spec, generated XLSX/CSV templates, validated uploads as versions, data request tasks
status: completed
priority: P0
last_updated: '2026-10-07'
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
  at: '2026-10-07T10:16:14.599Z'
---
# TASK-040 — Datasets with manual upload, templates and data requests

PRD 9.4 and 9.6: dataset_spec (definition, columns, grain, periods, data owner, source manual_upload), template generated from the columns, upload validated against column types into a new version with supplied_by and as_of, data request to the data owner. Bound report tables come with M4.

Built: `dataset_spec` (migrations 0026-0027: one per data item, only on data items, visible with its item) holding what the data means, what one row is, and the columns (text, number, whole number, percent, date, choice, yes/no; unit; required; choices). Rows are saved as numbered versions in `evidence_version.data`, each with its own copy of the columns and a lineage (`source_kind`, `supplied_by`). Cell rules live in `@ams/shared` (`parseCell`, `validateRows`) so the grid and the server agree; any invalid cell refuses the save and is named (`rows.<n>.<key>`). The online sheet is our own (inputs in a table: right-to-left, Excel paste of blocks, red cells that say why); ExcelJS and Papa Parse are imported only in `apps/web/src/lib/sheet-io.ts` and loaded on demand for the template (with data validation), Excel/CSV export and import (headers matched by name). Requests for data use the evidence requests of TASK-041; the form builder comes next.
