---
title: >-
  One upload module and one document row: dropping files is the only way to add a document; the standards Docs tab is
  the shared tab
description: >-
  The owner saw several versions of the same upload and a confusing Documents tab (a second add dialog, an accordion
  with a page editor open by default, an Analysis panel above the documents that sent people to the wrong tab). One
  FileDrop and one useFilePicker with one rules table; the shared Docs row takes extension slots (role and authority
  chips, Edit details, Replace file, page text closed until opened) in place of renderRow; the Analysis panel moves
  below the list
status: in-progress
priority: P1
id: TASK-110
last_updated: '2026-10-27'
generated:
  by: agent/claude-code
  at: '2026-10-27T12:02:21.339Z'
roadmap_item:
  id: ROADMAP-012
  name: Settings, internal framework and glossary
  url: /ROADMAP.md#ROADMAP-012
modified:
  by: agent/claude-code
  at: '2026-10-27T12:02:21.339Z'
---
# TASK-110 — One upload module and one document row: dropping files is the only way to add a document; the standards Docs tab is the shared tab

Owner feedback 2026-10-27 (screenshots of the IQF Documents tab): "why do not we unify and reuse the Document upload module (DRY)?", "I have seen multiple versions of this", "this docs tab is confusing and needs to be DRY throughout".

Round 1 (done):
- `components/files`: `FileDrop` (drop or choose; hands the files over), `UploadArea` (FileDrop + a per-file queue with Retry), `useFilePicker` (a chooser opened from a button or menu). Accepted types and hints in one table, `lib/file-rules.ts` (`document`, `image`, `data`, `any`). Create-from-files uses `FileDrop`; the docs row's Replace file uses `useFilePicker`.
- One way to add a document: drop the file. Dropping already makes a full document (role unset, the analysis decides it), so the "+ Source" / "+ Document" dialog is gone; what is left of it is **Edit details** (title, what it is, authority, language) in the row's ⋯ menu.
- One row: `DocsTab` loses `renderRow` and takes `rowExtras` (chips, ⋯ menu, a details section with its own toggle, `domId`) and `footer`. The standards row is the shared row with the role and authority chips, Edit details, Replace file and **Page text** (closed until opened; it was an accordion with the page editor open by default). The Analysis panel moved below the list ("add and read the documents first, then analyse"), says "the documents above", and its button is **Analyse documents**.
- Wording: the readiness messages said "under Docs" on a tab called Documents and "under Sources" (a section that no longer exists); now "on the Documents tab" (the institution's own framework) and "on the Docs tab" (external standards). A not-yet-read row offers **Read**, not "Read again".

Round 2 (to do): the remaining single-file inputs move to the shared module: evidence new version, link-evidence dialog, evidence requests, cycle outputs, attestation letter, dataset Excel/CSV import, report CSV import, the two logo pickers and the standards JSON import. `FileDrop` stays for places that want a drop zone; the rest use `useFilePicker` with the same rules table.
