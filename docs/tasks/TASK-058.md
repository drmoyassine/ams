---
id: TASK-058
title: Hand the Appendix D changes to the liteparse repository and remove the temporary fallback
description: >-
  The owned @drmoyassine/liteparse meets PRD Appendix D (LP1-LP10) in a released version; AMS pins it and drops the
  upstream fallback reader and LibreOffice from the parser image
status: pending
priority: P1
last_updated: '2026-10-12'
generated:
  by: agent/claude-code
  at: '2026-10-12T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-008
  name: L — liteparse readiness (parallel track)
  url: /ROADMAP.md#ROADMAP-008
depends_on:
  - id: TASK-053
    name: The owned @drmoyassine/liteparse is the parser; a temporary fallback reads the formats it lacks
    url: /TASKS.md#TASK-053
related_decisions:
  - id: DEC-011
    name: liteparse for document parsing, co-developed to AMS requirements
    url: /DECISIONS.md#DEC-011
modified:
  by: agent/claude-code
  at: '2026-10-12T09:00:00.000Z'
---
# TASK-058 — Hand the Appendix D changes to the liteparse repository and remove the temporary fallback

ROADMAP-008, owner side. docs/liteparse-appendix-d-status.md lists, per requirement and per D.3 corpus case, what @drmoyassine/liteparse 0.5.0 does today (only LP5, the injectable vision hook, is fully met) and 11 proposed changes in priority order:
1. Per-page PDF results with page-wise escalation.
2. Keep line breaks in native text.
3. Text-layer quality score and forceMethod.
4. Read PPTX, ODF, RTF and legacy Office; never decode unknown kinds as text.
5. DOCX and XLSX pseudo-pages with labels.
6. Arabic reading order, NFC, language routing.
7. Caps become warnings.
8. Reproducibility fields (parserVersion, configHash).
9. Packaging (declare sharp and canvas peers; the xlsx CDN tarball).
10. Process isolation.
11. A local-OCR confidence floor.

When these land and a version is released: pin it in AMS, delete the wrapper workarounds it makes redundant (per-page splitting, line-break repair, text-quality check), delete `parse-document-fallback.ts` and the upstream package, and remove LibreOffice and the fonts from the parser image. The D.3 corpus (WSCUC handbook, ABET APPM, NBAQ 2017, scanned PUC) is the acceptance test.
