---
id: TASK-057
title: Read lifecycle, vocabularies, milestones and report templates from policy and template documents
description: >-
  Extend the analysis to the document roles it does not use yet: policy/procedure documents (lifecycle, vocabularies,
  eligibility, milestones) and report-template documents (sections), as proposals in the draft
status: pending
priority: P1
last_updated: '2026-10-12'
generated:
  by: agent/claude-code
  at: '2026-10-12T09:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-056
    name: Real-document acceptance run (WSCUC, PUC, ABET) and tuning
    url: /TASKS.md#TASK-056
related_decisions:
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
  - id: DEC-022
    name: External standards drafted by analysis are gated by publishing, not by per-line approval
    url: /DECISIONS.md#DEC-022
modified:
  by: agent/claude-code
  at: '2026-10-12T09:00:00.000Z'
---
# TASK-057 — Read lifecycle, vocabularies, milestones and report templates from policy and template documents

Step H of ROADMAP-009 (PRD 15.1 step 4, Appendix B kinds: report_section, milestone, decision, finding_severity, response_type, metadata).

Today the analysis writes requirements and notes only (from standards and guidance documents). Add extraction by role:
- policy_procedure: lifecycle phases and milestones (due text copied, never converted to dates: a reviewer sets the rules), decision and finding vocabularies, response types, eligibility.
- report_template: report sections and their block types, so a template can be proposed from the accreditor's own outline.
- Everything lands in the draft version's configuration and template tables as proposals the person can edit; publishing the version is the gate (DEC-022). Quotes verified as for requirements; required items need a verified quote (DEC-006).
- New versioned prompts and Zod schemas; gaps and report sections for them; tests with the fake model.
Start after the first real run, so prompts are shaped by real documents.
