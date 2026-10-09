---
id: TASK-046
title: Framework analysis check and recover (step D) — exhaustive but bounded
description: >-
  A deterministic gap finder and bounded recovery rounds between extraction and writing, so a framework analysis
  finds what the first pass missed, confirms what is really absent, flags conflicts, and never re-adds what a person deleted
status: completed
priority: P0
last_updated: '2026-10-09'
generated:
  by: agent/claude-code
  at: '2026-10-09T18:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-045
    name: Framework analysis runs (step C) — requirements from a draft's sources
    url: /TASKS.md#TASK-045
related_decisions:
  - id: DEC-002
    name: Accreditor frameworks are versioned configuration; no accreditor-specific code
    url: /DECISIONS.md#DEC-002
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
  - id: DEC-012
    name: Vercel AI SDK with the Anthropic provider behind aiExtract/aiOcr
    url: /DECISIONS.md#DEC-012
  - id: DEC-022
    name: External standards drafted by analysis are gated by publishing, not by per-line approval
    url: /DECISIONS.md#DEC-022
modified:
  by: agent/claude-code
  at: '2026-10-09T18:00:00.000Z'
---
# TASK-046 — Framework analysis check and recover (step D) — exhaustive but bounded

Built: two new stages of the `analyse` job between `extract` and `write`, using the same chaining, cursor and resume rules as step C. `gaps` (one job per round, cursor = the round about to be asked) runs the gap finder over everything proposed so far, reconciles it with the gaps on record and plans the round; `recover` (one job per question group, cursor = its index) asks one narrow `aiExtract` (`recover.v1`) about a few pages. Answers are Appendix B items, logged in `extraction_item` with their round and gap, and go through the same quote verification and merge as the extraction's (the merge now prefers a copy whose quote and wording check out, then the longest). The loop stops when there are no open gaps, nothing can be asked, the round limit is reached, a round adds nothing (no newly verified item and no new confirmed absence), or the per-run spend limit refuses a call; the budget ends the recovery, not the run, which still writes and succeeds.

Gap finder (`analysis/gaps.ts`, pure, no accreditor-specific code): numbering holes among siblings (numbers, letters, roman numerals, Arabic-Indic and Persian digits, any separators and prefixes; ambiguous "i"/"v"/"c" read from the siblings, then the structure stage's numbering examples; a hole of more than 3 is a deliberate jump; a leading hole only for a series); parents referenced but never extracted (orphans' parents, notes' requirements); requirements and notes whose quote or wording did not verify; requirements under the confidence threshold; substantive pages of standards documents no verified item cites (≥ 40 words, not a contents/index page by dot leaders and trailing page numbers or a contents heading, not a continuation of the item on the page before); conflicts (the same code with materially different wording from two documents or windows; flagged, never asked about). Codes already in the draft, codes a person deleted, and rows a person made, edited or reviewed are never asked about.

Recovery bookkeeping (`analysis/recovery.ts`): gaps keyed by subject (`req:<code>`, `note:<code>:<fingerprint>`, `page:<doc>:<n>`, `conflict:<code>`) with status open → recovered / confirmed_absent / unresolved / conflict, the round, attempts, detail, the model's reason, and the requirement id once written. Questions about the same pages share one call (at most 4 per call, 12 calls per round). A question the model answers "not there" closes its gap as confirmed absent and it is never asked again. Max rounds: `ai_setting.max_recovery_rounds` (migration 0040; default 2, 0 to 5, 0 turns recovery off), in the shared DTO, `GET/PUT /api/settings/ai` and Settings → AI next to the spend limits; snapshot into the run at its first check.

Deletion memory: `analysis_dismissal` (migrations 0040-0041; tenant RLS, audit, append-only for the app, read-only for the worker), written by an AFTER DELETE trigger on requirement and requirement_note when a person (not the worker) deletes an AI-made row: version and code, plus the note's text (its fingerprint is computed in core). A trigger rather than the delete service so every delete path counts, like `mark_person_edit`. The writer and the gap finder skip dismissed codes and notes unless the code is back in the draft; the run's stats count them (`dismissedSkipped`). No frozen-version or worker-guard trigger was changed.

Report and stats: `report.gaps` and `report.recovery` (max rounds, rounds with open gaps, calls and items, why it stopped); stats add `gapsRecovered`, `gapsUnresolved`, `gapsConfirmedAbsent`, `conflicts`, `uncoveredPages`, `dismissedSkipped`, `recoveryRounds`; progress adds `round`, `maxRounds`, `tasksTotal`, `tasksDone`, `gapsOpen`. UI: the progress strip shows the round and questions; a finished run shows a compact Gaps list (unresolved and conflicts first, "Show all" for the rest) with links to the requirement card (opens the Requirements tab and scrolls to it) and to the source page (opens the source on that page).

Also fixed: a failed job's attempts were never counted (the increment was rolled back with the job), so "after the 4th attempt the run is marked failed" could not trigger; `markFailed` now counts the attempt.

Not done here: the full report and the review screen (step F); a person cannot yet undo a dismissal (re-creating the code by hand works); Arabic-letter numbering (أ ب ج) is not read as a sequence; conflicts are flagged but not shown side by side.
