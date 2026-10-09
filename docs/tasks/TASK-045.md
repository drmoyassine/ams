---
id: TASK-045
title: Framework analysis runs (step C) — requirements from a draft's sources
description: >-
  A background analysis, one small job per step, that reads a draft version's sources and writes the accreditor's
  requirements and notes into the draft in their exact wording, with page, quote and deterministic quote verification
status: completed
priority: P0
last_updated: '2026-10-09'
generated:
  by: agent/claude-code
  at: '2026-10-09T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
related_decisions:
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
  - id: DEC-012
    name: Vercel AI SDK with the Anthropic provider behind aiExtract/aiOcr
    url: /DECISIONS.md#DEC-012
  - id: DEC-013
    name: AI processing approved for framework source documents; evidence not sent in the MVP
    url: /DECISIONS.md#DEC-013
  - id: DEC-022
    name: External standards drafted by analysis are gated by publishing, not by per-line approval
    url: /DECISIONS.md#DEC-022
modified:
  by: agent/claude-code
  at: '2026-10-09T12:00:00.000Z'
---
# TASK-045 — Framework analysis runs (step C) — requirements from a draft's sources

Built: `analysis_run` (migrations 0038-0039; tenant RLS, audit, at most one queued/running run per version) with status, stage, `progress` (stage, cursor, docs and windows done, items so far), model and prompt versions, `usage` (tokens, cost, calls, across all the run's jobs) and `report` (survey, structure, plan, stats). One job type `analyse` with `{runId, stage, cursor}`; each job is one step in its own transaction and queues the next (`runJob` now gives handlers a real `afterCommit` and the worker's queue). A job whose stage and cursor no longer match the run does nothing, so a retried job resumes where the last commit left off; after the 4th attempt, or on a terminal error, the run is marked failed.

Stages (`packages/core/src/framework/analysis/stages.ts`): read (step A inline for a source with a file and no page text), survey per source (`survey.v1`: role, language, outline; the role is applied only when no person chose it, `source_document.role_origin`), structure (`structure.v1`: level names applied to the draft unless a person renamed them since, numbering, key terms, scope kept in the report), extract per window of 8 pages with 1 overlap (`extract.v1`, PRD Appendix B rules; raw items logged in `extraction_item.analysis_run_id`), write, finalise. Budget: the run's usage seeds each job's `AiBudget`, so the Settings → AI per-run limit covers the whole run; `BudgetExceeded` writes what earlier windows proposed and fails the run with the reason.

Verify and write (`quote-match.ts`, `analysis/merge.ts`, `analysis/write.ts`): NFC, whitespace, quotes and dashes, Arabic folding (alef forms, tatweel, diacritics, ة/ه, ى/ي, hamza seats, Arabic-Indic digits); a quote counts at similarity ≥ 0.9 (edit distance on the cited page, then its neighbours and across a page break); the requirement's text must also be in the pages. Duplicates from overlapping windows merged by code (longest text kept), parents resolved by code (or the window's temp id), orphans flagged and kept at the top level. Requirements are taken only from standards documents; notes from standards and guidance. A "required" note without a verified quote becomes `ai_suggested` with a flag. Rows: origin `ai`, source document/page/quote, `quoteVerified`, `reviewStatus` left `pending`.

Human edits win: `edited_by_person` on requirement and requirement_note, set by a trigger on any update not made by the worker. A re-run updates only AI rows that are unedited and unreviewed, adds new ones, and never deletes. The worker may now insert/update requirements and notes on draft versions only, as unreviewed AI rows, never touching a person's row (trigger `c_worker_guard`); it still has no DELETE and no review columns.

API: `POST/GET /api/framework-versions/{id}/analysis`, `GET /api/analysis/{id}`, `POST /api/analysis/{id}/cancel`. UI: Settings → Sources has an Analysis panel (Analyse sources, Stop, a polling progress strip, the last runs with counts and spend) and a "the analysis decides" role choice; requirement cards show an AI marker, the source quote and page, and "Quote not found in source".

Not done here: the full report and the review screen (step F); the publish gate still requires every requirement approved, so DEC-022's "publishing is the gate" needs the gate and UI change of step F; a requirement a person deleted is proposed again by a re-run (no tombstones); policy/report-template targets (milestones, vocabularies, templates) are not extracted yet.
