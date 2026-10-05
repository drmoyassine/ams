---
id: TASK-020
title: 'M1 acceptance: Appendix A skeleton fixtures and the publish/immutability gate test'
description: >-
  Skeleton fixtures for WSCUC, ABET EAC and PUC from PRD Appendix A, loaded, published and edit-rejected through one
  code path
status: completed
priority: P0
last_updated: '2026-10-05'
generated:
  by: agent/claude-code
  at: '2026-10-05T10:07:20.748Z'
roadmap_item:
  id: ROADMAP-002
  name: M1 — Framework library
  url: /ROADMAP.md#ROADMAP-002
depends_on: []
related_decisions:
  - id: DEC-002
    name: Accreditor frameworks are versioned configuration; no accreditor-specific code
    url: /DECISIONS.md#DEC-002
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
modified:
  by: agent/claude-code
  at: '2026-10-05T10:07:20.748Z'
---
# TASK-020 — M1 acceptance: Appendix A skeleton fixtures and the publish/immutability gate test

packages/db/fixtures/*.json carry everything Appendix A specifies (lifecycles, vocabularies, report templates, requirement codes); official requirement text, quotes and notes are placeholders pending the source documents (TASK-011, TASK-012). packages/core/src/framework/fixtures.test.ts is the M1 gate; no-accreditor-code.test.ts guards DEC-002.
