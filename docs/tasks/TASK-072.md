---
id: TASK-072
title: Org chart: visual builder (tree and chart view)
description: >-
  Org units are edited in a drag-and-drop tree and drawn as a chart (zoom, pan, collapse, right-to-left aware, export as
  image), with a head and programs on each unit
status: completed
priority: P2
last_updated: '2026-10-14'
generated:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-069
    name: Organization screen: Institution and Programs tabs, institution logo, read-only Settings
    url: /TASKS.md#TASK-069
related_decisions:
  - id: DEC-028
    name: Organization has two tabs; one secondary language; translations of standards are unofficial; per-person UI language; org-chart images may go to the vision model; every AI-import place gets a Docs tab
    url: /DECISIONS.md#DEC-028
modified:
  by: agent/claude-code
  at: '2026-10-14T12:00:00.000Z'
---
# TASK-072 — Org chart: visual builder (tree and chart view)

Section E.1 of docs/organization-plan.md. Reuses the tree drag-and-drop, selection, Trash and Undo/Redo; configurable levels and types; names in both languages; each unit records its source (manual, image, directory). Lives in the Institution tab's Org chart section, with its Docs.

Built (section E.1 of docs/organization-plan.md; the image import and the directory sync are TASK-073 and TASK-074 and are not built):
- Data (migration 0054_org_chart): `org_unit_type` (per institution: key, English and Arabic label, order; seeded with college, school, department, admin_unit, other, by a trigger for new institutions too); `org_unit.type` is the key of one of them (composite foreign key: a type in use cannot be removed); `org_unit` gained `source` (manual | image | directory), `locked`, `display_order` (gap-free per parent), `head_user_id` / `head_name` (a person or free text, never both; the person must be of the same institution), `description` and `edited_by_person` (set by the existing trigger on any non-worker update, for the later import and sync).
- Core (`packages/core/src/org/`): create (at an index), edit (names, type, description, head, lock, active), `moveOrgUnits` (the shared `planMoves` / `planPlacements`: atomic, no cycles, gap-free orders, one undo of placements), delete of a unit with its subtree to the Trash (kind `org_unit`; refused, listing them, while programs are attached; evidence ownership is taken off and given back), restore (missing parent: choose; removed type is added back; old place kept), unit types (add, rename, reorder, remove only when unused). Every mutation reports undo and redo. API: `GET /api/org-chart`, `POST /api/org-units/move-many`, `delete-preview`, `delete`, `DELETE /api/org-units/{id}`, `/api/org-unit-types`.
- Web (Institution -> Org chart): a Tree | Chart toggle. Tree is the shared tree layer through a new `TreeAdapter` (drag and drop with drop lines, keyboard drag, multi-select, bulk delete with in-app question and Undo toast, collapse, roving tabindex); rows show names (Arabic beneath, dir=auto), type, head, programs, lock, source. Chart: `layoutOrgChart` (`packages/shared/src/org-layout.ts`, pure and tested: tidy tree, leaf sub-units hung in a column, mirrored for right-to-left), zoom and pan by wheel, pinch, drag, buttons and keys, collapse from the box, click opens the drawer; export as PNG (2x, scaled down for very large charts) and SVG, print to one page. A unit drawer (names in both languages, type, head, description, lock, active, programs with links) and a "Unit types" manager. Read-only for people without org:write.
- Performance in Chromium with 300 units (e2e/responsive.mjs): tree opens in about 0.5 s; select all 83 ms; chart opens in 97 ms with 182 boxes (collapsed beyond level 3); Expand all (300 boxes) 74 ms; wheel zoom and drag pan at a steady 16.7 ms frame gap; SVG export 117 ms (432 KB), PNG export 332 ms; print makes one PDF page; the mirrored chart and its export carry the Arabic.
- Tests: shared layout, core services (moves, deletes and restores, head, lock, types rules, edited marker, permissions, tenant isolation), API undo and redo of every mutation, database rules, UI (tree, keyboard drag, bulk delete, drawer, types manager, chart zoom, collapse, export, RTL, read-only), responsive states at 375, 768 and 1280.

Not done: image import and directory sync (hooks exist: `source`, `locked`, `edited_by_person`); the Docs tab of the org chart (built in TASK-073); a real touch device was not used for pinch.
