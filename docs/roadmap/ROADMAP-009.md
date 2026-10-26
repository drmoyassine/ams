---
id: ROADMAP-009
title: M7 — Framework compiler
description: Upload, classify, parse, AI extract, verify quotes, split-view review, publish
quarter: Q2
status: In Progress
priority: P0
tags:
  - ams
last_updated: '2026-10-26'
related_tasks:
  - id: TASK-043
    name: Read source files into page text (parseDocument and the extract_text job)
    url: /TASKS.md#TASK-043
  - id: TASK-044
    name: AI connection, embeddings and Settings → AI
    url: /TASKS.md#TASK-044
  - id: TASK-045
    name: Framework analysis runs (step C) — requirements from a draft's sources
    url: /TASKS.md#TASK-045
  - id: TASK-046
    name: Framework analysis check and recover (step D) — exhaustive but bounded
    url: /TASKS.md#TASK-046
  - id: TASK-047
    name: Publishing is the review for external standards (DEC-022 publish gate)
    url: /TASKS.md#TASK-047
  - id: TASK-048
    name: Settings -> AI offers OpenAI, Google and any OpenAI-compatible server next to Anthropic
    url: /TASKS.md#TASK-048
  - id: TASK-049
    name: Background work runs as three services (worker, parser, agent); the app prepares Garage itself
    url: /TASKS.md#TASK-049
  - id: TASK-050
    name: Analysis proposes links to the IQF and new IQF items; a person accepts them (step E)
    url: /TASKS.md#TASK-050
  - id: TASK-051
    name: 'Settings -> AI redesigned: saved accounts, one model per role, fetched model lists, a single cap, reading settings'
    url: /TASKS.md#TASK-051
  - id: TASK-052
    name: Every format is read by liteparse; the parser image includes LibreOffice and ImageMagick
    url: /TASKS.md#TASK-052
  - id: TASK-054
    name: Analysis report, run readiness checks, and the import page's approve-everything option removed (step F1)
    url: /TASKS.md#TASK-054
  - id: TASK-055
    name: Create from files and the split-view review of an external standard's requirements
    url: /TASKS.md#TASK-055
  - id: TASK-056
    name: Real-document acceptance run (WSCUC, PUC, ABET) and tuning
    url: /TASKS.md#TASK-056
  - id: TASK-057
    name: Read lifecycle, vocabularies, milestones and report templates from policy and template documents
    url: /TASKS.md#TASK-057
  - id: TASK-059
    name: Production check of the three background services and the parser image
    url: /TASKS.md#TASK-059
  - id: TASK-060
    name: 'Compiler follow-ups: small gaps found while building steps A-F'
    url: /TASKS.md#TASK-060
  - id: TASK-107
    name: Documents to furnish and update the IQF and published standards
    url: /TASKS.md#TASK-107
  - id: TASK-108
    name: Meaning-based search and similar requirements; keep vectors current
    url: /TASKS.md#TASK-108
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:41.356Z'
vision_theme:
  id: trustworthy-traceability
  name: Official, suggested and inferred are always distinguishable
  url: /VISION.md#trustworthy-traceability
related_decisions:
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
  - id: DEC-011
    name: liteparse for document parsing, co-developed to AMS requirements
    url: /DECISIONS.md#DEC-011
  - id: DEC-012
    name: Vercel AI SDK with the Anthropic provider behind aiExtract/aiOcr
    url: /DECISIONS.md#DEC-012
  - id: DEC-013
    name: AI processing approved for framework source documents; evidence not sent in the MVP
    url: /DECISIONS.md#DEC-013
modified:
  by: agent/claude-code
  at: '2026-10-26T10:53:05.313Z'
---
# ROADMAP-009 — M7 — Framework compiler

# ROADMAP-009 — M7 — Framework compiler

Done when PRD §19.2 passes on the WSCUC 2023 Handbook and the scanned PUC 2019 guide.

Extended (2026-10-08) to the owner's document-intelligence requirement: a standard is created from its files; an
analysis finds the accreditor's own structure, drafts requirements in its exact wording, proposes IQF links or new IQF
items, and ends with a report the user can return to (DEC-021, DEC-022, DEC-023).

Pulled ahead of M4's remainder on the owner's priority (2026-10-26): upload documents and generate IQF content first;
M4's TASK-093/095/096 wait.

| Step | What | Status |
|---|---|---|
| A | Read files: `parseDocument()` (PDF via liteparse; DOCX, XLSX, PPTX, CSV), `extract_text` job | Done — TASK-043 |
| B | AI connection: `aiExtract`/`aiOcr`/`embed`, budget, call log, Settings → AI | Done — TASK-044 |
| C | Analysis run: survey, structure, windowed extraction, quote check, write into the draft | Done — TASK-045 |
| D | Gap finding and bounded recovery rounds; deletions remembered | Done — TASK-046 |
| E | IQF mapping: hybrid shortlist (embeddings + trigram), AI judges, proposed new IQF items, accept/reject | Done — TASK-050 |
| F | Report screen, review UX, "Create from files", publish gate per DEC-022 (retire per-line approval) | Publish gate and per-line approval retired — TASK-047; report, run readiness checks and removal of the import approve-everything option done — TASK-054 (F1); "Create from files" and the split-view review — TASK-055 (F2) |
| F2 | Create from files and the split-view review (source viewer, Needs a look, merge, split) | Done — TASK-055 |
| G | Real-document acceptance: §19.2 on WSCUC/PUC/ABET originals with a real key; compare with seed data | Needs the owner's run — TASK-056 |
| H | Other document roles: lifecycle, vocabularies, report templates from policy/template documents | Done — TASK-057 (tested with a fake model on invented documents; prompts to be tuned on the TASK-056 run) |
| I | The institution's own framework from its own documents: internal prompt variants, the institution's level names kept (DEC-016), mapping skipped, wording proposed as diffs a person accepts or declines | Done — TASK-107 (upload-based; URLs come with TASK-102) |


Snapshot 2026-10-13 — what is left (full picture: docs/status.md) (steps A–F are built and tested with a fake model; none has run on a real accreditor document yet):

| Work | Task | Who | Status |
|---|---|---|---|
| Redeploy; check the parser image, the three services and Garage on a real build | TASK-059 | Owner (+ me reading logs) | Pending |
| Real-document run: WSCUC, PUC, ABET; PRD §19.2; seed replacement; embeddings decision | TASK-056 | Owner runs, I tune | Pending (needs the run) |
| Lifecycle, vocabularies, milestones and report templates from policy/template documents | TASK-057 | Me | Done (tune the prompts after the real run) |
| Appendix D changes in the liteparse repository; then drop the fallback and LibreOffice | TASK-058 | Owner (their repo) | Pending |
| Small gaps from steps A–F (undo a deletion, Arabic-letter numbering, parser heartbeat, …) | TASK-060 | Me | Pending |
| Items outside the compiler (reporting frequency, institution logo, BI connector, SMTP links, Engagements) | TASK-061 | — | Backlog |
