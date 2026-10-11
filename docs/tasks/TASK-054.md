---
id: TASK-054
title: Analysis report, run readiness checks, and the import page's approve-everything option removed (step F1)
description: >-
  Each analysis run ends with an intelligence report (what was read and used, structure found, requirements, gaps and
  conflicts, suggested IQF links, a before-you-publish checklist) built on demand, served by the API and shown on a
  Report tab that can be opened again later; the Analyse button checks readiness first; imports of external standards
  no longer have an approve-everything path
status: completed
priority: P1
last_updated: '2026-10-11'
generated:
  by: agent/claude-code
  at: '2026-10-11T18:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: Create external standards from files (AI-assisted)
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-050
    name: IQF mapping after analysis (step E)
    url: /TASKS.md#TASK-050
related_decisions:
  - id: DEC-022
    name: External standards drafted by analysis are gated by publishing, not by per-line approval
    url: /DECISIONS.md#DEC-022
modified:
  by: agent/claude-code
  at: '2026-10-11T18:00:00.000Z'
---
# TASK-054 — Analysis report, run readiness checks, and the import page's approve-everything option removed (step F1)

Built (step F1 of ROADMAP-009 row F; "Create from files" and the split-view source viewer are built by another agent):
- **Report builder** (`packages/core/src/framework/analysis/report.ts`, `getAnalysisReport`, `getLatestAnalysisReport`; DTO `AnalysisReport` v1 in `packages/shared/src/analysis-report.ts`). Computed on demand from the run's stored record and the draft as it is now, so it follows later edits; the run-time numbers (usage, duration, the stats the run wrote) are the frozen part (`requirements.atRun`). Sections: summary (who, when, duration; per source: role and who decided it, language, pages by file text / AI vision / not readable, warnings; analysis, vision and embedding models, tokens, cost, calls, recovery rounds), structure found (level names proposed and written, numbering, key terms, scope), requirements (counts by level, "n of m quotes found in the source" and the percentage, quote not found, low confidence, notes suggested and not confirmed, orphans, kept edits, deleted-and-not-re-added), gaps and conflicts (recovered, confirmed absent with reason, unresolved, conflicts with both wordings, pages not covered), IQF mapping (suggested links by relation, no suggestion, suggested new items, accepted / dismissed / waiting, words only or words and meaning), and a "Before you publish" checklist that reuses `validateVersion`. Every item carries ids and pages; no score, verdict or similarity number; a test scans the DTO and its Markdown for forbidden words. `reportToMarkdown` lives in shared (the screen's "Download as Markdown" and the test use it).
- **Stages extended minimally:** the conflict gap now keeps both wordings (`variants`, optional); every `save` records the models in use under `report.runtime` (names only).
- **API:** `GET /api/analysis/{id}/report`, `GET /api/framework-versions/{id}/analysis/latest-report` (framework:read), `GET /api/framework-versions/{id}/analysis/preflight` (framework:write). `listFrameworks` versions carry `analysis` (latest run id, status, error).
- **Report tab** on the version page (`?tab=report&run=<id>`, the address follows the tab and the selected run): runs list, cards, live progress while a run is active, links to the requirement card, the source page and the Mappings tab, Print / save as PDF (print CSS) and Download as Markdown. The standard card shows one line: Analysis running… / Analysis finished · view report / Analysis failed (reason on hover). The Report screen is in `e2e/responsive.mjs`.
- **Run readiness** (`analysisPreflight`, `aiPreflightChecks`): draft, sources, AI on, model and a key that can be read (never shown), spend cap, reading of scanned pages where needed, embeddings or words only. "Analyse sources" shows the checks and disables with the first blocking reason; the start route keeps its hard checks. No parser heartbeat exists to check, so that check is not there.
- **Import:** the "Approve everything on import" checkbox, the `autoApprove` option and API field are gone; an imported external standard is pending line by line like an AI draft (publishing is the review). The internal framework's own setup is untouched. Tests that passed `autoApprove` were updated.
- Tests: `report.test.ts` (full fake run with IQF mapping, links valid, forbidden words, edit follows, conflicts side by side, failed run, authorization, each preflight blocker), API (`analysis.test.ts`), UI (`report-ui.test.tsx`: tab, runs list, deep link, Markdown, print, live progress, cards, card line, readiness).

Not done: report with embeddings was not run end to end (the hybrid label comes from the stored mapping); no Playwright check of the printed PDF (print CSS only); the parser-service heartbeat check.
