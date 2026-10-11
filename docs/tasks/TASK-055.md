---
id: TASK-055
title: Create from files and the split-view review of an external standard's requirements
description: >-
  External Standards gets a primary "Create from files" flow (accreditor, standard, edition, many files, progress and
  retry, then the analysis); the Requirements tab gets a source viewer with the quote highlighted by the server's matcher,
  "Needs a look" filters, and merge, split and move
status: completed
priority: P1
last_updated: '2026-10-11'
generated:
  by: agent/claude-code
  at: '2026-10-11T18:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-053
    name: The owned @drmoyassine/liteparse is the parser; a temporary fallback reads the formats it lacks
    url: /TASKS.md#TASK-053
related_decisions:
  - id: DEC-022
    name: External standards drafted by analysis are gated by publishing, not by per-line approval
    url: /DECISIONS.md#DEC-022
modified:
  by: agent/claude-code
  at: '2026-10-11T18:00:00.000Z'
---
# TASK-055 — Create from files and the split-view review of an external standard's requirements

Step F2 of ROADMAP-009 (PRD 15.1 steps 1 and 6).

Built:
- `createStandardFromFiles` (`packages/core/src/framework/from-files.ts`, `POST /api/framework-versions/from-files`, framework:write): in ONE transaction reuses an accreditor (`accreditorId`) or creates one (short name unique, case-insensitive), creates the standard (name unique per accreditor) and its draft version, and registers one source per file with the role left to the analysis (`role_origin` unset). Refuses empty or oversize file lists with messages naming the file. The browser then uploads each file to the existing source file route and starts the existing analysis. `GET /api/source-limits` gives the file limit.
- Web: "Create from files" is the primary button beside "New Standard" (`pages/create-from-files.tsx`): multi-file drop zone and picker, per-file name/type/size/remove, size message, per-file status (waiting, uploading, saved, not saved with Retry), a summary of what was created, the analysis start error shown as is (draft and files kept), and navigation to the version's Sources (Analysis panel) when everything is saved and the run started.
- Source viewer: `getSourcePageView` (`GET /api/source-documents/{id}/pages/{pageNo}/view?quote=`) returns the page text, the stored page numbers and the highlight range. `quote-match.ts` gains `foldWithMap`, `bestSubstringMatch` and `locateQuote`, the same search as `verifyQuote` (cited page, neighbours, across a page break) returning offsets in the page as stored; a test keeps the folding identical to `normalizeQuoteText`. The browser does no matching.
- Split view on the Requirements tab (`version/source-viewer.tsx`, `external-requirements.tsx`): viewer beside the list from 1280px (each scrolls on its own), a bottom sheet from the card's Source button below it; previous/next page, a choice among the sources an item and its notes cite, Open in Sources, link to the original, quote-not-found message, `dir="auto"`.
- "Needs a look" (`listReviewItems`, `GET /api/framework-versions/{id}/review-items`): chips with counts for quote not found, low confidence (from the analysis log), no parent found, suggested by the analysis, a filter that keeps ancestors, and "Next item that needs a look" (button and the `n` key) that opens, scrolls to and focuses the item.
- `mergeRequirement` and `splitRequirement` (`restructure.ts`, `POST /api/requirements/{id}/merge|split`): merge moves notes and items to the target (its wording kept unless asked), removes the merged one (the analysis remembers the deletion); split moves a chosen part into a new sibling with its own code, both keep the source and the new quote is verified against the page. Both refuse published versions, are human actions, and mark touched rows edited by a person through the existing trigger. Move to... reuses the existing move route.
- Tests (no network): quote locating (Arabic with marks, fuzzy, across pages), create-from-files service and API, view endpoint, review items, merge and split services and API, UI for the dialog (files, oversize, failed file and retry, refusal), split view (wide and sheet), filters, merge/split/move dialogs; `e2e/responsive.mjs` covers the new dialog and split view states. The e2e run found a real bug (the picker emptied its file list before it was read), fixed.

Not done: the audit trail records merge and split through the row-level triggers (the removed requirement whole, every moved row) rather than a labelled event, since the app role cannot write audit events and no migration was added; links to the institution's standards are by code and are not moved by a merge (the result says how many name the old code); drag-and-drop re-parenting; a PDF page image in the viewer (it shows stored text).
