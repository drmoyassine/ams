---
okf_version: "0.2"
title: "AMS — Accreditation Management System Log"
generated:
  by: "process:vef-init"
  at: "2026-10-05T07:51:04.640Z"
---

# Log

Chronological log of decisions, discoveries, and session learnings. This is the **single-source memory** — durable context that survives across sessions. Newest entries first.

> **OKF reserved filename.** `log.md` follows the [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) convention. It links to DECISIONS.md; decisions remain the canonical record.

---

## 2026-10-07 — Requirements cards: placement by code, ⋯ menu, link-evidence dialog, hover details

An item's place now follows its code (`addQualityItem` / `editQualityItem`): 1 (or 1.0) is a standard, 1.2 sits under Standard 1.0, a code without its standard is refused, changing a code moves the item, renumbering a standard renumbers its sub-standards; migration 0022 moves items already added at the top level with a code like 1.2 under their standard (drafts only). Cards: sub-standards listed under their standard on the page itself (always visible, indented with a rule), not inside the standard's card; shaded "Description", "Linked evidence" and "Sub-standards" labels; a ⋯ menu (Link evidence, Add sub-standard, Edit, Delete) instead of in-card forms; editing in the same dialog as adding. Link evidence is a dialog: choose from the repository (search) or create new evidence (file or link) on the spot, with the required reason. Hovering a closed card shows its title, description and linked evidence.

---

## 2026-10-07 — Requirements as accordions

The internal framework's Requirements tab shows each standard as a full-width accordion with a shaded tag ("Standard 1.0", and "Standard 1.1" for its sub-standards); opening one shows its description (Edit / Delete), its evidence and, for a standard, its sub-standards as nested accordions. Expand all / Collapse all. "+ Standard" and "+ Sub-standard" open a dialog (code proposed, title, description) with "Save as draft": the item is saved to the draft version and takes effect when the version is published.

---

## 2026-10-07 — Internal framework: Requirements and Terms

Simplified at the user's request to what it is for: standards and sub-standards (two fixed levels), each a code, a title and a description, with evidence attached. The page has two tabs, Requirements and Terms; the version picker and the actions sit in the header: "Publish this version" (admin; `publishQualityVersion` approves every item as the person publishing, submits and publishes, then the version is frozen) and "Start a new version" (`newQualityVersion`, numbered one up, items, mappings and evidence carry over by code). The Requirements tab lists standards with their sub-standards, numbers new ones (9, 9.1 …), edits code, title and description in place, and shows the item's evidence. Gone from this page: level-name editing, indent/outdent, accreditor-style notes and authority, per-item review, the separate Review and publish tab. New frameworks are set up with Standard and Sub-standard.

---

## 2026-10-06 — Evidence uploads failed on the deployment

Uploads failed in production. The likely cause: AWS SDK v3 (3.729 onwards) adds CRC checksums to every request by default, which Garage 1.0.1 (our Compose storage) does not accept; the S3 client now sends and checks them only when the S3 API requires it (`requestChecksumCalculation` / `responseChecksumValidation: 'WHEN_REQUIRED'`). Not reproduced locally (Garage could not be downloaded into the build environment), so a refused upload now also reports the storage service's answer (error name, status, message) to the user and the logs instead of a bare 500.

---

## 2026-10-06 — M3 slice 1: evidence repository and reasoned links (TASK-039)

`evidence_item`, `evidence_version`, `evidence_link` (migrations 0020-0021). Items belong to the institution; restricted items are visible only to institution-wide roles, roles on the owner unit (or an ancestor) and the owner (policy decided from the row's own columns, so it also holds for the row being inserted). Versions are numbered one after another and never changed or deleted (trigger). A link carries a required rationale and a person's review (proposed → approved/rejected); its target is either an engagement requirement or an item of the internal framework keyed by code (DEC-016), exactly one, fixed. Engagement links need `engagement:work` to propose and `engagement:review` to review; internal ones `evidence:write` / `evidence:review` (new permissions). Links show "newer version available" and stale (period year before review year − 3, PRD 9.3). Suggestions: an engagement requirement is offered evidence approved on the internal items it is mapped to by approved mappings; linking still needs its own reason and review. Storage: `ObjectStore` in core, S3 implementation (AWS SDK v3 client, any S3-compatible service) in the API, in-memory store for tests. **Deviation from PRD 9.1:** files pass through the API (limit `EVIDENCE_MAX_UPLOAD_MB`, default 50) instead of a presigned browser upload, because the Compose storage endpoint is not reachable from browsers; direct upload needs a public S3 endpoint with CORS and is a follow-up. UI: Evidence page (search, add with file or link, versions, new version, where it is linked), Evidence on each internal framework item (attach with a reason, review), Evidence card in the requirement workspace (links with flags and review, "Suggested from your framework", link other evidence). Next: TASK-040 datasets.

---

## 2026-10-06 — Internal framework simplified

Pulled back to the goal: a simple, generic internal framework that institutions customise and that every external standard maps onto, so data is collected once and reported per accreditor. Removed the quality cycle (tab, `qms_cycle` column, model export, Mermaid dependency) and the building-block and attribute definitions (migration 0019 drops the column, removes those terms and turns Evidence back into a general term). The page has three tabs: Framework (level names on one line above the tree, levels by indentation, Indent/Outdent), Terms (findings, report types and general terms only, the words each standard's Terminology tab maps onto) and Review and publish. Set-up offers a generic starting template, ticked by default and used by the start-up seed: eight areas (mission and governance; programs and curriculum; teaching and learning; students and support; faculty and staff; research and community engagement; resources and infrastructure; quality assurance and improvement), each with two to four items; an empty draft offers "Start from the generic template" (`POST /api/framework-versions/{id}/quality-template`). Next: data collection on internal items and reporting through the mappings (M3).

---

## 2026-10-06 — Definitions laid out in groups

Definitions was one long card with the level names as a separate form. Now three titled groups (Your quality system: building blocks, attributes, levels; Accreditors' words: findings, reports; Other terms: general terms), each kind on its own card with a count, a one-line purpose and its own add button where adding is allowed. Levels are ordinary rows like every other term: Edit renames a level (through the framework's level names), with Add a level / Remove the lowest level at the foot of the card; when the newest version is not a draft the card says to create a new version. Internal keys are no longer shown.

---

## 2026-10-06 — Definitions, levels by depth and the quality cycle

The internal framework page now has Definitions (first), Requirements, Cycle, and Review and publish. Definitions holds fixed building blocks the institution names, defines and can switch off (Policy, Objective, Risk, Opportunity, Measure / KPI, Procedure, Evidence, Internal review, Management review, Corrective action), the attributes every item carries (Owner, Scope), level names by depth, words for accreditor findings and reports, and other terms. Blocks are glossary terms of kind `block`/`attribute` (migration 0018 widens the kind check and moves "Evidence" from general to block); they cannot be added or deleted, because the system will give each one behaviour. In the internal framework a requirement's level is its depth: no level picker, Indent/Outdent buttons (`/api/requirements/{id}/indent|outdent`), and every label follows depth and the level names ("Level n" past the named ones); renaming levels no longer resets review. The Cycle tab edits stages, blocks per stage and flows as data (`framework_version.qms_cycle`, versioned and frozen with the version; default Plan, Do, Check, Act) and draws it with Mermaid (lazy, strict security, one import point `lib/diagram.ts`); `GET /api/framework-versions/{id}/qms-model` returns blocks, attributes, levels, cycle and Mermaid text for people and agents, and the tab downloads it as JSON. Mermaid lines list each block's arrows to later stages first, so the layout breaks the loop at the arrows that go back and stages read left to right (checked by rendering in Chromium).

---

## 2026-10-06 — Internal Quality Framework page is the editor

Settings → Internal Quality Framework no longer lists versions on a card with a link to another page: it is the editor itself, with a version picker and three tabs: Requirements (the tree editor), Definitions (the terms, with the level-name form) and Review and publish (check, submit, publish, export, new version). The old `/versions/{id}` page still opens for an internal version (same tabs minus Definitions) and links back here.

---

## 2026-10-06 — Internal Quality Framework, levels edited with the terms

Renamed in the UI to "Internal Quality Framework" (default name of the framework too; migration 0017 renames the one already set up). The separate "Level names" JSON tab is gone from its version page: level names are edited in the Terms section of Settings → Internal Quality Framework (a form above the level terms: rename, add a level, remove the lowest), through `PUT /api/quality-framework/levels` (`setQualityLevels`). It acts on the newest version while it is a draft; renaming a level renames what that version's requirements carry (back to pending review), levels are dropped only from the bottom and only when unused, and once the newest version is published the editor says to create a new version. Switched-off level terms from the first release no longer show in the list.

---

## 2026-10-06 — Glossary folded into the quality framework page

One Settings item instead of two: Settings → Quality framework now holds the framework (versions, level names) and, beneath it, its terms (levels, findings, report types, general terms). The Glossary menu item is gone and `/settings/glossary` redirects. Setting up the framework refreshes the terms below it, level terms list in framework order (top first), and the Terminology tab on each standard now points to the quality framework page.

---

## 2026-10-06 — Level terms come from the quality framework

The glossary and the quality framework both named requirement levels, unconnected. Now the quality framework's level names are the glossary's level terms: level N of the framework is the term `level_N`, kept in step on set-up, on any change to the framework's level names and at start-up (`syncLevelTerms`). Renaming a level there renames it everywhere, mappings stay, a level that goes away moves its mappings to the lowest remaining level, and the first release's starter terms "Requirement group" and "Requirement" are retired onto the top and lowest level. Level terms cannot be typed in or renamed in the glossary (Arabic name and definitions can). The structural suggestion maps a standard's group-like levels to the top level and requirement-like levels to the lowest. The start-up seed sets up an empty quality framework with default levels (Standard, Sub-standard) when none exists, so the glossary has levels straight away. The glossary now holds only findings, report types and general terms besides those levels.

---

## 2026-10-06 — Term mapping moved onto each standard

Correction after review: the table of "how each standard's words map" still sat in Settings → Glossary, against the decision that anything mapping an external standard belongs on that standard's own page. It is now a Terminology tab on each external standard's version page (that standard's words only, with its own "Map unmapped terms automatically"); Settings → Glossary keeps only the institution's own terms and points to the tab. Both mapping kinds (terminology, requirements) now live on the standard.

---

## 2026-10-06 — Mappings on each standard (TASK-038)

`requirement_mapping` (migrations 0015-0016): an external requirement mapped onto an item of the institution's quality framework, keyed by requirement code within each framework (not by version) so it carries over to new versions of either side and is not part of any frozen version. Relation is covers, partly covers or related, never "equivalent", with an optional rationale. A person with framework:write proposes or edits (an edit returns it to pending), a person with framework:review approves or rejects; the worker role can only read. Triggers: the external side must be an external standard, the internal side the quality framework, and the pair cannot change. A mapping whose requirement no longer exists is flagged. UI: a Mappings tab on each external standard's version page (not in global Settings): pick a requirement, see its mapped items, propose, approve, change relation, remove; points to Settings when the quality framework is empty. API under `/api/framework-versions/{id}/mappings` and `/api/mappings/{id}`. Evidence on internal items will be offered as suggested links on mapped requirements in M3. ROADMAP-012 is complete.

---

## 2026-10-06 — Internal quality framework (TASK-037)

The institution's own framework lives in the framework library: `framework.internal` (migration 0013, at most one per institution via a partial unique index) and a trigger rule (0014) that refuses an engagement built on it. It stands on a placeholder accreditor "Internal" and is hidden from the Standards list and the glossary's external terms. Levels are named by the institution (default Standard, Sub-standard) in `levelLabels`; a version needs only level names and one approved requirement to publish (no accreditor lifecycle, vocabularies or report templates), then freezes like any version and changes via a new version. API `GET/POST /api/quality-framework`; Settings → Quality framework sets it up and lists versions; its version page shows only Requirements, Level names and Review and publish. Next: TASK-038, the Mappings tab on each external standard's page, onto this framework.

---

## 2026-10-06 — Glossary (TASK-036)

Institution-owned `glossary_term` (kinds level, finding, report, general) and `glossary_alias` (standard + level label, finding code or report template key, mapped to a term of the right kind; enforced by a trigger), migrations 0011-0012. Starter terms: Requirement group, Requirement, Required action, Observation, report types, Evidence, Engagement. Suggestions are structural, never by accreditor name: a level label is a group when it only sits at the top, labels headings, or always has requirements below it, otherwise a requirement; a finding that needs action is a required action; report templates map by kind. `seedGlossary` runs on every start (adds missing starter terms, maps only unmapped terms, never overwrites an edit). Settings → Glossary edits terms (English and Arabic) and each standard's mapping. Engagement screens show the institution's word beside the standard's with a Terms choice (ours / the standard's / both), remembered per viewer. Fixed a real race: the institution form reset what an admin was typing when a refetch landed; the form is now keyed by the saved values. Remaining in ROADMAP-012: TASK-037 internal framework, TASK-038 mappings tab on each external standard.

## 2026-10-06 — Settings area, phase 1 (ROADMAP-012, DEC-016)

Direction from the owner: a Settings entry above Sign out holding organization setup (names, branding, org chart), programs, the institution's own quality framework and the glossary; **mappings from external requirements to the internal framework live on each external standard's own page**, not in global settings (recorded in DEC-016). Built now: Settings shell with sub-menu (Quality framework and Glossary listed as coming soon), Organization (names in English and Arabic, country, default language, accent colour with a WCAG contrast check so buttons stay readable; the colour themes the app via `--primary`), org chart editor (add, rename, retype, move without cycles, deactivate only when nothing active is under the unit), Programs moved into Settings with add/edit/deactivate, the old Programs home replaced by a redirect to Engagements, new permission `institution:write` (admin only), migration 0010 (`institution.accent_color`). Requirement labels no longer repeat the code (`requirementLabel`). Defaults I chose while waiting for answers: one internal framework per institution; admins and accreditation leads edit it (framework:write); org units are structure only (heads later). Logo upload waits for the storage service (M3). Still to do under ROADMAP-012: TASK-036 glossary, TASK-037 internal framework, TASK-038 mappings tab on each external standard.

## 2026-10-06 — Frameworks tab becomes Standards (user feedback)

"Frameworks" is "Standards" in the UI (nav, page title, route `/standards`; internal names and the API keep `framework`). Import and create forms moved off the page into a "New Standard" wizard (dialog: import a file, or start from scratch). Each card lists versions as "Version <edition>" with status, date (published or effective) and an Edit (draft or in review) or View (published or retired) icon link instead of a clickable badge. Other screens still say "framework" (engagement wizard, version page): rename together if wanted.

## 2026-10-05 — M2 complete (ROADMAP-003)

Acceptance (`apps/api/src/m2-acceptance.test.ts`): WSCUC reaffirmation 2028 and ABET EAC initial 2027 (BS Mechanical) are created through the same endpoint with the same request shape and give the Appendix A roadmaps and dates (the WSCUC offsets checked independently with Python's date arithmetic; my first hand calculation of -150 days was off by one and the engine was right), locks on exactly the self-study deliverable and decision points, requirement counts that follow the tags (a civil program has the three Mechanical Program Criteria switched off), and the roadmap guardrails through the API. The engagement detail now returns milestones in phase order. Open items: the self-study report is not created with the engagement (M4); evidence-link copy-forward (M3) and feedback carry-forward (M5) are not done; requirements added in a newer framework version are not instantiated into running engagements; recurring milestones are not materialised until M6; the SPA has no Playwright browser test yet; Arabic UI strings still pending.

## 2026-10-05 — Engagement API and SPA (TASK-028..030)

API: `engagement:*` routes (chain checks the permission anywhere, the service checks it for the engagement; row-level security hides the rest), `GET /api/users`, ICS download. SPA: engagements list, one-screen wizard, engagement page (phase strip, roadmap with origin badges, member and requirement tabs, key dates, template-update review, calendar link), requirement workspace. Two real bugs found by running the UI against the real API: (1) a program-scoped lead could not read the framework library (reads of `framework:read` now need the permission anywhere, writes still institution-wide), so the wizard could not list published versions; (2) event handlers must read `e.target.value` before handing work to a mutation: React resets a controlled `<select>` right after the handler, so a lazy read sent `null`. Web tests run against the built `dist` of the other packages: run `pnpm build` before `pnpm test` after changing core or api.

## 2026-10-05 — Roadmap editing, template update, requirement workspace (TASK-025..027)

Roadmap (`roadmap.ts`): edits within PRD 8.5, key-date changes recompute due dates (a milestone the lead re-dated keeps its date; only template milestones follow their rule), completing a milestone resolves "N days after" rules, phase advance is manual, withdraw is the lead's alone. Only milestones the lead added can be deleted; template ones are skipped. Template update (`template-update.ts`): diff of the newer published version's generated milestones against the engagement's template milestones; item-by-item accept/ignore with a decision required for every change; modified milestones are protected, locked ones cannot be removed; accepting records `template_synced_version_id`, and the roadmap's lifecycle follows that version (`lifecycleVersionId`); the engagement's own `framework_version_id` never changes. New requirements of a newer version are not instantiated into running engagements (open item). Workspace (`workspace.ts`): contributor works only on requirements they own, reviewer only on ones assigned to them, the lead on all; steps per PRD 8.4, label is Internally approved; owners and reviewers must be members in a fitting role; applicability override needs a reason (stored in `na_reason` both ways). Migration 0009: anyone who can see an engagement can read the audit events of its rows (History). Mistake to avoid: I once pushed with a failing guard test because the commit step did not depend on the test result; run, read, then commit.

## 2026-10-05 — Engagement service (TASK-024)

`createEngagement` is the wizard transaction: engagement, `engagement_lead` assignment, requirements (TASK-023), milestones from the lifecycle (`generateMilestones`, pure), `current_phase` = first phase that applies to the kind. A phase type can appear twice in a template (WSCUC lists self-study once per kind), so generation uses only the entries that apply. Permissions: new `engagement:read|create|manage|lead|work|review`; `lead` (hand over, decision, final snapshot) is held by the engagement lead and admin only; the permission check gained an `engagement` scope (a program- or org-scoped grant covers that program's engagements). Migration 0008: a lead or co-lead can manage the members of their engagement and whoever creates an engagement can set its lead in the same transaction (RLS policy on `role_assignment`, never open to anyone else); a co-lead cannot assign `engagement_lead`; one role per person per engagement. Handover inserts the new lead before demoting the outgoing one because the caller stops being lead mid-transaction. Not done in create, by design: the self-study report (M4), evidence-link copy-forward (M3), feedback carry-forward (M5). Recurring milestones are stored with their recurrence but not materialised until M6.

## 2026-10-05 — M2 started: schema (TASK-021)

ROADMAP-003 split into TASK-021..031 (schema, due-rule engine, applicability and instantiation, engagement service, roadmap editing, template-update review, requirement workspace, API routes, ICS, SPA, acceptance). `vef` runs via `npx --yes vibe-engineering-framework@0.3.1 <cmd>` (the CI pin); `vef setup` regenerated the ledger I had hand-edited. Migrations 0006 (tables) and 0007 (RLS, audit, rules). Access: `app_can_access_engagement` = institution-wide role, a role scoped to the engagement, or program access for a program engagement. One-lead rule is a deferred constraint trigger (engagement and its `engagement_lead` assignment must be created in the same transaction). Locked milestones cannot be deleted or unlocked; template milestones keep phase, requiredness and key; origin can only go template to modified. Deviations from PRD 6.4: `milestone.deliverable` jsonb added (the template's `report_template_key`; `report_id` stays null until M4). Engagements are never deleted. The DEC-002 guard test caught accreditor names in comments I wrote for the demo seed; reworded (the earlier push 8bbec3d had that failure).

## 2026-10-05 — Optional demo seed for the three frameworks

`SEED_DEMO_FRAMEWORKS=true` makes the API, after the admin seed, import and publish each file in `packages/db/fixtures/` that is not already in the library (accreditor short name + edition), as the institution's administrator, through the normal importer, review and publish steps. Idempotent; off by default. Test: `apps/api/src/seed-frameworks.test.ts`.

## 2026-10-05 — ABET fixture complete (TASK-012); M1 closed (ROADMAP-002)

Loaded the 2025-26 EAC Criteria (user upload): Criterion 1-8 wording, Student Outcomes (1)-(7) and Criterion 5(a)-(d) as Items (5(a) and 5(b) carry `quantitative_norm` notes, 30 and 45 semester credit hours, required, quote-verified), Mechanical Program Criteria tagged `program_tags: [mechanical]`. SSQ 2027-28 prompts became `suggested` guidance notes without a source (docx has no pages; the `required` rule does not apply). Data-table columns for Tables 5-1, 6-1, 6-2, D-1, D-2 replace the placeholders. Gotchas: a wrapped line starting with a clause code (`I.C.2.b. may be met...`) looked like a new clause; note order in the file must match the exporter's sort (type, authority, text) or the round-trip test fails. Open: 2027-28 Criteria edition when published; master's-level criteria; other Program Criteria.

## 2026-10-05 — garage-init: the real cause of the redeploy failure

Logs from the user showed `POST /v1/layout/apply -> 500 Invalid new layout version`. The script read layout state from `/v1/status` (which does not carry it), so it always saw version 0 / no roles and re-applied version 1 on every redeploy; the first deploy worked, every later one failed. It now reads `GET /v1/layout` (the response body, not the wrapper) and applies `version + 1` only when no roles exist. The earlier test fake mirrored the same wrong assumption; it now follows the real endpoint and rejects a wrong layout version like Garage does. Lesson: a fake written from the same belief as the code proves nothing; check against a real response.

## 2026-10-05 — ABET fixture: APPM text loaded (TASK-012 in progress)

Uploaded: APPM 2025-26, Self-Study Questionnaire and Readiness template (docx), REv information sheet, Tables 5-1/6-1/6-2 (xlsx). The Criteria document itself is not among them. `abet-eac-2027-28.json` now carries Criteria 1-8 names (APPM I.B.1) and the whole of APPM I.C as 40 nested Items, verbatim with quotes; the two placeholder items were replaced. `is_assessable` is true where the clause says must/required. Not done: Criterion wording, Program Criteria, SSQ prompts as notes, data-table columns from the xlsx.

## 2026-10-05 — Real WSCUC and PUC fixtures (TASK-011)

`wscuc-2023.json`: Standards 1-4, headings and CFRs 1.1-4.8 from the 2023 Handbook text layer, every requirement quoting a sentence on its cited page; Compliance Worksheet notes are `required`, essay guidance `suggested`. `puc-2019.json`: 7 standards, 24 measures, 151 indicators, Arabic, from the scanned Guide. PUC page text is a manual transcription of image crops (no OCR engine here), stored as `method: "ocr"`; a reviewer must compare it with the PDF. Indicators that span a page break are kept whole and cite the first page. ABET (TASK-012) still needs the official Criteria document.

## 2026-10-05 — garage-init failed on redeploy; made fully idempotent

A redeploy on Easypanel failed with `garage-init` exiting 1 (the first deploy had passed). The Easypanel MCP cannot read container logs here (Loki query returns an error), so the exact Garage answer was not seen. The first version of `scripts/garage-init.mjs` relied on specific error statuses from re-importing a key and re-creating a bucket on a second run. It now checks each step first (layout present, `GET /v1/key`, `GET /v1/bucket`) and only creates what is missing, logs every step with a `[garage-init]` prefix, retries network errors, and prints Garage's own response body on any refusal. `apps/api/src/garage-init.test.ts` runs the script against a fake of the admin API, including a second run that must change nothing. If it still fails on the VPS, the `[garage-init]` lines in the `garage-init` container's output identify the step.

---

## 2026-10-05 — M1 built (TASK-013..020); real fixtures still blocked on documents

M1 (ROADMAP-002) is implemented end to end: schema (PRD 6.2), database-enforced immutability and publish gate (6.9 #1-3), Zod config schemas with cross-reference checks, core services, JSON import/export, API, and the SPA (framework list, import, tree editor, notes with authority badges, lifecycle/vocabulary/template JSON editors, review and publish, new version from a published one).

Learnings a future session needs:
- **Triggers bind the owner.** `a_version_frozen`, `a_version_lifecycle`, `b_publish_gate`, `b_no_sample_requirements` fire for every role, including the migration owner and tests using the superuser connection. Trigger names sort alphabetically and `stamp_actor` runs after them.
- **Status graph:** `draft -> in_review -> published -> retired` (in_review may return to draft). A new version must start as `draft`. Once published only `status` can change (to `retired`).
- **Publish gate covers** every requirement and note approved, every `required` note quote-verified, every `origin = ai` item with a source reference. Report templates are not part of the approval gate in the PRD (they have a review flag the UI uses).
- **Editing returns content to review.** Any edit to a requirement, note or template resets `review_status` to `pending`; approvals refer to exactly what was approved.
- **Quote verification** is `normalizeForQuote` (NFC, whitespace, case, quotes, dashes, Arabic diacritics and tatweel, zero-width marks) against the stored `source_page.text`. Clients never send `quote_verified`.
- **Self-study rule is per engagement kind:** each kind a lifecycle serves must have exactly one milestone delivering a `self_study` template (WSCUC initial and reaffirmation each have one). PRD 7.4 says "exactly one"; this is the reading that makes WSCUC's two lifecycles valid.
- **OpenAPI cannot expand a recursive Zod schema** (report template sections use `z.lazy`); the template route takes `structure` as opaque JSON and the service validates it.
- **Tests under jsdom:** `import.meta.url` was not a `file:` URL for workspace packages, so `@ams/db` uses `import.meta.dirname`. UI tests run the real API in-process through the typed client.
- `/api/me` returns the caller's roles and effective permissions so the SPA shows only actions the API will accept; the API still enforces every one.
- UI strings in the framework pages are inline English with `t(key, default)` only on titles and navigation; extraction to resources is still to do before Arabic UI work.

**Fixtures are skeletons.** `packages/db/fixtures/` holds WSCUC 2023, ABET EAC 2027-28 and PUC 2019 built from PRD Appendix A (lifecycles, vocabularies, report templates, requirement codes). Verbatim requirement text, notes and quotes are not included because the source documents are not in the repository. See `packages/db/fixtures/README.md`. TASK-011 and TASK-012 stay pending and keep ROADMAP-002 In Progress until the documents are supplied.

---

## 2026-10-05 — First deploy to Easypanel

Deployed `compose.yaml` (branch `claude/check-and-proceed-i4izas`) as Compose service `management/ams` on the owner's Easypanel (Easypanel would not create a new project: project limit; owner chose `management`). Source is the private repo over an SSH deploy key (`easypanel-ams`, read-only). Domain `ams-app.4ky7uo.easypanel.host` -> compose service `app`, port 3000. Env (generated secrets, `APP_URL`, seeded admin `admin@ams.local`) lives only in the Easypanel service. Containers `app`, `worker`, `postgres`, `garage` were running; `garage-init` completed (the app depends on it). CI run 10 (compose-smoke) is green on Docker, including login and the protected route.

Notes: the Easypanel MCP `deployComposeService` call times out client-side at 60 s while the build continues; check containers afterwards. `listProjectsAndServices` returns every service's env vars (secrets) — avoid it. The public URL was not reachable from the build sandbox (egress proxy), so end-to-end on the live URL is owner-verified.

---

## 2026-10-05 — M0 complete (ROADMAP-001)

All ten M0 tasks are done. The three done-when tests live in `apps/api/src/m0-acceptance.test.ts` (program-scoped isolation through the API and SQL; a route without `requires(...)` fails startup and `pnpm test:routes`; an API write yields an `audit_event` with the caller's id). ROADMAP-002 (M1, framework library) is now In Progress; do not start it without the framework fixtures (TASK-011, TASK-012).

Open items carried forward:
- **SAML** is proven only against a mock IdP; integrate with `sso()` (admin-only provider registration) and verify against QuickLaunch.
- **Queue sweeper** for jobs committed but never published (see TASK-008 note).
- **Better Auth rate limiting** needs `advanced.ipAddress.trustedProxies` / header config when deployed behind a reverse proxy (it logs a warning without it).
- **Playwright browser e2e** is not set up; `pnpm test:e2e` is the Compose smoke script until the SPA has real flows.
- **Object storage is Garage, not MinIO** (owner decision, 2026-10-05; `minio/mc` and the quay MinIO images were unavailable to CI). Compose runs `dxflrs/garage:v1.0.1` with `deploy/garage.toml`; `scripts/garage-init.mjs` (compose service `garage-init`) assigns the single-node layout and imports the S3 key from env via the Garage admin API v1, creates the bucket and grants access. Keys must be Garage-shaped: id `GK`+24 hex, secret 64 hex. Written without access to Garage's docs (blocked from this sandbox) and without a Docker daemon, so it is verified only by CI. **PRD §18.1/§18.3/§18.4 and the M0 kickoff prompt still say MinIO; the PRD is the owner's to amend.**

---

## 2026-10-05 — M0 tasks 001–006: scaffold, schema, RLS, API chain, auth

Learnings a future session needs:
- **Postgres access.** Everything goes through `withIdentity()` (`packages/db/src/identity.ts`): it does `SET LOCAL ROLE ams_app|ams_worker` and sets `app.user_id`, `app.institution_id`, `app.request_id`, `app.actor_type`. RLS is **not FORCEd**: the table owner bypasses it, the restricted roles never do, so never query as the owner in request code. `GRANT ams_app, ams_worker TO CURRENT_USER` is in migration 0002 so the login user can switch roles.
- **Worker role cannot approve.** `ams_worker` has no UPDATE on `extraction_item.status`/`reviewed_by` (column-level grants) and no writes to domain tables; tested in `packages/db/src/rules.test.ts`.
- **Audit.** `audit_row()` is SECURITY DEFINER; the app roles have no INSERT on `audit_event`. Append-only is enforced by triggers that also block the owner and TRUNCATE.
- **Enum columns** need CHECK constraints (Drizzle's `enum` is type-only); use the `oneOf()` helper in `schema.ts`.
- **Route enforcement.** Routes are registered only via `secureRoute()` (`apps/api/src/chain.ts`); `assertAllRoutesDeclared` runs at startup and in `pnpm test:routes`. Authentication endpoints use `rawPublicRoute()`. Coarse permission is checked in the chain; permissions whose scope comes from the request body are re-checked in the service with `assertPermitted`.
- **zod 4** is required by `@hono/zod-openapi` 1.x; the workspace uses zod ^4 everywhere.
- **Better Auth 1.7**: generic OIDC registers as a social provider (`POST /api/auth/sign-in/social` with `provider`, callback `/api/auth/callback/<id>`). Self sign-up is disabled; administrators (or the seed) create `app_user` rows; a first SSO login is linked to a pre-created `app_user` by verified email (`app_link_identity`). Auth tables are unreachable by the app roles.
- **Tests need PostgreSQL.** `TEST_DATABASE_ADMIN_URL` defaults to `postgres://postgres:postgres@localhost:5432/postgres` (vitest config). Test files run serially because migrations create cluster-level roles.

- **Jobs (TASK-008).** `enqueueJob(ctx, …)` inserts the `job` row as the caller and publishes to pg-boss in `ctx.afterCommit` (after commit only). The worker's `runJob()` re-reads the row under the envelope's identity (RLS) and checks `created_by` and type match before running, then writes status as that identity with role `ams_worker`. pg-boss tables live in its own `pgboss` schema, reachable only by the owner connection, never by `ams_app`/`ams_worker`. Known gap: if the process dies between commit and publish, the row stays `queued` with no queue entry; a sweeper is needed before real workloads (M7).
- **Typed client.** Routes are defined with `secured()` and chained with `.openapi()` so `ApiRoutes` carries the types to `hc<ApiRoutes>` in the SPA (a wrapper that returned `void` lost them).
- pnpm peer-variant duplicates of drizzle-orm broke types once pg-boss was added; a root `@opentelemetry/api` devDependency plus `pnpm dedupe` fixed it.

**SAML spike (TASK-006) result.** `@better-auth/sso` completed an SP-initiated SAML login end to end against a local mock IdP (samlify): SP metadata is generated, the AuthnRequest redirect is produced, a signed assertion with matching audience and `InResponseTo` is accepted, a user and session are created (`apps/api/src/saml-spike.test.ts`). **No broker appears necessary on this evidence, but the real institutional IdP (QuickLaunch) was not available and has not been exercised**; that remains to be verified with its metadata. Not yet integrated into `createAuth()`: doing so needs the `sso()` plugin, the `ssoProvider` table, and registration restricted to administrators (`providersLimit: 0`, since by default any signed-in user may register a provider).

---

## 2026-10-05 — AMS project seeded

PRD v1.5 committed as `docs/PRD.md`. Seeded VEF records from it: six vision themes, decisions DEC-002…DEC-015 (configuration-not-code, lifecycle roadmaps, response sub-cycle, official vs internal, authority + quote verification, single PostgreSQL, host-agnostic, SPA + Hono, middleware chain, liteparse, AI SDK, AI data handling, dataset evidence, Better Auth), roadmap items ROADMAP-001…011 mirroring milestones M0–M9 and the liteparse track, and tasks TASK-001…012 for M0 and the framework fixtures.

Learnings to carry forward:
- VEF roadmap status has no "Planned"/"Not started" value; not-yet-started milestones use `Deferred` until started. (Candidate VEF improvement.)
- ABET EAC fixture (TASK-012) is blocked on the official *Criteria for Accrediting Engineering Programs* document.
- The NBAQ 2017 handbook PDF has a corrupted embedded text layer; parsing must escalate (PRD Appendix D, LP3).

## 2026-10-05 — Framework adopted

Adopted `vibe-engineering-framework` through `vef setup`; `vef check` confirmed deterministic core enforcement. Framework docs (VISION, ROADMAP, TASKS, DECISIONS) are the public reading surfaces over canonical records. Claude Code skills (`/tasks`, `/roadmap`, `/decisions`, `/bugs`, `/apply`) were installed in `.claude/skills/`.
