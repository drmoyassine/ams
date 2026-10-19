---
id: TASK-086
title: 'IQF in operation: Link evidence, Assign scope, Assign champion, Create cycle'
description: >-
  The IQF tree in Quality Management gets the menu Link evidence, Assign scope, Assign champion, Create cycle; scope
  levels in Settings; scope and champions cascade top-down and to mapped external requirements, with overrides
status: completed
priority: P1
last_updated: '2026-10-19'
generated:
  by: agent/claude-code
  at: '2026-10-15T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-013
  name: 'Quality Management: cycles and reporting'
  url: /ROADMAP.md#ROADMAP-013
depends_on:
  - id: TASK-078
    name: 'Cycles: schema, permissions and core services'
    url: /TASKS.md#TASK-078
related_decisions:
  - id: DEC-029
    name: 'Quality Management: a cycle is ordered stages, each with inputs, process, outputs, owner and dates; reports are stage outputs or inputs'
    url: /DECISIONS.md#DEC-029
modified:
  by: agent/claude-code
  at: '2026-10-19T12:00:00.000Z'
---
# TASK-086 — IQF in operation: Link evidence, Assign scope, Assign champion, Create cycle

Plan: docs/quality-management-plan.md (Standards in operation). `scope_level` (Settings -> Organization -> Institution; Institution, Unit, Program, Course placeholder), `requirement_scope`, `requirement_champion`; effective scope and champion resolved top-down, then through mappings for external requirements (union of scopes; champion only when the mapped nodes agree); overrides at any level; carried to the next version with mappings and evidence links. The IQF tree view in Quality Management with the new ⋯ menu; "Request evidence" leaves the menu (requested through cycles); Settings -> IQF stays authoring only. External standards get the same menu on their tree in Accreditations: values are inherited through mappings and labelled with their IQF source; any action on an inherited value creates an override, "Back to inherited" removes it.

Built (2026-10-19):
- Data (migration 0061_scope_champion): `scope_level` (key, English and Arabic label, kind institution | org_unit | program | course | custom, order, active; seeded Institution, Unit, Program, Course for every institution, and by trigger for new ones), `requirement_scope` (framework + code, level, item_ids; empty = all) and `requirement_champion` (framework + code, optional unit or program, person). Named by framework and code like mappings and evidence links, so they sit outside the frozen version tables, can change on a published version and carry to the next version with no copying. Tenant RLS, stamp and audit triggers, worker SELECT only; triggers check everything named belongs to the institution (framework, people, units, programs; a level without a list takes no items); one scope per requirement, one champion per requirement and item. Levels are deactivated, never deleted.
- Core (`packages/core/src/scope/`): `resolve.ts` is pure: own, else (external only, APPROVED mappings only) the union of the mapped IQF nodes' scopes and the champion they all agree on ("needs one" when they differ or only some have one), else the nearest ancestor's; per scoped item for champions; every value carries its source (own, parent code, IQF code); `inherited` is what "Back to inherited" would give. A mapped node beats the parent. `assignments.ts` loads it for a whole version in a fixed number of queries and sets or clears scope and champion (framework:write, Undo where one request can restore it); `levels.ts` is the levels service.
- API (`routes/scope.ts`, 10 routes each `requires(...)`): scope levels (get, add, rename or deactivate, reorder), scope items, requirement-assignment, requirement-scope and requirement-champion (put, delete = back to inherited). The version's `requirement-context` now carries `scope` and `champion` per code (own, effective, inherited), so one request serves both hover cards.
- Web: Settings -> Organization -> Institution has a Scope levels section (Course shows "No courses yet"). Quality Management is a page with a Standards tab (the IQF tree, operational view without authoring; a marked slot for the Cycles tab of TASK-080). The ⋯ menu of an IQF standard and of an external requirement is Link evidence, Assign scope, Assign champion, Create cycle, then the authoring items; "Request evidence" left the IQF menu. Dialogs show what is inherited and from where and offer Back to inherited; hover cards show scope and champion with their source; Create cycle anchors on the requirement, takes a published template that fits (or none), a unit or program, a start date and the lead, and confirms with a link to /quality-management. Permissions: framework:write to assign, cycle:manage for cycles.
- Tests: pure resolution (12), core services (14), database (8), API (6), web UI (16), responsive states in e2e/responsive.mjs.

Not done: the cycle page and Cycles tab (TASK-080), Course records (Course is a placeholder level), champion per item is not inherited between mapped nodes beyond the same agree rule, no Undo for removing several champions at once, the Create cycle link goes to /quality-management until the cycle page exists.
