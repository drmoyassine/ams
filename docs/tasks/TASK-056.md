---
id: TASK-056
title: Real-document acceptance run (WSCUC, PUC, ABET) and tuning
description: >-
  Run the analysis on the original accreditor files with real keys; check PRD 19.2 (at least 95% of quotes found on the
  WSCUC handbook, scanned Arabic PUC read by OCR with spot-checks); compare with the hand-typed seed data and replace it
  with versions made from the files; measure embeddings against words-only and decide the default
status: pending
priority: P0
last_updated: '2026-10-12'
generated:
  by: agent/claude-code
  at: '2026-10-12T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-054
    name: Analysis report, run readiness checks, and removal of the import approve-everything option
    url: /TASKS.md#TASK-054
  - id: TASK-055
    name: Create from files and the split-view review of an external standard's requirements
    url: /TASKS.md#TASK-055
related_decisions:
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
  - id: DEC-023
    name: Embeddings rank IQF mapping candidates; vectors are stored in plain PostgreSQL arrays
    url: /DECISIONS.md#DEC-023
modified:
  by: agent/claude-code
  at: '2026-10-12T09:00:00.000Z'
---
# TASK-056 — Real-document acceptance run (WSCUC, PUC, ABET) and tuning

Step G of ROADMAP-009. Blocked on the owner's run: the keys are in the deployed app, not in the build sandbox.

Owner steps:
1. Redeploy the latest code.
2. Settings -> AI -> Models: Test analysis, reading and embeddings.
3. External Standards -> Create from files, with the WSCUC 2023 handbook (then the scanned PUC 2019 guide and the ABET criteria; note the ABET seed is labelled 2027-28 but holds 2025-26 text).
4. Send the Report tab (screenshot or Markdown download) for each run.

Then, from the reports:
- PRD 19.2: at least 95% of quotes found on the WSCUC handbook; hierarchy with verbatim text and page provenance; scanned Arabic PUC read through OCR and flagged for spot-check; NBAQ example items classified example/suggested; nothing published until a person publishes.
- Tune prompts, window size and the quote matcher from what the real runs show (prompt versions are bumped, never edited in place).
- Compare the found requirements with the seed data (the PUC text was transcribed by hand from a scan; the seed marks everything approved from an auto-approving import) and replace the seed with versions made from the real files.
- Run `pnpm analysis:eval-mapping` with the embedding endpoint (EMBED_BASE_URL, EMBED_MODEL, EMBED_DIMENSION, EMBED_API_KEY): words-only recall@10 was 48.4% on the 64 hand-labelled pairs (Arabic PUC 0%); decide whether embeddings become the default (DEC-023).
