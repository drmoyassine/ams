---
id: ROADMAP-009
title: M7 — Framework compiler
description: Upload, classify, parse, AI extract, verify quotes, split-view review, publish
quarter: Q2
status: In Progress
priority: P0
tags:
  - ams
last_updated: '2026-10-10'
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
  by: agent/claude-cowork
  at: '2026-10-05T07:53:41.356Z'
---
# ROADMAP-009 — M7 — Framework compiler

Done when PRD §19.2 passes on the WSCUC 2023 Handbook and the scanned PUC 2019 guide.

Extended (2026-10-08) to the owner's document-intelligence requirement: a standard is created from its files; an
analysis finds the accreditor's own structure, drafts requirements in its exact wording, proposes IQF links or new IQF
items, and ends with a report the user can return to (DEC-021, DEC-022, DEC-023).

| Step | What | Status |
|---|---|---|
| A | Read files: `parseDocument()` (PDF via liteparse; DOCX, XLSX, PPTX, CSV), `extract_text` job | Done — TASK-043 |
| B | AI connection: `aiExtract`/`aiOcr`/`embed`, budget, call log, Settings → AI | Done — TASK-044 |
| C | Analysis run: survey, structure, windowed extraction, quote check, write into the draft | Done — TASK-045 |
| D | Gap finding and bounded recovery rounds; deletions remembered | Done — TASK-046 |
| E | IQF mapping: hybrid shortlist (embeddings + trigram), AI judges, proposed new IQF items, accept/reject | Done — TASK-050 |
| F | Report screen, review UX, "Create from files", publish gate per DEC-022 (retire per-line approval) | Publish gate and per-line approval retired — TASK-047; rest planned |
| F2 | Create from files and the split-view review (source viewer, Needs a look, merge, split) | Done — TASK-055 |
| G | Real-document acceptance: §19.2 on WSCUC/PUC/ABET originals with a real key; compare with seed data | Needs key + files |
| H | Other document roles: lifecycle, vocabularies, report templates from policy/template documents | Planned |
