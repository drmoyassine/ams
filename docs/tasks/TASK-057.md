---
id: TASK-057
title: Read lifecycle, vocabularies, milestones and report templates from policy and template documents
description: >-
  Extend the analysis to the document roles it does not use yet: policy/procedure documents (lifecycle, vocabularies,
  eligibility, milestones) and report-template documents (sections), as proposals in the draft
status: completed
priority: P1
last_updated: '2026-10-13'
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
  at: '2026-10-13T12:00:00.000Z'
---
# TASK-057 — Read lifecycle, vocabularies, milestones and report templates from policy and template documents

Step H of ROADMAP-009 (PRD 15.1 step 4, Appendix B kinds: report_section, milestone, decision, finding_severity, response_type, metadata).

Today the analysis writes requirements and notes only (from standards and guidance documents). Add extraction by role:
- policy_procedure: lifecycle phases and milestones (due text copied, never converted to dates: a reviewer sets the rules), decision and finding vocabularies, response types, eligibility.
- report_template: report sections and their block types, so a template can be proposed from the accreditor's own outline.
- Everything lands in the draft version's configuration and template tables as proposals the person can edit; publishing the version is the gate (DEC-022). Quotes verified as for requirements; required items need a verified quote (DEC-006).
- New versioned prompts and Zod schemas; gaps and report sections for them; tests with the fake model.
Start after the first real run, so prompts are shaped by real documents.

Built (the prompts are written from the PRD's Appendix A fixtures, not from real documents: re-tune them after the TASK-056 run):
- Three new stages in the existing `analyse` job chain (no new job type), after `write` and before the mapping (`packages/core/src/framework/analysis/config-stages.ts`). Why there: the requirements are settled first, and the mapping, the costly part a spend limit should cut, stays last. `write` routes to them only when the version has a document with the role policy_procedure, report_template or guidance; otherwise the run goes straight to `embed` and the report says "no policy ... document, nothing to read" (no extra job).
  - `config_survey` (cursor = document): one `config_survey.v1` call per such document says which of lifecycle, vocabularies and template it holds and on which pages; a report-template document is read for a template only. The last job plans the windows (~8 pages, 1 page overlap, per document and target).
  - `config_extract` (cursor = window): `lifecycle.v1`, `vocab.v1` or `template.v1` (temperature 0, text copied, page and quote on every item). Items are logged in `extraction_item` under the Appendix B kinds (`milestone`, `decision`, `finding_severity`, `response_type`, `report_section`, and phases and the rating method as `metadata`); only items citing a page of the window are taken.
  - `config_write` (one job, no model call): `config-merge.ts` (pure) verifies and merges, `config-stages.ts` writes. Same stage/cursor/resume/cancel rules as the others; the spend limit ends THIS part (`configBudgetStop`: what was extracted so far is still checked and written), not the run.
- Shapes covered: `lifecycle_template` (phases of the five allowed types in process order, milestones with name, type, required, `source_ref`, optional description and per-kind `applies_to`; the deliverable is linked to a template of the same run or a person's by name), `decision_vocab` (label as printed, outcome from the allowed set, term years), `finding_vocab` (requires_action), `response_vocab` (reply_required, reply_window_days when the text states a number, reply_kind, is_decision), `rating_method` (only when the document gives scale, labels, rated level AND how ratings combine), and one `report_template` per template document (sections with their printed numbering as keys, nesting by parent, title and prompt copied, block type from the seven allowed, word limit, enum/number/date/text columns, `requires_attestation` from an attestation section). Eligibility conditions become milestones of type `task` in an eligibility phase (the configuration has no separate eligibility field).
- Dates are never converted. A milestone whose document states a timing or a repeat ("annually") is written with `due: null`, the words copied into the new optional `due_text` and `due_pending: true` (`MilestoneTemplateSchema`); `checkFrameworkConfig` reports each as "the reviewer must set the due rule (the document says: ...)", so `validateVersion` blocks submit and publish until a reviewer sets a rule and removes the mark (or chooses manual). A step with no timing in the document is written without the mark. Codes and keys are derived deterministically: a printed code when valid, else a lower-case ASCII slug of the label, else `decision_1`-style fallbacks (Arabic names keep their label as printed and get numbered keys).
- Verification (deterministic, Arabic-aware, `quote-match.ts` reused): an item is written only when its quote is found on the cited page (or a neighbour) and its name, label or title is in the page text; the sentence, timing words and instructions kept with it must be in the text too, else they are left out with a reason. Overlap duplicates are merged (the sounder, fuller copy wins). Anything refused by the configuration schemas (no outcome, no `requires_action`, labels and scale of different length, a data table without columns, a template the schema rejects) is kept as a flagged item in the run log (`extraction_item`, with its flags) and in `report.config.result`, never written as valid configuration.
- Human edits (DEC-022): migration `0050_analysis_config.sql`. `framework_version.config_edited` is set by the database (trigger `b_mark_config_edit`) for each configuration part (lifecycle, decision, finding, response, rating) that any update other than the worker's changes; `framework_version.config_found` records what the analysis wrote into each part, with document, page and quote per item; `report_template.edited_by_person` is set by the existing `mark_person_edit` trigger. The worker may write a part only when it is empty or recorded in `config_found`, and never when `config_edited` says a person changed it (the worker guard raises); an imported or copied part (non-empty, not recorded) is therefore a person's. Templates: an AI template nobody touched is updated, a person's or imported one is kept, one a person deleted (its key is in `config_found`) is not added back. Nothing is ever deleted; a run that stopped at the spend limit does not replace a fuller earlier result. Grants: `UPDATE` on the five configuration columns and `config_found` of `framework_version`, `INSERT` and a column-limited `UPDATE` on `report_template`; still no `DELETE`, no review, status or publication columns, draft versions only, never the quality framework. The worker writes with its own transaction (the same guard triggers, audit and frozen-version triggers apply) rather than through `updateVersionConfig` and `upsertReportTemplate`, which need a person's permission, mark `origin: manual` and reset review.
- Report and UI: `report.configuration` (AnalysisReport DTO, `getAnalysisReport`, Markdown) lists the documents read and what each held, the state of each part (written, left as you edited it, nothing found, only flagged) with whether you edited it since, every item with its page link, the timing words as written, the flagged items with their reasons and quotes, what the documents did not contain, templates you deleted, and the count of milestones needing a due rule (live). "Before you publish" gains `config_flagged`, `config_due_rules`, `config_kept` and `config_not_found`; the due-rule problems also come through `validateVersion`. The Settings tabs show "Found by the analysis · page N" with the source quotes on what the analysis wrote and "You have edited this" afterwards (editing is unchanged); the Analysis panel's strip and counts name the new stages. The readiness list gains the informational line "Documents that can supply configuration: n".
- Tests (no network, invented documents in `config-fixture.ts`): pure merge tests (duplicates across windows, unverified quotes, schema refusals, keys, nesting, deliverable matching, `checkFrameworkConfig` reporting the due rule), the pipeline (stage routing, calls, lifecycle with due text copied and flagged, vocabularies, template with nesting and attestation, an Arabic policy with diacritics, human-edited parts and a deleted template untouched on re-run, a part made by a person kept, skipped when there is no such document, spend limit mid-stage with partial results written, resume after a failed job, a version taken out of draft, the readiness line, the report section and checklist), database tests for the worker's limits (empty/owned/edited/foreign parts, draft only, internal framework, no status/publication/review/delete, templates), UI tests for the report card, the Settings markers, the readiness line and the progress strip. The existing tests were updated for the extra guide survey call and two jobs.

Not done: no check-and-recover rounds for configuration (a missed milestone or section is not asked for again; the flagged list and the report's "not found" lines are the equivalent); decision `follow_up` rules, `term_options` beyond what the text lists, `recurrence`, `next_cycle`, `reply_template_key`, `reply_due`, `item_categories` and table dataset bindings are not extracted (a reviewer sets them; a response whose reply is a report is written without `reply_kind` and says so); `requirement_codes` of template sections are not linked; the same template title in two documents would share a name in the report's "kept" wording; level names still come from the structure stage only. Not run on a real document.
