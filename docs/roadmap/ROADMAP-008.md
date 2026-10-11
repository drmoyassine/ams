---
id: ROADMAP-008
title: L — liteparse readiness (parallel track)
description: Implement Appendix D (LP1–LP10) in the liteparse repository and pin a release
quarter: Q1
status: In Progress
priority: P0
tags:
  - ams
last_updated: '2026-10-11'
generated:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:39.872Z'
vision_theme:
  id: trustworthy-traceability
  name: Official, suggested and inferred are always distinguishable
  url: /VISION.md#trustworthy-traceability
related_decisions:
  - id: DEC-011
    name: liteparse for document parsing, co-developed to AMS requirements
    url: /DECISIONS.md#DEC-011
modified:
  by: agent/claude-cowork
  at: '2026-10-05T07:53:39.872Z'
---
# ROADMAP-008 — L — liteparse readiness (parallel track)

Gate before M7. Done when the Appendix D corpus passes and AMS parseDocument() contract tests pass against the released version.

Progress (2026-10-11, TASK-053): the AMS now uses the owned `@drmoyassine/liteparse` 0.5.0 (pdfjs-dist + mammoth + SheetJS; injected vision model) for PDF, DOCX, XLSX, CSV and images, called one page at a time from `parseDocument()`. Steps A–D had used the unrelated upstream `@llamaindex/liteparse`; that is now only a temporary fallback for the formats the owned library does not read (PowerPoint, OpenDocument, RTF, legacy DOC/XLS). Appendix D is NOT met by the library alone: per requirement and corpus case, what it does, what the AMS wrapper compensates and the changes to make in the liteparse repository are in docs/liteparse-appendix-d-status.md (most important: per-page PDF results with page-wise escalation, line breaks in native text, text-layer quality check, the missing formats, DOCX/XLSX pseudo-pages, Arabic order). The gate stays open until those land in a released version and the D.3 corpus passes on the real documents.
