---
id: TASK-073
title: Org chart from an uploaded image
description: >-
  Upload a picture or PDF of an org chart; the vision model proposes the tree; the person reviews and applies it as one
  undoable change (a Docs-pattern import)
status: completed
priority: P3
last_updated: '2026-10-14'
generated:
  by: agent/claude-code
  at: '2026-10-13T14:00:00.000Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
depends_on:
  - id: TASK-072
    name: Org chart: visual builder (tree and chart view)
    url: /TASKS.md#TASK-072
  - id: TASK-075
    name: Documents and AI import foundation: registry, Docs tab, Documents area
    url: /TASKS.md#TASK-075
related_decisions:
  - id: DEC-028
    name: Organization has two tabs; one secondary language; translations of standards are unofficial; per-person UI language; org-chart images may go to the vision model; every AI-import place gets a Docs tab
    url: /DECISIONS.md#DEC-028
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
modified:
  by: agent/claude-code
  at: '2026-10-14T15:00:00.000Z'
---
# TASK-073 — Org chart from an uploaded image

Section E.2 of docs/organization-plan.md. The image and the names on it go to the AI vision model (decided, DEC-028). Proposal beside the image, editable, applied as one undoable group; never overwrites units a person edited.

Built (section E.2 of docs/organization-plan.md, DEC-028, docs/ai-import.md):
- Target `org_chart` (`packages/core/src/org/org-chart-import.ts`, registered from `@ams/core`) for the `org_chart` scope (its link still points at `/settings/organization?tab=institution`; write permission `org:write`). It uses the reading (vision) model (`aiRole: 'reading'`): a picture or PDF page is read into text by the existing parse hook (`aiOcr`), which for a document of the org chart scope now uses the new prompt `ocr` v2 (`ocr.v2.ts`: the chart written as an indented outline, one line per box, the words of each box exactly as written, " [parent unclear]" where the lines do not say); `aiExtract` then proposes one unit per box with the versioned prompt `import_org_chart` v1: English and Arabic names, type key, parent (the name of the box it hangs from), head name when shown, and the box's own line as the quote. Temperature 0, no model identifier in code.
- Verification: there is no quote-match against pixels. The quote is checked against the model's own outline of the image (which says little), so every item says to check the picture; low confidence (below 0.6, the prompt asks for it when a box was hard to read) is flagged by the engine, and `validate` adds: no box text cited, no parent found (it would be added at the top level), parent unclear, part illegible.
- Apply (as the person, one transaction): units are matched by name in either language with Arabic folded and NFC, never duplicated. New units go through `createOrgUnit` with `source = 'image'`, parents first (a parent can be an existing unit or another accepted unit; an unknown parent, or parents that refer to each other, skip with the reason); the type is the institution's type with that key, else `other`. An existing unit that is locked or `edited_by_person` is left alone (skipped with the reason); an existing, unlocked, unedited unit under another parent than the picture shows is moved with `moveOrgUnits`. Units that cannot be added (permission, depth, inactive parent) are skipped with the reason. Undo moves the moved units back (placements) and puts the added units in the Trash (`deleteOrgUnits`, one group), refusing when a unit it made was renamed or moved, or someone added a unit under one; Redo restores the group and moves again.
- UI: the Org chart section has Chart and Docs tabs; Docs is the shared `DocsTab` (Import button, `canWrite` = `org:write`). The review shows the uploaded picture itself above the source text when the source is an image (`SourceImage` in `import-review.tsx`), with the flags per row, editable cells (`dir="auto"`) and Apply with the Undo/Redo result. Applying or undoing in Docs refreshes the chart when the person goes back to it.
- No migration, no new route, no change to the worker's database role (it still has no grant on `org_unit` or `import_apply`).
- Tests: `packages/core/src/org/org-chart-import.test.ts` (end to end with a fake model, apply rules, moves, Undo/Redo, OCR prompt choice), `apps/web/src/org-chart-docs-ui.test.tsx` (Docs tab, review, image beside, apply, Undo, Redo, read-only); `e2e/responsive.mjs` has the org chart Docs list, Import dialog and review with the image.

Not done: the vision model was never run against a real chart (tests use fake models); a unit's head is stored as a name, not matched to a person; two boxes with the same name under different parents resolve a child's parent by name (the later match), which the review's parent cell lets a person correct.
