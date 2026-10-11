---
id: ROADMAP-008
title: L — liteparse readiness (parallel track)
description: Implement Appendix D (LP1–LP10) in the liteparse repository and pin a release
quarter: Q1
status: In Progress
priority: P0
tags:
  - ams
last_updated: '2026-10-10'
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

Progress correction (2026-10-11): steps A–D of the compiler currently use the upstream `@llamaindex/liteparse` package, NOT the owned `@drmoyassine/liteparse` (0.5.0, pdfjs + mammoth + SheetJS + RapidOCR, no LibreOffice) that DEC-011 and PRD Appendix D name. Switching to the owned package and checking it against Appendix D (LP1–LP10) and the D.3 corpus is pending the owner's decision.
