# Accreditation Management System (AMS) — Product Requirements

**Version:** 1.5 (build-ready)
**Changes in 1.1:** every submission now opens a tracked accreditor-response sub-cycle (§11): responses and their items (missing items, corrections, queries, findings, confirmations) are logged, assigned, resolved, answered and closed, with revised resubmissions as new rounds.
**Changes in 1.2:** engagement-level roadmap editing with guardrails (§8.5); a mandatory Engagement Lead (§4); dataset evidence and the data-source integration contract, with and without an institutional BI layer (§9.4–9.6); database rationale (§18.2).
**Changes in 1.3:** host-agnostic stack — standard PostgreSQL, S3-compatible storage and OIDC/SAML instead of Supabase-specific services; AI processing of framework documents approved (§18.1, §20).
**Changes in 1.4:** document parsing via **liteparse** (owned, co-developed to AMS requirements — Appendix D); AI calls via the **Vercel AI SDK** with the Anthropic provider (§18.1).
**Changes in 1.5:** application layout is a **React single-page app (Vite) + Hono API** on Node instead of Next.js; every data access passes one Hono middleware chain (§18.3); evidence uploads go direct to storage via signed upload URLs (§9.1).
**Status:** Ready for implementation
**Owner:** Dr. Yassine, Manager of Institutional Effectiveness, AIU
**Date:** 5 October 2026
**Intended reader:** Claude Code and the engineers who review its output

---

## 0. How to use this document (read first)

This PRD is written to be handed directly to Claude Code. Treat it as the specification.

- **Build in the order of §18.** Each milestone has a "done when" test. Do not start a milestone until the previous one passes.
- **§6 is the data model.** Field names are suggestions; the relationships, enums and invariants (§6.9) are requirements.
- **Frameworks are data, never code.** If you find yourself writing `if (accreditor === 'ABET')`, stop. Put the difference in the framework configuration (§7).
- **Prefer the simple option.** Where this document is silent, pick the simplest thing that satisfies the acceptance tests. Do not add services, queues, rule engines, microservices or a graph database.
- **Fixtures in Appendix A are the test data.** WSCUC (institution-level), ABET EAC (program-level) and PUC Kuwait (institution-level, Arabic) must all run on the same code path.

---

## 1. Summary

The AMS is a configurable system for running accreditation work across many accreditors on one platform.

The core idea is a single loop that every accreditor uses, in different words:

```
Eligibility / Readiness → Self-Study → External Review → Decision → Maintenance & Continuous Improvement
        ↑                                                                               │
        └──────────────────────────── next cycle (reaffirmation) ───────────────────────┘

Inside every phase, each submission runs a tracked-response sub-cycle:

  Submit (round n) → Accreditor response → Triage items → Resolve → Reply / resubmit (round n+1) → Closed
```

Every submission — application, readiness report, self-study, due-process response, interim or annual report — can draw a reply from the accreditor: missing items, corrections, queries, draft findings, or plain confirmation. The AMS logs each reply, breaks it into **items**, assigns and resolves them, sends the reply, and closes the loop. Nothing the accreditor says is left in an inbox.

Every **engagement** (one accreditor × one subject — the institution or a program) gets a **roadmap** generated from that accreditor's configured lifecycle. The roadmap always produces a **self-study report**, then carries the engagement into **maintenance**: annual reports, follow-up reports on findings, substantive-change notices, improvement actions — until the next cycle starts.

Three rules hold everything together:

1. **Frameworks are configuration.** Standards, lifecycle steps, report templates and decision vocabularies are versioned data.
2. **Evidence belongs to the institution, not the engagement.** It is stored once and linked many times, each link with a reason.
3. **AI proposes, humans publish.** AI turns accreditor documents into draft configuration with page-level citations; nothing becomes authoritative until a person approves it.

---

## 2. Product principles (enforced, not aspirational)

| # | Principle | How it is enforced |
|---|---|---|
| P1 | One platform, many frameworks | No accreditor-specific code paths. Differences live in `framework_version` config |
| P2 | Every engagement has a roadmap that produces a self-study and continues into maintenance | Roadmap is generated on engagement creation; the self-study report is created by a lifecycle milestone; the engagement cannot be closed while maintenance milestones remain open |
| P3 | One evidence base | Evidence has no `engagement_id`. Engagements link to it |
| P4 | Official ≠ internal | Accreditor decisions are stored only in `accreditation_status`, entered by a person with the decision letter attached. Internal readiness lives elsewhere and never changes official status |
| P5 | Official vs suggested is always explicit | Every requirement note carries an `authority` value (§6.3). AI-originated content is visibly marked until approved |
| P6 | Provenance is data | Every published requirement points to a source document, page and verbatim quote |
| P7 | Version what matters | Framework versions and submission snapshots are immutable; evidence is versioned |
| P8 | No compliance-score theater | Dashboards show work status. Any framework-defined rating is shown only as an *internal self-assessment*, never as a predicted outcome |
| P9 | Nothing the accreditor says is lost | Every accreditor communication is logged as an `accreditor_response` with its document and split into `feedback_item`s; a phase cannot advance while a reply-required response in it is still open |

---

## 3. Scope

### 3.1 MVP (P0)

1. Organization: institution, org units, programs, users, scoped roles.
2. Framework library: create, import (JSON), edit, publish immutable versions — including lifecycle template, report templates and vocabularies.
3. Engagements with generated roadmaps (phases → milestones → deliverables, with computed due dates).
4. Requirement workspace: owner, status, notes, evidence links, comments.
5. Evidence repository with versions and reasoned links.
6. Reports: self-study, follow-up, annual and application reports built from templates; section approvals; attestation; immutable submission snapshot; DOCX/PDF export and evidence index.
7. **Tracked accreditor responses:** log each accreditor reply against the submission it answers; split into items (missing item, correction, query, finding, confirmation); assign, resolve, reply or resubmit as a new round; close. (§11)
8. Decisions & maintenance: official status record, decision findings (as response items), improvement actions, follow-up milestones, start-next-cycle.
9. Framework Compiler (AI): upload sources → extract → verify quotes → human review → publish.
10. Audit log on every change.
11. Arabic and English content, with right-to-left rendering for Arabic text.

### 3.2 P1 (after MVP)

- Assessment cycle: outcomes, measures, targets, results, improvement actions, follow-up (§13).
- Framework-defined self-rating (e.g. NBAQ 0–4 per quality indicator, PUC weighted indicators).
- Email notifications and digests.
- AI proposal of feedback items from an uploaded accreditor letter (with verified quotes).
- Framework revision comparison (diff between two versions).
- **Governed-metric adapter** for dataset evidence (Cube Core or any institutional BI/semantic layer) — §9.5.
- External reviewer workspace (time-limited, read-only).

### 3.3 P2 / later

AI narrative drafting, AI evidence suggestions, cross-framework crosswalks, SIS/LMS/BI integrations, analytics.

### 3.4 Out of scope — do not build

- Any judgement that a requirement is "met", or any prediction of the accreditor's decision.
- Automatic changes to a published framework version.
- A rule engine for applicability (simple tags only, §7.3).
- A KPI/metric registry or any metric computation. Metrics are defined and computed in the institutional data layer; the AMS consumes values through the dataset adapter (§9.5) and freezes them at submission.
- Per-accreditor portals or submission APIs. The AMS produces files; people upload them to the accreditor.

---

## 4. Users and roles

| Role | Typical person | Can |
|---|---|---|
| **Admin** | IE Manager | Everything, including framework publishing and user management |
| **Accreditation Lead** | ALO, IE staff, program accreditation coordinator | Create engagements in their scope; become Engagement Lead of the engagements they run |
| **Engagement Lead** | One named person per engagement — e.g. ALO for WSCUC/PUC, program coordinator for ABET | Within that engagement: manage members and their roles, edit the roadmap (§8.5), assign requirement and section owners, approve sections, log accreditor responses, record the decision, create the submission snapshot |
| **Co-lead** (optional) | Deputy | Same as Engagement Lead except recording the decision, approving the final snapshot and reassigning the lead |
| **Contributor** | Faculty, staff, unit heads | Work on assigned requirements and sections; upload evidence; propose links |
| **Reviewer** | Deans, committee members, framework SMEs | Review and approve/reject assigned items (evidence links, sections, extracted framework items) |
| **Viewer** | Leadership | Read within scope |
| **External Reviewer** (P1) | Visiting team member, consultant | Read-only access to one engagement's snapshot, expires on a date |

A role is granted at a **scope**: whole institution, one org unit (inherits to children), one program, or one engagement.

**Engagement leadership rules.** Every engagement has exactly one Engagement Lead at all times (required at creation). Only an Admin, or the current lead, can hand the role to someone else; the handover is audited and the outgoing lead becomes a member unless removed. The institution Admin can act as lead on any engagement. Engagement members are role assignments scoped to the engagement.

---

## 5. The accreditation lifecycle (core concept)

### 5.1 The universal model

Every accreditor examined (WSCUC, ABET, NBAQ, PUC, ACS WASC) follows the same five phases. The AMS hard-codes only these five phase **types**; each framework supplies its own names, milestones, deadlines and documents.

| Phase type | Purpose | Always produces |
|---|---|---|
| `eligibility` | Prove the subject is eligible and ready to be reviewed | Application / readiness documents (may be skipped for reaffirmation) |
| `self_study` | Examine the subject against the standards and write it up | **The self-study report** (mandatory in every lifecycle) |
| `review` | Accreditor examines the report, visits, asks questions | Visit logistics, responses to queries |
| `decision` | Respond to draft findings; receive the official decision | Official status record + findings |
| `maintenance` | Keep accreditation in good standing and improve | Annual reports, follow-up reports, change notices, improvement actions → triggers next cycle |

### 5.2 How the real accreditors map to it

Grounded in the uploaded source documents. Items marked *(confirm)* were not fully specified in the uploaded material.

| Phase | WSCUC (institution) | ABET EAC (program) | NBAQ Kuwait (institution) | PUC Kuwait (institution) |
|---|---|---|---|---|
| **Eligibility** | Inquiry → 30-min intro meeting → Alignment & Financial Review (fee, Notice of Intent, Programs & Locations form, Alignment Review Submission Form incl. 3-year enrollment, retention, graduation tables) → eligibility decision within 60 business days → Application for Accreditation (SAV1) | Readiness Review for first program in a commission: request Apr–15 Aug, report due 1 Sep, recommendation mid-Dec (submit / postpone / not to submit); ≥1 graduate within two academic years before the visit; Request for Evaluation by 31 Jan, CEO-signed, with transcript; Request for Acknowledgement for non-US institutions | Introductory meetings; training workshops; optional pre-accreditation audit; formal request to start with an agreed schedule | Self-study requested by PUC letter under the licensing decree (e.g. letter of 22 Jun 2022 to AIU) |
| **Self-study** | Self-study (review accreditation history; Compliance with Standards Worksheet) → Institutional Report: Section A, Section B (four Standard essays), Section C, Appendices I–III; 12,000–18,000 words; CEO letter affirming accuracy | Self-Study Report per Self-Study Questionnaire: Background, Criteria 1–8, Program Criteria, Appendices A–D, Tables 5-1, 6-1, 6-2, D-1, D-2; due 1 Jul; self-contained, no external links | Self-assessment report prepared within 12 months; final report approved by the top governing board before submission | Self-study per the "Item 11 – Institutional Evaluation Data" template: 14 sections ending with an attestation of accuracy |
| **Review** | Offsite Review → Accreditation Visit | Fee invoice (May); conflict-of-interest check on team; on-site visit Sep–Dec, ~3 days | Completeness check within 3 months (1 month to amend) → team desk review → visit within 3 months, 3–5 days | Committee review / visit *(confirm)* |
| **Decision** | Confidential team recommendation → Commission action; action letter within 30 days. Actions: reaffirm (6/8/10 yrs), defer, notice of concern, warning, probation, order to show cause, deny, withdraw | Draft Statement → 30-day due-process response → Final Statement by 31 Aug of following year. Findings: Deficiency, Weakness, Concern, Observation. Actions: NGR, IR, IV, SCR, SCV, RE, VE, SE, NA | Factual-error reply within 2 weeks; final team report within 6 weeks; Directing Council decision by score band (5 / 4 / 3 years, or withheld); focused re-evaluation; probation | Accredited / accredited with conditions / not accredited (2019 guide) |
| **Maintenance** | Annual Report (fall census enrollment, demographics, completions, financial indicators, audit upload; submitted by the ALO); progress/interim reports and special visits per action letter; comprehensive review at least every 10 years | Interim Report on prior shortcomings (IR/IV/SCR/SCV); SCR/SCV: summary to students and faculty within 60 days; report program changes during the accreditation period; next general review typically 6 years | Published annual analytical reports; in-compliance report after a focused re-evaluation; re-accreditation | Implementation plan against conditions; renewal before expiry *(confirm dates with PUC)* |

### 5.3 The response sub-cycle in the source documents

| Submission | Accreditor response | What the institution must do |
|---|---|---|
| ABET Readiness Review Report | Recommendation letter (submit / postpone / not to submit) with suggestions, mid-Dec | Notify ABET of its decision by mid-Jan; address suggestions in the SSR |
| ABET Self-Study Report + visit | Draft Statement: Deficiencies, Weaknesses, Concerns, Observations, plus statements of fact | 30-day due-process response (progress on shortcomings, corrections of fact); post-30-day information only with team-chair permission |
| ABET due-process response | Final Statement + action | Becomes the decision; open shortcomings carry into the interim report |
| NBAQ final self-assessment report | Completeness review within 3 months: missing information/documentation, format, consistency with standards | Amend and resubmit within one month |
| NBAQ self-assessment report | Evaluation team's written observations, remarks and queries | Respond before the site visit |
| NBAQ site visit | Draft evaluation report | Correct factual errors and omissions within two weeks |
| NBAQ deferral (focused re-evaluation) | Report of grounds for deferment | Evidence-based focused "in-compliance" report |
| WSCUC Institutional Report + visit | Team report | Optional institution response before Commission action |
| WSCUC Commission action | Action letter with requirements/recommendations | Progress / interim reports, special visits per letter |
| WSCUC eligibility materials, Annual Report, PUC self-study | Requests for information / queries *(confirm)* | Reply within the stated window |

### 5.4 What this means for the product

- The **lifecycle template** (§7.4) is per framework version. It lists phases, milestones and deliverables with due-date rules.
- The **decision vocabulary** (§7.5) lists the accreditor's possible actions. Each action can carry a term length and **follow-up milestones** (e.g. ABET `IR` → Interim Report due 1 July two years later). Recording a decision generates the maintenance roadmap automatically.
- The **finding vocabulary** lists severity labels (ABET: Deficiency / Weakness / Concern / Observation; WSCUC: recommendation / commendation; etc.).
- The **response vocabulary** (§7.5) lists the kinds of reply each accreditor sends after a submission, whether the institution must answer, and the reply window (e.g. ABET Draft Statement → 30 days; NBAQ completeness review → one month; NBAQ draft evaluation report → two weeks). Logging a response creates its reply milestone automatically (§11).
- **Report templates** are separate from the standards tree. PUC's 14-section self-study does not follow its 7 standards one-to-one; WSCUC's essays cite CFRs rather than answering each. Sections link to requirements many-to-many.

---

## 6. Data model

PostgreSQL. Every table has `id uuid pk`, `institution_id uuid` (tenant key, RLS), `created_at`, `created_by`, `updated_at`, `updated_by` unless noted.

### 6.1 Organization & access

| Table | Key fields | Notes |
|---|---|---|
| `institution` | name_en, name_ar, country, default_locale | One per tenant in MVP; schema supports many |
| `org_unit` | parent_id, type (`college`, `school`, `department`, `admin_unit`, `other`), name_en, name_ar, active | Tree |
| `program` | org_unit_id, name_en, name_ar, degree_level (`associate`, `bachelor`, `master`, `doctorate`, `diploma`, `certificate`), discipline, tags text[], active | Tags drive applicability (e.g. `mechanical`, `computing`) |
| `app_user` | auth_user_id, full_name, email, locale, active | Managed by the auth library (§18.1); identity from the institution's SSO |
| `role_assignment` | user_id, role (`admin`, `lead`, `engagement_lead`, `co_lead`, `contributor`, `reviewer`, `viewer`, `external_reviewer`), scope_type (`institution`, `org_unit`, `program`, `engagement`), scope_id, expires_at | `expires_at` required for `external_reviewer`. `engagement_lead` / `co_lead` only with scope_type `engagement` |

### 6.2 Framework library

| Table | Key fields | Notes |
|---|---|---|
| `accreditor` | name, short_name, type (`institutional`, `programmatic`, `regulatory`), country, website | WSCUC, ABET, NBAQ, PUC |
| `framework` | accreditor_id, name, commission (e.g. `EAC`), scope (`institution`, `program`, `both`), description | e.g. "ABET EAC Criteria for Accrediting Engineering Programs" |
| `framework_version` | framework_id, edition (e.g. `2023`, `2027-28`), effective_from, effective_to, status (`draft`, `in_review`, `published`, `retired`), level_labels jsonb, lifecycle_template jsonb, decision_vocab jsonb, finding_vocab jsonb, response_vocab jsonb, rating_method jsonb null, change_summary, published_by, published_at, supersedes_id | Config lives here (§7) |
| `source_document` | framework_version_id, title, role (`standards`, `policy_procedure`, `guidance`, `report_template`, `evidence_guidance`, `amendment`, `sample_report`, `correspondence`, `other`), authority (`binding`, `interpretive`, `informational`), language, file_path, sha256, page_count, text_status (`pending`, `extracted`, `ocr_needed`, `ocr_done`, `failed`) | `sample_report` can never produce requirements |
| `source_page` | source_document_id, page_no, text, method (`pdf_text`, `ocr`), reviewed bool | Basis for quote verification |
| `requirement` | framework_version_id, parent_id, code (accreditor's code, e.g. `CFR 2.4`, `3-1-2`), level_label (e.g. "Standard", "CFR", "Indicator"), title, official_text, language, translation_en null, is_assessable bool, applies_when jsonb, display_order, weight numeric null, **provenance fields** | Internal `id` is stable; `code` may change between editions |
| `requirement_note` | requirement_id, type (`guidance`, `evidence_expectation`, `data_request`, `quantitative_norm`), text, **authority** (`required`, `example`, `suggested`, `ai_suggested`, `institution_defined`), norm jsonb null, **provenance fields** | §6.3 |
| `report_template` | framework_version_id, key, name, kind (`application`, `readiness`, `self_study`, `follow_up`, `annual`, `response`, `other`), language, structure jsonb, word_limit null, requires_attestation bool, **provenance fields** | Structure defined in §10.2 |

**Provenance fields** (on `requirement`, `requirement_note`, `report_template`):
`origin` (`manual`, `import`, `ai`), `source_document_id`, `source_page`, `source_quote`, `quote_verified` bool, `review_status` (`pending`, `approved`, `rejected`), `reviewed_by`, `reviewed_at`.

### 6.3 Authority classification (non-negotiable)

Every `requirement_note` carries one authority value, shown as a coloured badge in every view:

| Authority | Meaning | Example |
|---|---|---|
| `required` | The accreditor explicitly requires it | WSCUC: "institutions are required to complete the Compliance with WSCUC Standards Worksheet" |
| `example` | The accreditor gives it as an illustration | NBAQ "C. Indicators of Effective Performance: Examples" |
| `suggested` | The accreditor suggests it | NBAQ "D. Suggested Documentation Illustrating Compliance" |
| `ai_suggested` | The AI inferred it; no source sentence requires it | — |
| `institution_defined` | The institution chose to add it | "Attach the IE committee minutes" |

Rules: `required` must have a verified source quote. AI may output only `required`, `example`, `suggested` (each with a quote) or `ai_suggested`. Only a human can set `institution_defined`, or promote `ai_suggested` to anything else.

### 6.4 Engagements & roadmap

| Table | Key fields | Notes |
|---|---|---|
| `engagement` | framework_version_id, subject_type (`institution`, `program`), subject_id, kind (`initial`, `reaffirmation`), title, review_year int, key_dates jsonb (`submission_date`, `visit_date`, `decision_date`, `expiry_date`, …), current_phase, status (`active`, `closed`, `withdrawn`), lead_user_id (**not null**, mirrors the `engagement_lead` assignment), previous_engagement_id, template_synced_version_id | e.g. "ABET EAC 2027 — BS Mechanical Engineering" |
| `milestone` | engagement_id, template_key, phase (`eligibility`, `self_study`, `review`, `decision`, `maintenance`), name, description, type (`task`, `deliverable`, `submission`, `external_event`, `decision_point`), due_date null, due_rule jsonb, date_needed bool, owner_id, status (`not_started`, `in_progress`, `done`, `skipped`, `overdue`*), completed_at, report_id null, source_ref jsonb, recurrence jsonb null, order, **origin** (`template`, `modified`, `local`, `decision`, `response`), **locked** bool, required bool, skip_reason | *`overdue` is computed, not stored. `locked` = cannot be deleted (§8.5) |
| `engagement_requirement` | engagement_id, requirement_id, applicable bool, na_reason, owner_id, reviewer_id, status (`not_started`, `in_progress`, `ready_for_review`, `approved`, `needs_work`), working_notes (rich text), self_rating null (P1), due_date | Instantiated from the framework (§8.3) |

### 6.5 Evidence

| Table | Key fields | Notes |
|---|---|---|
| `evidence_item` | title, description, type (`document`, `dataset`, `url`, `minutes`, `policy`, `report`, `other`), owner_unit_id, owner_user_id, period_label (e.g. `AY2025-26`), confidentiality (`public`, `internal`, `restricted`), contains_student_data bool, tags text[], status (`active`, `archived`) | No engagement FK |
| `evidence_version` | evidence_item_id, version_no, file_path or url, sha256, file_name, mime, size, as_of_date, notes, **data jsonb null** (dataset rows), **lineage jsonb null** (`source_kind`, `definition_version`, `steward`, `external_snapshot_id`, `query`, `fetched_at`, `supplied_by`) | New upload or refresh → new version; old versions retained |
| `dataset_spec` | evidence_item_id (type `dataset`), definition (plain-language), columns jsonb (`key`, `label`, `type`, `unit`), grain (e.g. "programme × academic year"), periods jsonb, **source_kind** (`manual_upload`, `governed_metric`), source_config jsonb (query for the adapter, or the upload template), data_owner_id, refresh (`manual`, `on_open`, `scheduled`) | One per dataset item. Switching `source_kind` does not change any report that uses the dataset (§9.6) |
| `evidence_link` | evidence_version_id, engagement_requirement_id, **rationale (required)**, linked_by, review_status (`proposed`, `approved`, `rejected`), reviewed_by, reviewed_at, review_comment | One evidence item → many links |

### 6.6 Reports & submissions

| Table | Key fields | Notes |
|---|---|---|
| `report` | engagement_id, report_template_id, template_snapshot jsonb, kind, title, language, status (`drafting`, `in_review`, `approved`, `submitted`, `superseded`), round_no (default 1), revises_report_id null, responds_to_response_id null, due_date, submitted_at, submitted_by | Template copied at creation. A corrected resubmission is a new `report` row (round n+1) with `revises_report_id`; a reply is a report with `responds_to_response_id` |
| `report_section` | report_id, section_key, parent_key, title, order, block_type (§10.3), prompt, linked_requirement_ids uuid[], content jsonb (rich text or table rows), dataset_binding jsonb null (`evidence_item_id`, column map, filter), owner_id, approver_id, status (`not_started`, `drafting`, `in_review`, `approved`, `needs_work`), word_count, ai_assisted bool | |
| `attestation` | report_id, signatory_name, signatory_title, statement, signed_file_path, signed_at | Required when the template says so |
| `submission_snapshot` | report_id, round_no, created_at, created_by, submitted_at, submitted_by, accreditor_ref (confirmation/receipt number), manifest jsonb, export_files jsonb, sha256 | **Immutable.** Manifest holds section content, requirement ids + text, evidence version ids + hashes, approvals, attestation |

### 6.7 Accreditor responses, decisions & improvement

| Table | Key fields | Notes |
|---|---|---|
| `accreditation_status` | subject_type, subject_id, framework_id, engagement_id, decision_code (from `decision_vocab`), status_label, effective_date, expiry_date null, term_years null, conditions text, decision_document_path (**required**), recorded_by | Append-only history. Current status = latest row. This is the **only** place official status lives |
| `accreditor_response` | engagement_id, submission_snapshot_id null (what it answers), response_type (code from `response_vocab`), round_no, received_on, document_path (**required**), summary, reply_required bool, reply_due_date null, reply_milestone_id null, reply_report_id null, status (`received`, `triage`, `in_progress`, `replied`, `closed`), closed_on, closed_reason (`accepted`, `no_reply_needed`, `superseded`, `decision_issued`, `other`), closed_note | One row per letter/email/statement. Decision letters are responses whose vocab entry has `is_decision: true` |
| `feedback_item` | accreditor_response_id, engagement_id, ref (accreditor's own numbering), category (`missing_item`, `correction`, `query`, `finding`, `recommendation`, `confirmation`, `other`), severity null (from `finding_vocab`, findings only), text (verbatim), requirement_ids uuid[], report_section_keys text[], owner_id, due_date, status (`open`, `in_progress`, `resolved`, `closed`, `reopened`, `no_action`), resolution_type (`report_corrected`, `evidence_added`, `clarification_given`, `action_planned`, `disagreed_with_reason`, `none_needed`), resolution_text, evidence_version_ids uuid[], carried_from_item_id null, origin (`manual`, `ai`) | Replaces a separate findings table: accreditor findings are items of category `finding`. `carried_from_item_id` chains an item across rounds and cycles |
| `action` | source_type (`feedback_item`, `assessment_result`, `gap`), source_id, title, description, owner_id, due_date, status (`planned`, `in_progress`, `done`, `cancelled`), completed_at, effectiveness_note, evidence_item_ids uuid[] | One action table for accreditor items **and** assessment (§13) |

### 6.8 Shared

| Table | Key fields |
|---|---|
| `comment` | target_type, target_id, body, author_id, resolved bool |
| `audit_event` | actor_id, actor_type (`user`, `system`, `ai`), action, target_type, target_id, before jsonb, after jsonb, at — append-only |
| `job` | type (`extract_text`, `ocr`, `ai_extract`, `export`, `notify`), payload jsonb, status, attempts, error, result jsonb |
| `extraction_item` | framework_version_id, job_id, kind (`requirement`, `note`, `report_section`, `milestone`, `decision`, `finding_severity`, `response_type`, `metadata`), payload jsonb, source_document_id, source_page, source_quote, quote_verified bool, confidence, flags text[], status (`pending`, `accepted`, `edited`, `rejected`), reviewed_by |

### 6.9 Invariants (enforce in the database or a single service layer)

1. **Published is frozen.** Rows belonging to a `framework_version` with status `published` or `retired` cannot be updated or deleted (trigger). Changes require a new version.
2. **Publish gate.** A version cannot be published while any `requirement` or `requirement_note` is `review_status != approved`, any `required` note lacks `quote_verified = true`, or any `origin = ai` item lacks a source reference.
3. **Sample reports never create requirements.** Extraction items sourced from `role = sample_report` documents cannot be accepted as `requirement` or `required` notes.
4. **Evidence links need a reason.** `evidence_link.rationale` is not null and at least 15 characters.
5. **Snapshots are immutable.** No update/delete on `submission_snapshot`. A snapshot can only be created when every section is `approved` and, if required, the attestation exists.
6. **Official status needs a document.** `accreditation_status.decision_document_path` is not null. No code path sets official status automatically.
7. **AI cannot approve.** The AI/worker database role can insert into `extraction_item` and write `ai_assisted` drafts; it cannot write any `review_status`, `status = approved`, approval or `accreditation_status` row.
8. **Everything is audited.** Trigger writes `audit_event` on insert/update/delete of all domain tables.
9. **Engagements end in maintenance.** An engagement cannot be `closed` unless it has a recorded decision and every non-recurring maintenance milestone is `done` or `skipped` and no feedback item is `open` or `in_progress` (open items are carried to the next cycle instead) — or it is `withdrawn` with a reason.
10. **Every accreditor response is accounted for.** `accreditor_response.document_path` is required. A reply report cannot be approved while any of its response's items (other than `confirmation`) is `open` or `in_progress`; `no_action` needs a resolution text. A response cannot be `closed` while it has `open` items unless closed as `superseded` with a note.
11. **Corrections never edit a submission.** A submitted report and its snapshot are frozen; corrections create a revision report (round n+1). The previous report becomes `superseded`.
12. **Roadmap guardrails.** Milestones with `locked = true` (the self-study deliverable, every `decision_point`, every reply milestone created by a response) cannot be deleted. Required milestones can only be `skipped` with `skip_reason`. Phase types cannot be added or removed per engagement.
13. **One lead.** Every active engagement has exactly one `engagement_lead` assignment, and `engagement.lead_user_id` matches it.
14. **Numbers are frozen at submission.** A snapshot stores the dataset version ids **and** the values used in every bound table; later refreshes never change a submitted report.

---

## 7. Framework configuration

A framework version is the full description of one accreditor's expectations for one edition. Everything accreditor-specific lives here.

### 7.1 Requirement tree

- Arbitrary depth via `parent_id`. `level_labels` names the levels for display, e.g. WSCUC `["Standard", "CFR"]`, PUC `["Standard", "Measure", "Indicator"]` (معيار / مقياس / مؤشر), NBAQ `["Standard", "Quality Indicator"]`.
- `is_assessable = false` for pure headings (e.g. WSCUC "Institutional Purposes").
- `official_text` is verbatim from the source. Explanations go in notes, never in `official_text`.
- `weight` is optional and used only by the P1 self-rating (e.g. NBAQ standard weights).

### 7.2 Notes

Guidance, evidence expectations, data requests (e.g. WSCUC "fall-to-fall retention for the most recent three years") and quantitative norms (e.g. PUC indicator norms such as administrative staff ratios or maximum class sizes) attach to requirements as `requirement_note`, each with an authority value (§6.3).

### 7.3 Applicability (simple tags, no rule engine)

`requirement.applies_when` is an object of tag lists. A requirement applies when, for every key present, the subject matches at least one value:

```json
{ "scope": ["program"], "degree_level": ["bachelor"], "program_tags": ["mechanical"] }
```

Supported keys: `scope`, `degree_level`, `program_tags`, `engagement_kind`. Empty or null = always applies. A lead can override applicability per engagement with a reason (`engagement_requirement.applicable`, `na_reason`).

### 7.4 Lifecycle template

Stored in `framework_version.lifecycle_template`:

```json
{
  "phases": [
    { "type": "eligibility", "name": "Readiness Review & RFE", "applies_to": ["initial"],
      "milestones": [
        { "key": "rrev_request", "name": "Submit Request for Readiness Review",
          "type": "submission", "due": { "fixed": "08-15", "year_offset": -1 },
          "source_ref": { "doc": "Readiness Review Information", "page": 1 } }
      ] },
    { "type": "self_study", "name": "Self-Study Report", "applies_to": ["initial", "reaffirmation"],
      "milestones": [
        { "key": "ssr_submit", "name": "Submit Self-Study Report", "type": "submission",
          "deliverable": { "report_template_key": "ssr" },
          "due": { "fixed": "07-01", "year_offset": 0 } }
      ] }
  ],
  "next_cycle": { "start_offset_days_before_expiry": 730 }
}
```

**Milestone fields:** `key`, `name`, `description`, `type`, `deliverable.report_template_key` (optional), `due` (rule), `recurrence` (optional), `applies_to` (engagement kinds), `required` (default true), `source_ref`.

**Due-rule forms** (pick one per milestone):

| Form | Meaning |
|---|---|
| `{ "fixed": "MM-DD", "year_offset": n }` | That date in `review_year + n` |
| `{ "anchor": "<key_date>", "offset_days": n }` | Relative to an engagement key date (`submission_date`, `visit_date`, `decision_date`, `expiry_date`) |
| `{ "after": "<milestone_key>", "offset_days": n }` | Relative to another milestone's completion date |
| `null` | Set manually |

If a rule cannot be resolved (e.g. visit date unknown), `due_date` is null and `date_needed = true`; it resolves automatically when the anchor is entered.

**Recurrence** (maintenance only): `{ "every": "year", "month_day": "MM-DD" }` — the system keeps the next two occurrences materialized.

**The lifecycle must contain exactly one milestone with `deliverable.report_template_key` pointing at a `self_study` template.** Publishing is blocked otherwise.

### 7.5 Decision, finding and response vocabularies

```json
"decision_vocab": [
  { "code": "NGR", "label": "Next General Review", "outcome": "accredited", "term_years": 6,
    "follow_up": [ { "milestone_key": "next_rfe", "name": "Submit RFE for next general review",
                     "due": { "fixed": "01-31", "year_offset": 6 } } ] },
  { "code": "IR", "label": "Interim Report", "outcome": "accredited", "term_years": 2,
    "follow_up": [ { "milestone_key": "interim_report", "name": "Submit Interim Report",
                     "type": "submission", "deliverable": { "report_template_key": "interim" },
                     "due": { "fixed": "07-01", "year_offset": 2 } } ] },
  { "code": "NA", "label": "Not to Accredit", "outcome": "not_accredited" }
],
"finding_vocab": [
  { "code": "deficiency", "label": "Deficiency", "requires_action": true },
  { "code": "weakness",   "label": "Weakness",   "requires_action": true },
  { "code": "concern",    "label": "Concern",    "requires_action": true },
  { "code": "observation","label": "Observation","requires_action": false }
]
```

```json
"response_vocab": [
  { "code": "rev_recommendation", "label": "Readiness Review recommendation", "reply_required": true,
    "reply_due": { "fixed": "01-15", "year_offset": 0 }, "reply_kind": "letter",
    "item_categories": ["recommendation"] },
  { "code": "draft_statement", "label": "Draft Statement", "reply_required": true,
    "reply_window_days": 30, "reply_kind": "report", "reply_template_key": "due_process",
    "item_categories": ["finding", "correction"] },
  { "code": "final_statement", "label": "Final Statement", "reply_required": false, "is_decision": true }
]
```

`reply_kind` is `report` (reply built from `reply_template_key`), `revision` (resubmit a corrected version of the answered report), `report_and_revision`, `letter` (upload a signed letter, no template) or `none`. The reply due date is `received_on + reply_window_days`, or a `reply_due` rule (§7.4 forms), or entered manually.

`outcome` is one of: `eligible`, `candidate`, `accredited`, `accredited_with_conditions`, `deferred`, `sanctioned`, `not_accredited`, `withdrawn`. Year offsets in `follow_up` use the same rule as every other `fixed` due rule: relative to the engagement's `review_year`.

### 7.6 Rating method (P1, optional)

```json
{ "scale": [0,1,2,3,4], "labels": ["Not in compliance","Inadequate","Minimal","Marked","Substantial"],
  "rated_level": "Quality Indicator", "aggregate": "weighted_by_standard" }
```

Used only for **internal** self-rating. Always labelled "Internal self-assessment using <framework>'s rating method — not an accreditor determination."

### 7.7 Framework import/export

Every framework version can be exported to and imported from one JSON file containing all of §7.1–7.6 plus report templates. This is how fixtures (Appendix A) are loaded and how frameworks can later be shared between institutions.

---

## 8. Engagements and the roadmap

### 8.1 Create engagement (wizard, one screen)

Inputs: subject (institution or program), framework version (published only), kind (`initial` / `reaffirmation`), review year, known key dates, lead.

On save, the system in one transaction:

1. Instantiates `engagement_requirement` rows for every applicable assessable requirement (§8.3).
2. Generates milestones from the lifecycle template for phases whose `applies_to` includes the kind.
3. Computes due dates; flags `date_needed` where anchors are missing.
4. Creates the **self-study `report`** from the referenced template, with sections pre-linked to requirements (§10).
5. Sets `current_phase` to the first generated phase.
6. If `previous_engagement_id` is set: offers to copy evidence links (matched by requirement `code`; copied as `proposed` for re-review) and carries forward open feedback items (as new items with `carried_from_item_id`) and their actions.

### 8.2 Roadmap view

- A timeline grouped by the five phases, showing milestones, owners, due dates, status and linked reports.
- Phase progress = completed required milestones ÷ required milestones.
- **Advance phase** is a manual button, enabled when all required milestones in the current phase are `done` or `skipped` (skips need a reason).
- The Engagement Lead edits the roadmap within the rules of §8.5. Edits are audited; the framework template is untouched.
- Calendar export (ICS) of all milestones.

### 8.3 Requirement instantiation

For each `requirement` where `is_assessable = true` and `applies_when` matches the subject (§7.3) → create `engagement_requirement` with `applicable = true`. Non-matching requirements are created with `applicable = false` so they are visible and can be switched on with a reason.

### 8.4 Requirement workspace

One page per `engagement_requirement`:

- **Context:** code, title, official text (original language, RTL if Arabic) with translation toggle, parent path, notes grouped by type with authority badges, source link (opens the PDF at the page).
- **Work:** owner, reviewer, due date, status, working notes, linked evidence with rationale and review status, comments.
- **Reporting:** which report sections cite this requirement.
- **History:** audit trail.

Status changes: contributor → `ready_for_review`; reviewer → `approved` or `needs_work`. `approved` means "internally ready", nothing more. The UI label is **"Internally approved"**.

---

### 8.5 Editing the roadmap at engagement level

The framework's lifecycle is the **master template**; each engagement holds its own **editable copy**.

| The Engagement Lead (or co-lead) can | The system prevents |
|---|---|
| Rename a milestone, change its description, owner or due date (origin → `modified`) | Deleting a `locked` milestone: the self-study deliverable, decision points, response reply milestones |
| Add local milestones in any phase, e.g. steering committee, board approval, mock visit (origin → `local`) | Skipping a `required` milestone without a reason |
| Reorder milestones within a phase; move a local milestone between phases | Adding or removing phase types |
| Skip optional milestones; un-skip anything | Changing which report template the self-study milestone produces (use a new engagement or a new framework version) |
| Attach a different report template to a local deliverable milestone | — |

**Origin badges** on every milestone — *from template*, *modified*, *added locally*, *from decision*, *from response* — let anyone see which steps the accreditor requires and which the institution chose.

**Template updates.** When a newer framework version is published, running engagements are **not** changed. The roadmap shows "Template updated — review changes": a list of added, removed and re-dated milestones that the lead accepts or ignores item by item. `template_synced_version_id` records the version last reviewed. Modified and local milestones are never overwritten.

## 9. Evidence

### 9.1 Repository

- Upload file or register a URL; title, description, owner unit, period, confidentiality, tags, `contains_student_data`.
- Uploads go **directly from the browser to object storage** through a short-lived signed upload URL issued by the API after the permission check; the API then confirms the upload (size, MIME, SHA-256) before the `evidence_version` row is written. Large files never pass through the API process.
- Versions: re-upload creates `version_no + 1`. Links point to a specific version; the UI shows "newer version available" on links to old versions.
- Preview PDF and images in-browser; others download.
- Search by title, tags, period, owner, linked requirement code.
- Restricted items are visible only to users with scope over the owner unit, plus users explicitly granted.

### 9.2 Linking

From the requirement workspace or the evidence page: choose evidence version → write rationale (required) → link is `proposed` → reviewer approves/rejects with comment. One item can link to any number of requirements across engagements.

### 9.3 Freshness (simple)

Flag a link as **stale** when the evidence `period_label` is older than the engagement's review year minus a configurable number of years (default 3). No AI.

### 9.4 Two kinds of evidence

| Kind | Examples | How it gets in |
|---|---|---|
| **Documents** | Policies, minutes, syllabi, CVs, audited statements, strategic plan | Upload, or register a link (e.g. SharePoint). Versioned (§9.1) |
| **Datasets** | Enrollment by level, fall-to-fall retention, 6-year graduation, completions, faculty by rank and qualification, student–faculty ratios, financial indicators, outcome attainment | A `dataset` evidence item with a `dataset_spec`: definition, columns, grain, periods, data owner, and a **source** (§9.5–9.6) |

Datasets are entered or fetched **once** and reused everywhere: report `data_table` blocks bind to a dataset (`dataset_binding`) instead of holding their own numbers, and the same retention dataset fills the WSCUC Alignment Review table, the WSCUC institutional report, ABET Table D-1 and the PUC programs tables. This is what prevents three different retention figures going to three accreditors.

A `quantitative_norm` note (e.g. a PUC ratio) can reference a dataset column; the workspace shows **value next to norm**, never "met / not met".

### 9.5 With an institutional data/BI layer (governed metrics)

In the IE data architecture (source systems → warehouse → governed semantic layer, e.g. Cube Core → consumers), the AMS is a **consumer** for metrics and the **owner** of documents, evidence links and accreditation workflow. Metric definitions and computation stay in the governed layer; evidence files and accreditation records do not go there.

Integration is one adapter interface in `/modules/evidence/sources`:

```ts
interface DatasetSource {
  kind: 'manual_upload' | 'governed_metric'
  fetch(spec: DatasetSpec, period: PeriodRange): Promise<{
    rows: Record<string, unknown>[]
    as_of: string
    lineage: { definition_version?: string; steward?: string;
               external_snapshot_id?: string; query?: unknown; supplied_by?: string }
  }>
}
```

`governed_metric` implementation (P1):

- `source_config` holds a **structured query** (Cube JSON query: measures, dimensions, time dimension, filters) — never SQL.
- The AMS calls the governed layer's API with a **service identity** whose security context allows only aggregated, small-number-suppressed measures; suppressed cells arrive as `null` with a flag and render as "suppressed (n<5)".
- Each fetch writes a new `evidence_version` with rows, `as_of`, definition version, steward and — when the governed layer has certified the figure — its `external_snapshot_id`.
- Refresh is manual, on opening the report, or scheduled; a refresh never touches a submitted snapshot (invariant 14).
- Optional reverse direction: read-only SQL views over AMS operational data (milestones, readiness counts, open accreditor items) that the BI tool can display. No write-back from BI.

### 9.6 Without an integration (MVP default)

The AMS works fully on its own. `manual_upload` is the MVP source:

1. The lead creates a dataset item from a `data_request` note or a report table; the system generates an **XLSX/CSV template** from `dataset_spec.columns`.
2. A **data request task** goes to the data owner (IR, Registrar, Finance) with the definition, periods and due date.
3. The owner uploads the filled template; it is validated against the column types; it becomes a new evidence version with `supplied_by` and `as_of`.
4. Bound report tables fill automatically; the evidence index lists the dataset like any other evidence.

What is lost without the integration: automatic refresh, and lineage beyond "supplied by X on date Y, definition as stated". What is kept: one figure per definition reused across all reports, versioned history, and frozen values at submission.

**Switching later** is a configuration change: set `source_kind = governed_metric` and a query on the existing dataset item. Bound reports, links and history are untouched because they point at the dataset item, not at its source.

---

## 10. Reports

### 10.1 Report kinds

All reports — eligibility applications, readiness reports, the self-study, interim/follow-up reports, annual reports, due-process responses — are the same object built from a `report_template`. The self-study is simply the one with `kind = self_study` that the lifecycle requires.

### 10.2 Template structure (`report_template.structure`)

```json
{
  "sections": [
    { "key": "A", "title": "Introduction: Institutional Context", "block_type": "narrative",
      "prompt": "Describe the institution, significant changes since last review, and response to previous Commission actions.",
      "requirement_codes": ["CFR 1.1", "CFR 1.8"], "word_limit": null,
      "children": [] },
    { "key": "T5-1", "title": "Table 5-1 Curriculum", "block_type": "data_table",
      "columns": [ {"key":"course","label":"Course (Dept, Number, Title)","type":"text"},
                   {"key":"req","label":"R / E / SE","type":"enum","options":["R","E","SE"]} ] },
    { "key": "APP-I", "title": "Compliance with WSCUC Standards Worksheet", "block_type": "compliance_matrix" },
    { "key": "ATT", "title": "Letter from the President affirming accuracy", "block_type": "attestation" }
  ]
}
```

`requirement_codes` resolve to requirement ids when the report is created.

### 10.3 Block types (only these seven)

| Block | Behaviour |
|---|---|
| `narrative` | Rich-text editor (Tiptap). Shows the prompt, linked requirements and their approved evidence in a side panel. Evidence can be cited inline as `[E-12]`, resolved to the evidence index |
| `data_table` | Grid with the template's columns. Either **bound to a dataset** (`dataset_binding`: rows come from the dataset's current version, read-only in the report, "refresh" button) or entered manually / pasted / CSV-imported for one-off tables |
| `compliance_matrix` | **Generated.** One row per applicable requirement: code, title, status, approved evidence titles. Replaces WSCUC's worksheet / any "standard-by-standard evidence" table |
| `evidence_index` | **Generated.** Every evidence version cited anywhere in the report, numbered, with title, version, date, and requirement codes |
| `feedback_response` | **Generated + narrative.** One row per feedback item in scope — the items of the response being answered, or all open `finding` items for a follow-up report, or the previous cycle's items for a "response to previous actions" section: ref, category/severity, accreditor text (verbatim), institution's resolution, actions, evidence; plus a narrative per item. Used by due-process responses, NBAQ replies, ABET Interim Reports, WSCUC progress reports and WSCUC Section A |
| `attestation` | Signatory, statement, uploaded signed letter |
| `appendix` | List of attached files (e.g. syllabi, CVs) drawn from evidence items |

### 10.4 Workflow

1. Sections inherit owners from the template's linked requirements' owners (editable).
2. Owner drafts → `in_review` → approver approves or returns.
3. Report status becomes `approved` when all sections are approved and attestation (if required) is present.
4. **Create submission snapshot** → immutable manifest and exported files.
5. **Mark submitted** (date, by whom, accreditor reference) — this completes the linked `submission` milestone The submission then shows "Awaiting accreditor response" until a response is logged or the lead marks "No response expected".
6. When the accreditor replies, the tracked-response sub-cycle starts (§11).

### 10.5 Export

- **DOCX** and **PDF** of the full report in template order, with generated blocks rendered, RTL handled for Arabic reports.
- **Evidence index** as XLSX.
- **Self-contained package** option: ZIP containing the PDF plus all cited evidence files, internal links only (ABET requires self-contained uploads with no external links).
- Word-count per section and total, warning when a template `word_limit` is exceeded (e.g. WSCUC 12,000–18,000 words).

---

## 11. Submissions and the tracked-response sub-cycle

### 11.1 The sub-cycle

```
SUBMIT (snapshot, round n) ─► awaiting response
        │
RECEIVE  log the accreditor's letter/statement/email → accreditor_response (type, date, document)
        │   reply due date computed → "Reply to <type>" milestone created in the current phase
TRIAGE   split into feedback_items (verbatim), classify, link to requirements / report sections,
        │   assign owner + due date; confirmations recorded and closed immediately
RESOLVE  per item: correct the report, add evidence, answer the query, plan an action, or disagree with reasons
        │
REPLY    build the reply (response report, revised report round n+1, signed letter) → approve → snapshot → submit
        │
CLOSE    accreditor accepts / issues the next step → response closed
         items not accepted → reopened and carried into the next response (round n+1)
```

The same sub-cycle applies to every submission kind and every phase. A decision letter is simply a response whose type is flagged `is_decision` (§12.1).

### 11.2 Receive

The lead clicks **Log accreditor response** from the engagement, the submission, or the roadmap:

1. Upload the document (required) — letter, email export, draft statement, team report.
2. Pick the response type from the framework's `response_vocab` (or `other`), the submission it answers, and the received date.
3. The system computes `reply_due_date`, creates the reply milestone (type `submission`, owner = lead, deliverable = reply template if any), and sets the response to `triage`.
4. If `reply_required = false` (acknowledgement, confirmation of receipt), the lead can close it in one step — it is still logged.

### 11.3 Triage

- Items are entered manually (paste the accreditor's text verbatim) or, in P1, proposed by AI from the uploaded letter with page and quote, verified like Compiler items (§15.1 step 5).
- For each item: category, accreditor ref, linked requirement codes and/or report sections, owner, due date (defaults to reply due date − 5 days).
- `confirmation` items are closed at once — they document what the accreditor accepted.
- Items with category `finding` take a severity from `finding_vocab`; those with `requires_action` need at least one `action` before the item can be `resolved`.

### 11.4 Resolve

Each item records how it was resolved (`resolution_type`) and the text and evidence that show it:

| Item category | Typical resolution |
|---|---|
| `missing_item` | Evidence added (new evidence version linked) and/or report corrected |
| `correction` | Report corrected in the revision, or explained (`disagreed_with_reason`) |
| `query` | Clarification given in the reply |
| `finding` / `recommendation` | Action planned or completed, with evidence; narrative in the reply |

**Revising a submitted report.** "Revise report" creates round n+1: a copy of the report with every section `approved` except those named in the response's items, which reopen as `needs_work`. The reopened sections show the linked items in their side panel. On snapshot, the system stores a section-level diff against the previous round and can export it as a "Summary of changes" appendix.

### 11.5 Reply and close

- Reply forms come from `reply_kind`: a response report (template with a `feedback_response` block), a revised report, both, or a signed letter.
- Reply follows the normal report workflow (§10.4): approve → snapshot → mark submitted → reply milestone `done` → response `replied`.
- When the accreditor accepts, or moves to the next step, the lead closes the response with a reason. If the accreditor does not accept an item, the lead logs the new response and marks the old item `reopened`; it is carried into the new response as a new item linked by `carried_from_item_id`, so its whole history reads as one chain.
- **Phase gate:** "Advance phase" is disabled while any reply-required response logged in the current phase is not `replied` or `closed`.

### 11.6 Views

- **Response register** (per engagement): every response by round — type, received, reply due, items open/total, status, linked submission and reply.
- **Item tracker**: all feedback items, filterable by owner, category, severity, requirement, status, overdue.
- **Requirement workspace** gains an "Accreditor feedback" panel: every item that ever touched the requirement, across rounds and cycles. This is what the next self-study's "response to previous actions" section is built from.
- **My items**: each contributor's open items with due dates.

## 12. Decisions, maintenance and continuous improvement

### 12.1 Recording a decision

The decision letter is logged like any accreditor response (§11.2) with a type flagged `is_decision`. The lead then:

1. Selects a `decision_code` from the framework's vocabulary.
2. Enters effective date; term and expiry pre-fill from `term_years` (editable); conditions if any.
3. Triages the letter's findings, recommendations and conditions as feedback items (§11.3). Open items from earlier rounds that the decision restates are linked by `carried_from_item_id`.

The system then:

- Writes `accreditation_status` (official, append-only).
- Generates **follow-up milestones** from the decision's `follow_up` list.
- Generates **recurring maintenance milestones** from the lifecycle's `maintenance` phase (e.g. WSCUC Annual Report each year).
- Creates a **"Start next cycle"** milestone at `expiry_date − next_cycle.start_offset_days_before_expiry`.
- Moves `current_phase` to `maintenance`.

### 12.2 Maintenance phase

The maintenance view per engagement shows:

- Upcoming obligations (annual reports, interim/progress reports, notifications like ABET SCR's 60-day summary to students and faculty).
- Open feedback items (findings, conditions, recommendations) with their actions, owners and due dates; open accreditor responses awaiting reply.
- Official status and expiry countdown.
- **Report a change** button: creates an ad-hoc milestone of type `submission` for substantive-change notices (template-driven where the framework defines one).

Follow-up reports are ordinary reports whose template includes a `feedback_response` block, so they assemble themselves from open items + actions + evidence. Each follow-up submission then runs its own response sub-cycle (§11).

### 12.3 Starting the next cycle

"Start next cycle" creates a new engagement (`kind = reaffirmation`, `previous_engagement_id` set), defaulting to the newest published version of the same framework. Evidence links and open feedback items carry forward (§8.1 step 6). The old engagement closes once its maintenance milestones are done (invariant 9).

### 12.4 Continuous improvement link

Every feedback item whose severity has `requires_action = true` must have at least one `action` before it can be resolved. Actions record what was done, when, by whom, with evidence and an effectiveness note — the same structure the assessment cycle uses (§13), so "evidence of improvement" is one query regardless of where the action came from.

---

## 13. Assessment cycle (P1, kept minimal)

| Table | Key fields |
|---|---|
| `outcome` | scope_type (`institution`, `program`, `admin_unit`), scope_id, kind (`ILO`, `PLO`, `SO`, `AUO`), code, statement, active |
| `measure` | outcome_id, name, kind (`direct`, `indirect`), instrument, target_text, target_value null, frequency |
| `assessment_result` | measure_id, cycle_label (e.g. `AY2025-26`), value, n, met (`met`, `not_met`, `partial`, `no_data`), interpretation, evaluated_by, evaluated_at, evidence_item_id |

Loop: outcome → measure + target → result → interpretation → `action` (source_type `assessment_result`) → next cycle's result shows the change → `effectiveness_note` on the action.

Outcomes can be linked to requirements (e.g. ABET Criterion 3 Student Outcomes, WSCUC CFR 2.3) through an `outcome_requirement(outcome_id, requirement_id)` join, so assessment evidence appears in the requirement workspace. Curriculum mapping (course ↔ outcome) is **not** in P1.

---

## 14. Dashboards

| Dashboard | Shows |
|---|---|
| **Portfolio** (home) | Every engagement: subject, accreditor, phase, next milestone and date, overdue count, responses awaiting reply, open accreditor items, official status, expiry |
| **Engagement readiness** | Applicable requirements; with owner; with ≥1 approved evidence link; internally approved; needs work; stale evidence; report sections by status; milestones overdue / due in 30 days |
| **Accreditor responses** | Responses awaiting reply with due dates; open items by category, owner and age; items reopened by the accreditor; submissions awaiting a response |
| **Maintenance** | Recurring obligations due in 90 days; open findings by severity; actions overdue; accreditations expiring in 24 months |
| **Framework health** | Versions in draft/review; extraction items pending; unverified quotes; requirements without provenance |

No percentage labelled "compliance", "readiness score" or "likelihood".

---

## 15. AI Framework Compiler

### 15.1 Flow

```
Create draft version → Upload sources → Classify → Extract text/OCR → AI extract → Verify quotes → Review → Publish
```

1. **Create draft framework version** — name, accreditor, scope, edition, effective dates.
2. **Upload sources** — PDF, DOCX, XLSX. AI proposes `role` and `authority` per document; user confirms. `sample_report` is labelled "never a source of requirements".
3. **Text extraction** — `parseDocument()` (liteparse, Appendix D) returns text **per page** with the method used: native text layer, local OCR, or vision model. DOCX/XLSX become pseudo-pages (section / sheet). Pages with no text, or with a garbled text layer, escalate to OCR or the vision model (e.g. the scanned PUC guides; the NBAQ 2017 handbook, whose embedded text layer is visibly corrupted). Each page is stored in `source_page` with its method, confidence and parser version; OCR'd pages are marked for spot-check.
4. **AI extraction** — per document, in windows of ~8 pages with 1 page overlap. Output must match the schema in Appendix B. Targets depend on document role:
   - `standards` → requirements (hierarchy, codes, verbatim text), notes
   - `policy_procedure` → lifecycle milestones, decision and finding vocabularies, eligibility requirements
   - `report_template` → report template sections, prompts, tables
   - `guidance` / `evidence_guidance` → notes with authority
5. **Verification (deterministic, no AI):**
   - Every item's `source_quote` must be found in the cited page text after whitespace/diacritic normalisation (fuzzy match ≥ 0.9). Fail → `quote_verified = false`, flagged.
   - Requirement `official_text` must itself be contained in the source pages.
   - Structural checks: missing parents, duplicate codes, orphan notes, empty text, inconsistent code patterns within a level.
   - Window-overlap duplicates merged by code.
6. **Review screen (split view):** left = PDF at the cited page with the quote highlighted; right = proposed tree. Reviewer can accept, edit, reject, re-parent (drag), merge, split, change authority/type, and fix the source link. Bulk-accept is allowed only for items that are `quote_verified` with no flags.
7. **Publish** — invariant 2 applies. Accepted items become real rows; the version becomes immutable.

### 15.2 Revisions

Uploading a new edition creates a **new draft version** (`supersedes_id` set). P1 adds a diff: unchanged, reworded, moved, added, removed requirements matched by code then text similarity. Engagements stay on the version they started with unless a lead migrates them explicitly.

### 15.3 Model use

- Two internal functions, `aiExtract(task, inputText, zodSchema) → items[]` and `aiOcr(pageImage, lang) → text`, implemented with the **Vercel AI SDK** (`generateObject` with Zod schemas; image input for OCR) and the **Anthropic provider** by default. Provider and model names come from env config; switching provider is configuration, not code. Provider-specific options (e.g. prompt caching for long handbooks) pass through as provider options.
- liteparse's vision-model fallback is wired to `aiOcr`, so every model call — extraction or OCR — goes through the same provider config, logging and data-handling rules.
- Prompts versioned in the repository; every call logged to `job.result` with prompt version, model, token counts.
- Temperature 0. No AI calls outside the `job` worker.

---

## 16. AI guardrails (summary)

AI **may**: classify documents, OCR scanned pages, extract hierarchy and verbatim text, propose notes/milestones/templates/vocabularies, propose feedback items from accreditor letters, each with a verified quote (P1), draft narrative (P2), suggest evidence (P2).

AI **may not**: approve anything; set official status; mark a requirement met; create `required` items without a verified quote; modify a published version; invent sources. All AI output is labelled **"AI — pending review"** until a human acts on it, and `origin = ai` is retained after approval.

---

## 17. Permissions, security, audit

- Authentication through the institution's SSO (OIDC or SAML), with email + password for local/dev and external reviewers. Authorization is enforced twice: in the permission service, and by PostgreSQL row-level security on every table by `institution_id` and role scope, using per-request session settings (`SET LOCAL app.user_id`, `app.institution_id`) so it works on any PostgreSQL host.
- Object storage buckets are private; files are served through short-lived signed URLs issued only after the permission check, respecting evidence confidentiality.
- `contains_student_data` evidence is restricted by default and excluded from external reviewer access unless explicitly granted.
- External reviewers (P1): access only to a chosen submission snapshot and its cited evidence, read-only, watermark on preview, auto-expire, every view logged.
- Audit log viewable per record and exportable.
- Backups with point-in-time recovery.

---

## 18. Technical approach and build plan

### 18.1 Stack (defaults — keep unless there is a reason)

**Rule: host-agnostic.** The application depends only on open standards — PostgreSQL, the S3 API, OIDC/SAML, SMTP, HTTPS — configured by environment variables. No hosting provider's proprietary service may be required. The same Docker images run on a VM, Easypanel, Kubernetes, or a cloud platform with managed PostgreSQL and object storage.

| Layer | Choice | Notes |
|---|---|---|
| Language | **TypeScript** end to end | One language for web, worker and tests |
| API | **Hono** on Node (`@hono/node-server`), Zod validation, OpenAPI generated from route schemas (`@hono/zod-openapi`) | The single entry point for all data access (§18.3). Also serves the built front end as static files |
| Front end | **React** single-page app built with **Vite**; **TanStack Router** (routing) and **TanStack Query** (server state) over the typed **Hono RPC client** | Internal, login-only tool: no server rendering needed. No direct database access from the front end |
| UI | Tailwind CSS + shadcn/ui; **Tiptap** (rich text); **TanStack Table** (data tables, trackers) | RTL via `dir="auto"` on content |
| Database | **PostgreSQL 16+**, standard extensions only (`pgcrypto`, `pg_trgm`) | Self-hosted, RDS, Azure, Cloud SQL, Neon or Supabase all work as plain Postgres |
| Data access & migrations | **Drizzle ORM** + `drizzle-kit`; migrations are committed SQL files | Triggers (immutability, audit) and RLS policies live in those SQL migrations |
| Authorization | Permission service in code + **PostgreSQL RLS** via `SET LOCAL app.user_id / app.institution_id` per request | No dependency on a vendor's `auth.uid()` |
| Authentication | **Better Auth** (sessions in Postgres): generic **OIDC** and **SAML** SSO, email + password fallback | Verify the SAML plugin against the institutional IdP at M0; if it falls short, put an OIDC broker (e.g. Keycloak) in front — still standards-only |
| File storage | **S3-compatible API** (AWS SDK v3): MinIO when self-hosting; any S3-compatible service in the cloud | Private buckets, signed URLs, SHA-256 on every object |
| Background jobs | **pg-boss** (job queue inside PostgreSQL) run by a separate **worker** process from the same codebase | No Redis or external queue |
| Document processing | **liteparse** (`@drmoyassine/liteparse`, owned and co-developed) behind `parseDocument()`; cascade: native text → local OCR (RapidOCR) → vision model via `aiOcr` | Version pinned; AMS requirements in Appendix D; `exceljs` still used for dataset templates and XLSX export |
| AI | **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`), behind `aiExtract` / `aiOcr`; Claude by default; provider and model in env | Library only — no Vercel hosting dependency. Approved for framework source documents; evidence files are not sent in the MVP |
| Export | `docx` (Word), headless **Chromium via Playwright** (PDF from HTML), `exceljs` (XLSX), `archiver` (ZIP) | Arabic fonts bundled in the image for RTL PDF output |
| Email | **SMTP** (Nodemailer) | Any mail relay |
| i18n | `react-i18next`; UI English first, Arabic later | Content always supports Arabic/RTL |
| Packaging | **Docker** images `app` (Hono API + static front end) and `worker`; **Docker Compose** file with `postgres` and `minio` for a full self-contained install | Healthchecks; config via env only |
| Observability | Structured JSON logs to stdout; OpenTelemetry-compatible; error tracking optional (env-toggled) | |
| Tests & CI | **Vitest** (unit), **Playwright** (end-to-end on seeded fixtures), CI runs migrations against a throwaway Postgres + MinIO | |
| Later integration | Governed-metric adapter calls the semantic layer's REST/JSON API (e.g. Cube) over HTTPS | §9.5 |

### 18.2 Why one PostgreSQL database (and not a database per standard)

- **Reuse across frameworks is the product.** One evidence item serves WSCUC, PUC and ABET; open items carry into the next cycle; the portfolio spans all engagements. Separate databases per standard would turn each of these into a cross-database join or a sync job.
- **Isolation is already provided by data**: rows keyed by `framework_version_id` and frozen on publish. A framework version is hundreds of rows, not millions; there is no scale reason to split.
- **PostgreSQL supplies what SQLite/libSQL does not out of the box**: row-level security per unit/program/engagement, many concurrent writers, mature hosting on every platform, and the same engine as the institutional warehouse.
- **Where per-database isolation would make sense** is per *institution*, if the AMS is later offered to several universities (database- or schema-per-tenant). The schema already carries `institution_id` to keep that option open.
- **Portability of a framework** is handled by the JSON export (§7.7), not by shipping a database file.

### 18.3 Code structure

Structure as a **modular monolith** in one repository (pnpm workspace):

```
/apps/web        React SPA (Vite) — UI only; talks to the API through the typed Hono client
/apps/api        Hono app — routes, middleware, OpenAPI; serves /apps/web build in production
/apps/worker     pg-boss worker — parsing, AI extraction, OCR, exports, notifications, dataset refresh
/packages/core   service modules: org, framework, engagement, evidence, reports, responses,
                 decisions, compiler, assessment (business rules; no HTTP)
/packages/db     Drizzle schema, SQL migrations (RLS policies, triggers), seed fixtures
/packages/shared Zod schemas and types shared by web, api and worker
```

Modules call each other through exported service functions, not each other's tables. Both `api` and `worker` call `packages/core`; neither contains business rules of its own.

**One checkpoint for every request.** Every API route runs the same middleware chain, in this order:

1. **Authenticate** — Better Auth session or API key → user, institution.
2. **Authorize** — the route declares its required permission (`requires('evidence:link', scopeFrom(params))`); the permission service checks role × scope.
3. **Open the transaction** — `SET LOCAL app.user_id`, `app.institution_id`, `app.request_id` so RLS and the audit trigger see the caller.
4. **Validate** — Zod schema on params, query and body.
5. **Handle** — call the service function inside that transaction.

Rules: no route is registered without a `requires(...)` declaration (enforced at registration — the app refuses to start otherwise, and a CI test enumerates routes to prove it); the front end never receives database credentials; the worker runs jobs inside the same transaction helper with the identity of the user who queued the job (or a named system identity), so RLS and audit apply to background work too.

External libraries the AMS depends on heavily sit behind one internal function each: `parseDocument()` (liteparse), `aiExtract()` / `aiOcr()` (AI SDK), `datasetSource.fetch()` (§9.5). Nothing else in the codebase imports those libraries directly.

**Why not Next.js.** Its strengths — server rendering, search visibility, React Server Components — do not matter for a login-only internal tool, and server actions would spread data access across many entry points instead of the single checkpoint above.

**Why not Frontbase.** Frontbase targets edge-deployed sites and consoles and uses a SQLite-compatible SQL dialect so it can run on D1/Turso/Postgres. The AMS depends on PostgreSQL-specific guarantees (row-level security, immutability and audit triggers, JSON/array columns, an in-database job queue) and on long-running server work (OCR, Chromium PDF export, ZIP packaging) that does not fit edge isolates. Frontbase remains a candidate for peripheral surfaces later (e.g. a public accreditation-status page or a lightweight reviewer portal reading the AMS API).

### 18.4 Milestones

| # | Milestone | Done when |
|---|---|---|
| **M0** | Scaffold: pnpm workspace per §18.3, Docker Compose (app, worker, postgres, minio), Hono app with the five-step middleware chain and route-permission enforcement, React SPA shell with typed client, Drizzle schema + SQL migrations for §6.1 and §6.8, Better Auth with OIDC/SAML + password, roles, RLS via session settings, audit trigger, CI | A contributor scoped to one program cannot read another program's rows (test); a route registered without `requires(...)` makes startup and CI fail; a write through the API produces an `audit_event` with the caller's id |
| **M1** | Framework library: §6.2 tables, manual editor (tree), notes with authority, report-template and lifecycle JSON editors with schema validation, JSON import/export, publish + immutability | The three fixtures in Appendix A import, publish, and reject any edit after publishing |
| **M2** | Engagements & roadmap: wizard (lead required), engagement members, instantiation, milestone generation and due-rule engine, roadmap timeline and editing with guardrails (§8.5), template-update review, phase advance, requirement workspace, ICS export | Creating "WSCUC reaffirmation, review year 2028" and "ABET EAC initial, BS Mechanical, review year 2027" on the same code path yields correct milestones and dates per Appendix A; requirement counts match applicability tags |
| **M3** | Evidence: items, versions, links with rationale, review, stale flag, copy-forward; dataset items with `dataset_spec`, `manual_upload` source, generated templates, data request tasks | One file linked to a WSCUC CFR and an ABET criterion with different rationales; re-upload shows "newer version available" on both; one retention dataset uploaded once fills tables in a WSCUC and a PUC report, and a re-upload after submission leaves the submitted snapshot unchanged |
| **M4** | Reports: template → report, seven block types, approvals, attestation, snapshot, DOCX/PDF/XLSX/ZIP export | WSCUC institutional report and ABET SSR export with a populated compliance matrix and evidence index; snapshot cannot be edited; Arabic PUC report renders RTL |
| **M5** | Accreditor responses: log response, reply milestone, items, triage, resolution, revise-and-resubmit rounds, reply reports, close, carry-forward, phase gate, response views | Logging an ABET Draft Statement received 10 Jan creates a due-process reply milestone due 9 Feb and a `due_process` report whose feedback-response block lists the items; logging an NBAQ completeness review creates round 2 of the self-assessment report with only the flagged sections reopened; an item not accepted in round 1 appears in round 2 linked to its original |
| **M6** | Decisions & maintenance: decision as a response, status record, actions, follow-up and recurring milestone generation, start-next-cycle | Recording ABET `IR` on a review-year-2027 engagement creates an Interim Report milestone due 1 July 2029 with a report whose feedback-response block lists the weaknesses; recording WSCUC reaffirmation with 8 years creates annual-report milestones and a start-next-cycle milestone |
| **L** (parallel track, gate before M7) | liteparse readiness: implement Appendix D requirements in the liteparse repository, release a pinned version | The Appendix D test corpus passes; the AMS `parseDocument()` contract tests pass against the released version |
| **M7** | Framework Compiler | §19.2 passes on the WSCUC 2023 Handbook and the scanned PUC 2019 guide |
| **M8** (P1) | Assessment cycle, self-rating, notifications, external reviewer, version diff | A program records outcome → result → action → follow-up result in one cycle |
| **M9** (P1) | Governed-metric adapter (§9.5) | Switching the retention dataset from `manual_upload` to `governed_metric` refreshes it from the semantic layer with `as_of` and definition version, suppressed cells shown as suppressed, and no change to any bound report other than the values |

---

## 19. Acceptance criteria

### 19.1 Platform (the architecture test)

Using only configuration (no accreditor-specific code):

1. One institution-level engagement (WSCUC or PUC) and one program-level engagement (ABET EAC) run side by side.
2. Each has a roadmap with all five phase types (eligibility may be skipped for reaffirmation), and each produces a self-study report from its own template.
3. One evidence item supports both engagements with different rationales.
4. Each engagement can record a decision and move into maintenance with correct follow-up milestones.
5. A submission receives an accreditor response containing a missing item, a correction, a query and a confirmation; each is tracked to closure, the correction produces a round-2 snapshot, and the item history is visible from the linked requirement.
6. Starting the next cycle carries forward evidence links and open feedback items.
7. The Engagement Lead adds a local milestone and skips an optional one; the self-study and decision milestones cannot be deleted; publishing a newer framework version shows a change list on the running engagement instead of altering it.

### 19.2 Framework Compiler

1. Multiple source documents upload and are classified by role.
2. A requirement hierarchy is extracted with verbatim text and page-level provenance on every item.
3. ≥ 95% of extracted requirements pass quote verification on a text-layer PDF (WSCUC Handbook); every failure is flagged, none is silently accepted.
4. Scanned Arabic pages (PUC guide) are OCR'd and marked for spot-check; their quotes verify against the OCR text.
5. NBAQ-style "Examples" and "Suggested Documentation" are classified `example` / `suggested`, never `required`.
6. Nothing is published until a reviewer approves it; a revised source set creates a new draft version.

### 19.3 Traceability (for every published requirement, one click answers)

1. Which source document and page? 2. What exact text? 3. Which framework version? 4. Official, example, suggested, AI-suggested or institution-defined? 5. Who approved it and when?

### 19.4 Integrity

- No screen or export uses "compliant", "met" or a predicted outcome for internal statuses.
- A snapshot regenerates byte-identical exports from its manifest.
- The audit log reconstructs who changed any requirement, link, section or status.

---

## 20. Open decisions (keep short; defaults in brackets)

1. ~~Hosting~~ — **decided: host-agnostic.** Where to deploy is an operational choice made per installation; data-residency rules decide it, not the code.
2. ~~AI data handling~~ — **decided: approved** for accreditor/framework documents. Evidence files are not sent to the model in the MVP; revisit before P2 (AI evidence suggestions, narrative drafting).
3. **Framework sharing** — institution-private or shareable library. [Private; JSON export enables sharing later]
4. **Student-level evidence** — allowed in the repository? [Allowed only as `restricted`, flagged, excluded from external access]
5. **Data-layer identity** — which service identity and security context the AMS uses against the governed layer, and whether certified snapshot ids are exposed. [Aggregated, suppressed measures only; certified ids when available]
6. **PUC process dates** — confirm the review, response and renewal steps with PUC so the PUC lifecycle template can be completed.

---

## Appendix A — Seed fixtures (lifecycle and report templates)

These are the starting configurations for testing. Requirement trees are loaded by import or by the Compiler; the lifecycle and report templates below are the parts most likely to be wrong if left to extraction, so they are specified here. Dates come from the uploaded documents; verify against the current editions before production use.

### A.1 WSCUC — Institutional (2023 Handbook, revised)

- **Level labels:** `["Standard", "CFR"]`; heading nodes for CFR groups (e.g. "Institutional Purposes", "Integrity and Transparency").
- **Requirements:** Standards 1–4; CFRs 1.1–1.8, 2.1–2.14, 3.1–3.11, 4.1–4.8.

**Lifecycle — `initial`:**

| Phase | Milestones |
|---|---|
| Eligibility | Submit inquiry · Introductory meeting (≈2 business days after inquiry) · Pay eligibility review fee · Submit Notice of Intent · Submit Programs & Locations at Eligibility form · Submit Alignment Review Submission Form (*report*) · Financial Review · Eligibility decision (decision point, within 60 business days of complete materials) · Submit Application for Accreditation + SAV1 fee |
| Self-study | Seeking Accreditation Visit preparation · Self-study report (*report*) *(confirm sequence against How to Become Accredited manual)* |
| Review | Seeking Accreditation Visit(s) |
| Decision | Commission action: candidacy / initial accreditation / deny |
| Maintenance | Annual Report (yearly) · follow-ups per action letter |

**Lifecycle — `reaffirmation`** (≈ 2 years):

| Phase | Milestones (due rule) |
|---|---|
| Self-study | Consultation with WSCUC staff liaison (anchor `submission_date`, −540 d) · Review accreditation history: last team report, action letters, interim/substantive change documents (−510 d) · Complete Compliance with Standards Worksheet draft (−360 d) · Essays drafted (−150 d) · Internal approval (−45 d) · President's letter signed (−15 d) · **Submit Institutional Report** (anchor `submission_date`, 0) |
| Review | Offsite Review (manual) · Accreditation Visit (anchor `visit_date`) · Response to team report (manual) |
| Decision | Commission action (decision point) · Action letter received (≤ 30 days after decision) |
| Maintenance | Annual Report (recurring; ALO submits) · Progress/interim report or special visit per action letter · Start next cycle |

**Decision vocab:** `reaffirm` (accredited; term 6/8/10, chosen at entry), `initial` (accredited; 6/8/10), `candidacy` (candidate; max 5), `defer` (deferred; ≤ 1 year, follow-up: report), `notice_of_concern` (accredited; follow-up: special visit within 4 years), `warning` (sanctioned; 2 years; follow-up: meeting with WSCUC within 90 days), `probation` (sanctioned; 2 years; same), `show_cause` (sanctioned; 1 year; same), `deny` (not_accredited), `withdraw` (withdrawn).
**Finding vocab:** `recommendation` (requires_action), `commendation` (no action).
**Response vocab:** `eligibility_decision` (is_decision for the eligibility phase; no reply) · `information_request` (reply required; window from letter *(confirm)*) · `team_report` (reply optional — institution response before Commission action; `letter`) · `action_letter` (is_decision) · `annual_report_query` (reply required *(confirm)*).

**Report templates:**

- `alignment_review` (application): Institution information; Mission, educational quality and values (≤ 500 words); Innovation aligned with mission (≤ 500); Institutional accreditations; Strategic partnerships; Enrollment (data_table: Year, UG FT, UG PT, GR FT, GR PT — 3 years); Retention (data_table: Academic year, cohort size, rate); Graduation (data_table: cohort year, cohort size, 6-year rate); Post-graduation outcomes; Authorization and governance (≤ 500) + required uploads (appendix); Sanctions.
- `institutional_report` (self_study; 12,000–18,000 words; attestation required): Section A Introduction — Institutional context, process to prepare the report, response to previous Commission actions, other topics · Section B Essays — Standard 1, 2, 3, 4 (each linked to its CFRs) · Section C Reflections · Appendix I Compliance Worksheet (`compliance_matrix`) · Appendix II Federal Compliance Forms (appendix) · Appendix III Institutional Exhibits (`evidence_index`) · President's letter (`attestation`).
- `annual_report` (annual): Student enrollment (data_table), Student demographics (data_table), Completions (data_table), Financial indicators (data_table: 7 indicators), Uploads (audited financial statements).

### A.2 ABET EAC — Program (APPM 2025-26; SSQ 2027-28)

- **Level labels:** `["Criterion", "Item"]` plus a root for applicable APPM policy requirements (`is_assessable = true`, e.g. I.C eligibility, program name rules).
- **Requirements:** General Criteria 1–8; Program Criteria tagged with `program_tags` (e.g. `mechanical`); eligibility policies.

**`review_year`** = calendar year of the on-site visit.

| Phase | Milestones (due rule) |
|---|---|
| Eligibility (`initial` only) | Confirm ≥1 graduate within the two academic years before the visit (task) · Submit Request for Readiness Review (`fixed 08-15`, year −1) · Submit Readiness Review Report + transcripts (`fixed 09-01`, year −1, *report* `readiness`) · Pay Readiness Review fee (`fixed 11-30`, year −1) · Readiness Review recommendation received (`fixed 12-20`, year −1, decision point) · Notify ABET of decision (`fixed 01-15`, year 0) · Submit RFE signed by CEO + one transcript per program + Request for Acknowledgement (`fixed 01-31`, year 0) |
| Eligibility (`reaffirmation`) | Submit RFE (`fixed 01-31`, year 0) |
| Self-study | Assign criterion owners (`fixed 09-01`, year −1) · Complete Tables 5-1, 6-1, 6-2, D-1, D-2 (`fixed 04-15`, year 0) · Draft SSR complete (`fixed 05-15`, year 0) · Internal approval (`fixed 06-15`, year 0) · **Submit Self-Study Report** (`fixed 07-01`, year 0) |
| Review | Pay invoice (30 days after invoice, ~`fixed 05-31`, year 0) · Review team for conflicts (manual) · On-site visit (anchor `visit_date`; Sep–Dec) |
| Decision | Draft Statement received (manual) · Submit 30-day due-process response (`after` draft statement, +30 d, *report* `due_process`) · July Commission meeting (`fixed 07-15`, year +1) · Final Statement received (`fixed 08-31`, year +1) |
| Maintenance | Report program changes during accreditation period (ad hoc) · follow-ups per decision · Start next cycle |

**Decision vocab** (follow-up year offsets relative to `review_year`, the visit year; ABET takes the action in July of review_year + 1):
`NGR` accredited, 6 yrs → next RFE (`01-31`, +6) · `IR` 2 yrs → Interim Report (`07-01`, +2) · `IV` 2 yrs → Interim Report (`07-01`, +2) + interim visit · `SCR` 2 yrs → summary of reasons and corrective actions to students & faculty (`after` final statement, +60 d) and Show Cause Report (`07-01`, +2) · `SCV` same as SCR plus visit · `RE`, `VE`, `SE` accredited, 2 or 4 yrs → next RFE (offset entered with the decision) · `NA` not_accredited.
*(Verify each offset against the current APPM before production.)*
**Finding vocab:** Deficiency, Weakness, Concern (requires_action) · Observation (no action).
**Response vocab:** `rev_recommendation` (reply: notify ABET, `01-15` year 0; `letter`) · `rfe_acknowledgement` (no reply) · `draft_statement` (30 days; `report` → `due_process`; items: findings + corrections of fact) · `post_due_process_permission` (team chair permits additional information; `report`; due before the July Commission meeting) · `final_statement` (is_decision).

**Report templates:**

- `readiness` (readiness): Background Information · Criteria 1–8 · Program for Readiness Review · Appendices (discipline-specific syllabi only).
- `ssr` (self_study; attestation required): Background Information · Criterion 1 Students · Criterion 2 Program Educational Objectives · Criterion 3 Student Outcomes (incl. SO–PEO mapping table) · Criterion 4 Continuous Improvement (assessment processes, frequency, expected attainment, results, documentation, use for improvement) · Criterion 5 Curriculum (Table 5-1 `data_table`) · Criterion 6 Faculty (Tables 6-1, 6-2 `data_table`) · Criterion 7 Facilities · Criterion 8 Institutional Support · Program Criteria · Appendix A Course Syllabi · Appendix B Faculty Vitae · Appendix C Equipment · Appendix D Institutional Summary (Tables D-1, D-2) · Signature attesting to compliance.
- `interim` (follow_up; attestation required): A. Contact information · B. Deficiencies, Weaknesses and Concerns from previous evaluation and actions taken (`feedback_response`) · C. Additional evidence to be provided during the visit · Submission attesting to compliance.
- `due_process` (response): Response per shortcoming (`feedback_response`, items of category `finding`) · Corrections of fact (`feedback_response`, items of category `correction`).

### A.3 PUC Kuwait — Institutional (Institutional Accreditation Guide, 2019; Arabic)

- **Level labels:** `["Standard", "Measure", "Indicator"]` (معيار / مقياس / مؤشر); codes like `1-1-1`; each standard has a description (توصيف) stored as a `guidance` note.
- **Requirements:** 7 standards — (1) Mission, goals, vision and strategic planning; (2) Teaching and learning; (3) Governance, leadership and administration; (4) Students; (5) Faculty and support staff; (6) Institutional resources; (7) Scientific research and innovation. Indicators containing numeric norms get a `quantitative_norm` note.
- **Decision vocab:** `accredited`, `accredited_with_conditions`, `not_accredited` (term entered from the decision letter).
- **Response vocab:** `query_letter` (reply required; window from letter *(confirm)*) · `decision_letter` (is_decision; conditions triaged as `finding` items requiring actions).

| Phase | Milestones |
|---|---|
| Eligibility | PUC request letter received (decision point; attach letter) |
| Self-study | Assign section owners · Data tables complete · Draft complete · Board approval · Attestation signed · **Submit self-study** (anchor `submission_date`) |
| Review | Committee review / visit *(confirm)* · Respond to queries |
| Decision | PUC decision letter (decision point) |
| Maintenance | Implementation plan against conditions (actions from findings) · Condition progress reports *(confirm)* · Start next cycle (before expiry) |

**Report template `puc_self_study`** (self_study; Arabic; attestation required) — "Item 11 – Institutional Evaluation Data": 1 General information · 2 Mission and goals · 3 Partner (affiliated) university · 4 Administration · 5 Academic programs (data_tables: current programs; programs under evaluation/accreditation; internationally accredited programs) · 6 Admission and registration · 7 Assessment and examinations · 8 Faculty · 9 Workforce · 10 Infrastructure · 11 Financial position · 12 Records and files · 13 Campus environment · 14 Attestation of accuracy.

### A.4 NBAQ Kuwait — reference for classification tests

Each of the 13 standards has: **A. Standard Requirements** → requirement `official_text`; **B. Quality Indicators** → child requirements (assessable, rated 0–4 in P1); **C. Indicators of Effective Performance: Examples** → notes with authority `example`; **D. Suggested Documentation** → notes of type `evidence_expectation`, authority `suggested`. Use this as the regression test for authority classification.
**Response vocab:** `completeness_review` (reply 30 days — "one month"; `revision`; items: missing information/documentation, format, consistency) · `team_remarks_queries` (reply before the site visit; `report`) · `draft_evaluation_report` (14 days; `letter`; items: factual errors, omissions, irrelevant content) · `deferral_report` (focused in-compliance report; window from letter; `report`) · `council_decision` (is_decision).

---

## Appendix B — AI extraction output schema

```json
{
  "items": [
    {
      "kind": "requirement | note | report_section | milestone | decision | finding_severity | metadata",
      "temp_id": "r-12",
      "parent_temp_id": "r-3",
      "code": "CFR 2.4",
      "level_label": "CFR",
      "title": "Program review",
      "text": "verbatim text from the source",
      "note_type": "guidance | evidence_expectation | data_request | quantitative_norm",
      "authority": "required | example | suggested | ai_suggested",
      "is_assessable": true,
      "applies_when": { "scope": ["institution"] },
      "milestone": { "phase": "self_study", "type": "submission", "due_text": "no later than July 1 of the calendar year" },
      "source": { "page": 8, "quote": "exact sentence copied from the page" },
      "confidence": 0.0,
      "flags": ["ambiguous_authority", "possible_omission", "conflicts_with:r-9"]
    }
  ]
}
```

Rules given to the model: copy text exactly; never paraphrase into `text`; one item per requirement; if unsure whether something is required, use `ai_suggested` and add a flag; never output an item without `source.page` and `source.quote`; `due_text` is copied, not converted — date rules are set by the reviewer.

---

## Appendix C — Changes from the draft requirement

1. **Added the lifecycle and roadmap as the spine of the product** (§5, §7.4, §8). The draft had milestones but no model of the accreditation cycle; now every engagement generates a roadmap that must produce a self-study and continues into maintenance.
2. **Added decision and finding vocabularies with follow-up generation** (§7.5, §12), so maintenance (interim reports, annual reports, sanctions follow-ups) comes from configuration.
3. **Separated report templates from the standards tree** (§10.2) — required by PUC's 14-section template and WSCUC's essay structure.
4. **Collapsed entities.** Guidance, evidence expectations and data requests are one `requirement_note` table; provenance is columns, not a separate table; applicability is tags, not a rule engine; findings and assessment share one `action` table. About 30 MVP tables instead of the draft's ~50 entities.
5. **Defined seven report block types**, including generated compliance matrix, evidence index and feedback-response blocks.
6. **Made quote verification deterministic** (§15.1 step 5): the AI's citation must be found in the page text before an item can be bulk-accepted or marked `required`.
7. **Added OCR and Arabic/RTL** as MVP needs — the PUC sources are scanned Arabic.
8. **Moved the assessment module to P1 and kept it to three tables**, linked to requirements so its evidence surfaces in accreditation work.
9. **Allowed accreditor-defined rating methods** (NBAQ, PUC) only as clearly labelled internal self-assessment.
10. **Added a milestone-by-milestone build plan with tests** for Claude Code (§18.4).
11. **v1.1 — tracked accreditor-response sub-cycle** (§11). Every submission can draw responses; each is logged with its document, split into verbatim items, assigned, resolved, answered (reply report, revised round, or letter) and closed. A separate findings table is no longer needed: findings are response items, so due-process responses, interim reports and "response to previous actions" all come from the same records.
12. **v1.2** — engagement-level roadmap editing with locked milestones, origin badges and reviewed template updates (§8.5); a mandatory Engagement Lead per engagement (§4); dataset evidence with a source adapter so the AMS works standalone (manual upload) and later consumes governed metrics without changing reports (§9.4–9.6); database rationale (§18.2).
13. **v1.3** — host-agnostic stack: plain PostgreSQL, Drizzle migrations, RLS via session settings, Better Auth (OIDC/SAML), S3-compatible storage, pg-boss jobs, Docker Compose packaging (§18.1).
14. **v1.4** — liteparse (owned, co-developed; Appendix D) for document parsing behind `parseDocument()`; Vercel AI SDK + Anthropic provider behind `aiExtract` / `aiOcr`; Frontbase reviewed and not adopted for the core, with the reason recorded (§18.3).
15. **v1.5** — React SPA (Vite) + Hono API on Node replaces Next.js; one middleware chain (authenticate → authorize → transaction with RLS identity → validate → handle) for every route and background job; route-permission enforcement tested in CI; direct-to-storage signed uploads (§9.1, §18.1, §18.3).

---

## Appendix D — liteparse requirements (co-development contract)

liteparse is owned by the project and is developed alongside the AMS. Changes are made **in the liteparse repository**, released with semantic versioning, and **pinned** in the AMS. Each requirement below lands as its own change with a test from the corpus in D.3. During development the AMS can link a local checkout (`pnpm link`); CI always uses the released version.

### D.1 The contract the AMS needs

```ts
// AMS side — the only function that imports liteparse
parseDocument(input: Buffer | Stream, opts: {
  mime: string
  languages: ('en' | 'ar')[]
  pages?: [number, number]             // page range, for batching large documents
  forceMethod?: 'native' | 'ocr' | 'vlm'
  vlm?: (img: Uint8Array, ctx: { page: number; lang: string[] }) => Promise<{ text: string; confidence?: number }>
}): AsyncIterable<ParsedPage>

type ParsedPage = {
  page: number                          // physical page index, 1-based (not the printed label)
  label?: string                        // printed page label / sheet name / section heading
  text: string                          // Unicode NFC, logical (reading) order, RTL preserved
  method: 'native' | 'ocr' | 'vlm'
  confidence?: number                   // 0–1
  language?: string                     // detected
  quality?: { textLayerScore: number; escalated: boolean; reason?: string }
  warnings: string[]
}
// plus a document-level summary: pageCount, parserVersion, configHash
```

### D.2 Requirements

| # | Requirement | Why the AMS needs it |
|---|---|---|
| LP1 | **No hard output caps.** Size, page, OCR-page and character limits are options with generous defaults; results stream **per page** (async iterator) or can be requested by page range | Real sources exceed the current 20 MB / 20 OCR pages / 50k characters: ABET APPM ≈ 130k characters; NBAQ handbook 141 pages, 7.3 MB |
| LP2 | **Stable per-page output** as in D.1: physical page index, optional printed label, method, confidence, warnings | Citations store `source_page`; quote verification runs against that page's text |
| LP3 | **Text-layer quality check and escalation.** Score each native page (e.g. dictionary-word ratio, character noise) and escalate low-scoring pages to OCR/VLM; forceable per call | The NBAQ 2017 handbook has an embedded but corrupted text layer ("Accrtditation", "Asflranc€"). Trusting it would make quotes unverifiable |
| LP4 | **Arabic.** Arabic recognition model for local OCR, or automatic routing of Arabic pages to the VLM; output in logical order, NFC, Arabic diacritics preserved | PUC guides and letters are scanned Arabic; quote matching normalises on the AMS side |
| LP5 | **Injectable VLM.** The vision fallback is a caller-supplied function; liteparse makes no model or network call of its own unless configured | All model calls go through the AMS's AI SDK configuration, logging and data-handling rules |
| LP6 | **Office pseudo-pages.** DOCX → one pseudo-page per page break or top-level section, with the heading as `label`; XLSX/CSV → one pseudo-page per sheet, rendered as a pipe/TSV table with the sheet name as `label` | ABET Self-Study Questionnaires (DOCX) and supplement tables (XLSX) become report templates with citable locations |
| LP7 | **Table-aware text** for PDF tables where feasible: keep row order, and keep cells of one row together | PUC indicators and NBAQ rating tables are tabular; extraction quality depends on row integrity |
| LP8 | **Reproducibility.** Every result carries `parserVersion` and a `configHash`; the same input and config give the same native/OCR output | Stored on `source_page` so any extraction can be traced and re-run |
| LP9 | **Server performance.** Runs in a Node worker with bounded memory; per-page timeout configurable; no browser-only dependencies on the Node path | Large handbooks are parsed in the background worker |
| LP10 | **Licence and packaging unchanged:** MIT; heavy adapters (OCR models) remain optional peer dependencies | Keeps the AMS image size and licensing simple |

### D.3 Test corpus

| Case | Source | Expect |
|---|---|---|
| Text-layer PDF, long | WSCUC 2023 Handbook (26 pp) | All pages `native`; known CFR sentences found verbatim on the right pages |
| Long manual | ABET APPM 2025-26 (69 pp) | Streams all pages; no truncation; I.E.12 action definitions on the right pages |
| Corrupted text layer | NBAQ Handbook 2017 (141 pp) | Garbled pages escalated; corrected text contains "Accreditation" where the text layer had "Accrtditation" |
| Scanned Arabic | PUC Institutional Accreditation Guide 2019; PUC letter 2022 | Pages `ocr` or `vlm`; indicator codes like `1-1-1` and Arabic indicator text recovered in reading order |
| DOCX template | ABET E002 Self-Study Questionnaire | Pseudo-pages labelled by criterion headings |
| XLSX tables | ABET Supplement Tables 5-1, 6-1, 6-2 | One pseudo-page per sheet with column headers intact |

Accreditor documents are kept in the AMS repository's private test fixtures, not redistributed through the public liteparse repository; liteparse's own CI uses redistributable look-alike samples for the same cases.
