---
id: TASK-050
title: Analysis proposes links to the IQF and new IQF items; a person accepts them (step E)
description: >-
  After an analysis run writes an external standard into the draft, new stages (embed, map, propose_new) shortlist IQF
  candidates by words and, when on, meaning; the AI judges them; suggested links and suggested new IQF items stay
  proposals until a person accepts them; shortlist recall@10 is measured against a hand-labelled set
status: completed
priority: P1
last_updated: '2026-10-11'
generated:
  by: agent/claude-code
  at: '2026-10-11T07:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-048
    name: Settings -> AI offers OpenAI, Google and any OpenAI-compatible server next to Anthropic
    url: /TASKS.md#TASK-048
related_decisions:
  - id: DEC-021
    name: Framework analysis may send the institution's IQF text to the AI
    url: /DECISIONS.md#DEC-021
  - id: DEC-022
    name: External standards drafted by analysis are gated by publishing, not by per-line approval
    url: /DECISIONS.md#DEC-022
  - id: DEC-023
    name: Embeddings rank IQF mapping candidates; vectors are stored in plain PostgreSQL arrays
    url: /DECISIONS.md#DEC-023
modified:
  by: agent/claude-code
  at: '2026-10-11T07:00:00.000Z'
---
# TASK-050 — Analysis proposes links to the IQF and new IQF items; a person accepts them (step E)

Step E of ROADMAP-009. After `write`, the `analyse` job chain continues with three stages (same stage/cursor/resume/budget rules as steps C and D; no new job type, so it still runs in the `agent` service): `embed`, `map`, `propose_new`, then `finalise`.

Built:
- `embed` (`mapping-stages.ts`): if embeddings are on in Settings -> AI, `upsertEmbeddings` for this version's requirements and the IQF's items (requirement owner type only; unchanged texts skipped by hash). Off, not set up, or the endpoint failing: recorded as "Lexical only" in the report and the run goes on. No IQF, an empty IQF, or no requirements: `mapping.skipped` says why and the run ends.
- `map`: ~10 requirements per `aiExtract` call (`map.v1`, temperature 0). Per requirement a shortlist of at most 8 items of the IQF's current published (else latest) version: words (`shortlist.ts`: normalised, stemmed tokens with Arabic folding reused from `quote-match.ts`, BM25 weights, how much of an item's title is found in the requirement, explicit code references; no database extension) fused by reciprocal rank with vector similarity (`rankBySimilarity`) when embeddings are on; fewer than 4 candidates are padded with the IQF's top-level items so the model can still say where it belongs. The model judges every candidate (covers / partly_covers / related / none) with a short reason quoting both sides. Ranking never decides; its numbers are stored nowhere and shown nowhere.
- `propose_new`: requirements judged this run with no covers/partly_covers suggestion (and not settled by an earlier accepted or dismissed proposal) are grouped, ~20 per call (`newiqf.v1`); each group yields a drafted IQF item: parent by code (moved up when the IQF has no level for that depth), level label from the IQF's `level_labels`, code (the model's if free, else the next free number under the parent), title and description in the IQF's own words, and the requirements it would answer. AI-drafted.
- Report: `report.mapping` with counts only (requirements, judged, left alone because a person decided, mapped, without a suggestion, links by relation, new items), `retrieval` ("hybrid" / "lexical only"), embeddings used/embedded/reused, shortlist stats. A spend limit hit in these stages ends the mapping, not the run (like the recovery rounds): `mapping.stopped = 'budget'`.
- Storage: suggested links are `requirement_mapping` rows, origin `ai`, review `pending` (reason in the existing `rationale`); new column `edited_by_person` set by the database on any non-worker update. New items are `iqf_item_proposal` (tenant RLS, audit; pending / accepted / dismissed / superseded; `links` jsonb with relation and reason per external code). Migration 0044 (forward-only): the worker may INSERT links as proposals only and UPDATE only relation/reason of an untouched AI link (guard trigger); it may insert pending proposals and update pending ones only; the worker guard of 0039 now refuses the internal framework (the worker cannot write the IQF at all); the publish gate's "AI item needs a source reference" now applies to external standards only (an accepted IQF item has no source page; the IQF's own rule, every item approved by a person, stands); `analysis_run_stage_check` widened.
- Re-runs: untouched pending AI links are refreshed in place; approved, rejected, person-made or person-edited links are never touched; a rejected pair is not offered again; a requirement with an approved or person-made link is not judged again; accepted and dismissed new-item proposals are remembered by external code, and a pending one a later run does not repeat is marked superseded.
- Accepting (`mapping/proposals.ts`, five-step chain, `framework:review`, and `framework:write` for adding an item): accept/reject a link uses the existing review path; "accept all in this view" (`POST /api/framework-versions/{id}/mappings/accept-covers`) approves only listed pending AI links whose relation is `covers`; accepting a new-item proposal (`POST /api/iqf-proposals/{id}/accept`, with optional edits to code, title, description, parent) creates the requirement in the IQF's draft (origin `ai`, review `pending`) and the links (approved), and is refused with "Start a new version of the quality framework first" when the IQF has no draft; dismiss is remembered.
- UI: Mappings tab shows "Suggested links" grouped by requirement (relation, IQF code and title, the model's reason, Accept / Reject; filters Suggested / Accepted / Rejected; "Accept all that cover (n)" behind a confirmation dialog) and "Suggested new IQF items" (AI-drafted; Accept… opens an edit dialog; Dismiss); the Analysis panel shows the new stages, progress and a counts-only mapping summary. Plain wording, `dir="auto"` on institutional text, no scores or percentages.
- Evaluation (`mapping-eval.ts`, `pnpm analysis:eval-mapping`, documented in CLAUDE.md): pure shortlist recall@k over the hand-labelled set in `packages/core/eval/mapping-labels.json` (the demo data has no requirement mappings of its own, only glossary terms, so 64 pairs were labelled by hand: WSCUC 35, ABET 9, PUC 20, against the starting template's items). Lexical recall@10 measured: 48.4% overall (WSCUC 68.6%, ABET 77.8%, PUC/Arabic 0.0%: no shared words with English items, which is what embeddings are for). With `EMBED_BASE_URL`, `EMBED_MODEL`, `EMBED_DIMENSION` set the script prints the hybrid number beside it.

Tests: pure ranking/recall (`mapping-eval.test.ts`); core end to end (`iqf-mapping.test.ts`: run, pending AI links and proposals, nothing written into the IQF, bulk accept covers only, accept/reject, refusal without an IQF draft, accept with edits, re-run does not duplicate or overwrite, embeddings on and failing, spend limit in `map` and in `propose_new`, nothing to map onto); existing analysis tests updated for the extra stage; DB (`mapping-proposals.test.ts`: worker limits on links, proposals and the IQF; publish gate); API (`iqf-mapping.test.ts`); UI (`suggestions-ui.test.tsx`). No network anywhere.

Not done here: no real embedding endpoint or model was available, so only the lexical recall is measured; the hybrid number and whether embeddings should be on by default (DEC-023) wait for a run of the script with a real endpoint. The full report and review screen are step F. A suggested new item is grouped within a chunk of ~20 requirements, so the same need in two chunks can yield two proposals. Deleting (rather than rejecting) a pending suggested link makes a later run propose it again.
