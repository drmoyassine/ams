---
id: ROADMAP-008
title: L — liteparse readiness (parallel track)
description: Implement Appendix D (LP1–LP10) in the liteparse repository and pin a release
quarter: Q1
status: In Progress
priority: P0
tags:
  - ams
last_updated: '2026-10-12'
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

Progress (2026-10-12): the owned `@drmoyassine/liteparse` is the parser behind `parseDocument()` (TASK-053); formats it does not read (PowerPoint, OpenDocument, RTF, legacy Office) use a temporary upstream fallback. Appendix D status per requirement and the 11 proposed changes for the liteparse repository are in `docs/liteparse-appendix-d-status.md` (only LP5 is fully met). Open: TASK-058 — land the changes in a released version, pin it, remove the fallback.
