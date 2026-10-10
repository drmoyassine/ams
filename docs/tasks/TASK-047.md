---
id: TASK-047
title: Publishing is the review for external standards (DEC-022 publish gate)
description: >-
  An external standard drafted by the framework analysis is published as a whole: pending AI rows no longer block
  submit or publish, a required note still needs a verified quote, unverified requirement quotes are warnings, and the
  per-line review labels and approve/reject controls are gone from external requirements and notes
status: completed
priority: P0
last_updated: '2026-10-10'
generated:
  by: agent/claude-code
  at: '2026-10-10T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-046
    name: Framework analysis check and recover (step D) — exhaustive but bounded
    url: /TASKS.md#TASK-046
related_decisions:
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
  - id: DEC-022
    name: External standards drafted by analysis are gated by publishing, not by per-line approval
    url: /DECISIONS.md#DEC-022
modified:
  by: agent/claude-code
  at: '2026-10-10T12:00:00.000Z'
---
# TASK-047 — Publishing is the review for external standards (DEC-022 publish gate)

Where the old rule lived: only in the database. `enforce_publish_gate()` (migration 0005, trigger `b_publish_gate` on `framework_version`) refused publishing while any requirement or note had `review_status <> 'approved'`. The core services (`submitForReview`, `publishVersion`) checked only the configuration and that a requirement exists; the UI carried the per-line ceremony (Approve/Reject in each requirement card's menu, Approve note/Reject note, the "Pending review" / "Reviewed: approved" badge on cards and notes).

Built:
- Migration 0042 (forward-only) replaces the body of `enforce_publish_gate()`. External standards (`framework.internal = false`): pending rows no longer block; a row a person explicitly rejected still does. The internal quality framework keeps the 0005 rule (every requirement and note approved). For every framework, a `required` note still needs a verified quote and every AI-originated item a source reference. No row is updated, no other trigger is touched; published versions stay frozen as before.
- `validateVersion` (core) checks an external version's content as well as its configuration: a `required` note without a verified quote and a rejected line are blocking issues (with the requirement's code in the path); requirements whose quote was not found are one non-blocking warning ("n requirements' quotes were not found in the sources: codes"). The result and `GET /api/framework-versions/{id}/validation` carry `warnings`; submit and publish refuse on issues as before. The IQF validation is unchanged.
- The human approval is the version's existing `published_by` / `published_at`; rows stay as they were (pending AI rows are frozen as pending).
- UI (external standards): no review badge on requirement cards or notes, no Approve/Reject in the card menu, no Approve note/Reject note. Provenance stays (AI marker, source page and quote, "Quote not found in source", "Quote verified / NOT verified" on required notes). The `ai_suggested` authority reads "Suggested by the analysis (not confirmed in the source)" everywhere. The version page shows blocking problems in the amber banner ("n problems to fix before this version can be published") and warnings in a softer grey one ("n things to check before publishing (not blocking)"); a refused submit or publish refreshes them. The requirement dialog no longer says "returns it to review".
- Seed data imported with `autoApprove` is left as stored; the UI simply no longer shows its labels.

Tests: core (`framework.test.ts`) an analysis-style draft of pending AI rows validates with a warning, submits and publishes, records the publisher and leaves the rows pending; a required note without a verified quote blocks submit, publish and the database; a rejected line blocks; the gate test now exercises the AI-source-reference rule. `analysis.test.ts` runs the fixture analysis end to end and publishes the result unchanged. DB (`frozen.test.ts`) pending external rows publish and stay frozen; rejected external rows block; the approval rule is asserted on an internal framework. API and web tests updated for publishing without per-line approval, and a web test for the problem and warning banners. `internal.test.ts` (unchanged) still proves the IQF needs approved items.

Not done here: the review screen and report of step F; the import page's "Approve everything on import" option still exists (it still checks required-note quotes on import, but no longer decides whether an external version can be published); the per-line review API routes remain (used by the IQF and the report-template review); report-template review badges are unchanged.
