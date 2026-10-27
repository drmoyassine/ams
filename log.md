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

## 2026-10-21 — Evidence collection runs: scheduler, BI call, request, form, manual (TASK-090)

Decisions: DEC-032 (new; answers the open questions of DEC-031 and TASK-090: retries, late runs, the shapes of the call to the BI and of its callback), DEC-031, DEC-006 (the worker never approves, publishes or skips), DEC-013 and DEC-019 (the AMS sends the BI the definition, never evidence), DEC-018 and DEC-020 (requests and forms are reused), DEC-024 (one entry point, the `worker` service). Migration 0065.
- **A collection is a schedule plus a method, not a cycle.** `evidence_collection_run` is one period of an item's schedule (unique per item and period). `collect_tick` (every 15 minutes, a pg-boss schedule in the general worker like `purge_trash`, no job row; `packages/core/src/collection/`) walks the institutions as a system identity with the worker role: `createDueRuns`, then `beginRun` / `callBi` / `finishRun` for each new or retryable run, then `markLateRuns`. The BI call is made between two transactions so none is held open while the BI thinks; the person's Run now and Retry do the three in one request.
- **The BI.** `POST {BI_BASE_URL}/ams/collect` through the ONE `BiClient` (`bi-client.ts`; a fake in the tests, no network): bearer key, https only (http to localhost outside production), the item's `endpointKey` resolved by `BI_ENDPOINTS` (an unknown name fails the run, nobody types an address), timeout from the item or 60 s. 200 = the supply, 202 = wait for `POST /api/bi/v0/runs/{id}/supply`, which only the run's token can call: the hash is compared in constant time, it expires after 14 days, and a database trigger clears it the moment the run is supplied, skipped or failed, so it works once. A body that does not fit is 422 with the issues and leaves the token valid. Failed calls are retried after 15 min, 1 h, 4 h, 12 h (five attempts), then the owner is told; settings failures (not configured, unknown endpoint, a dataset without columns) are not retried. With `BI_BASE_URL` empty a bi run just fails with that reason.
- **The worker role got narrow grants**, each held by a trigger or policy (and a db test): runs in their working columns (never skip one), `UPDATE (next_due_at, last_run_at)` on the item, a version only when `lineage.origin = 'bi'`, a request only with a run, `form_open` only to true, notifications only of the three `collection_*` kinds. The old notification test that said the worker never writes was updated to say exactly this.
- **Traps met.** The tests' ticks catch up every earlier daily item (a tick at a later date made hundreds of runs and 77 BI calls): each test archives the earlier items first, and the real service has the same property after a long downtime (one run per missed period, up to 500 per item and tick; noted as not done). `evidence_item_checks` and `noteEvidenceVersion` (an UPDATE on cycle outputs) must not run for a version the worker adds: `storeFileVersion` has an `opts.system`. The `link` access kind of the route chain gained a `run` target; its routes are listed in `pnpm test:routes`. A restricted item is invisible to the system identity (its row-level rule keys on a person), so the scheduler never collects one; this is documented, not worked around. A `request` item that is a dataset is asked for through its form (the answer waits until someone adds it to the data, which supplies the run). Email is not sent yet, so a request to an address without an account waits and the owner is told to copy its link from the Requests tab. The 202/callback test must look up the fake BI's call by run id, not by order.
- **Screens.** The Collection section lists the runs with Run now, Retry, Skip this period and Mark supplied; library filters Due soon / Late / Failed; My work "Evidence to supply" and Open links (`/evidence?item=`); the nav count includes the runs. `components/collection-runs.tsx` is in CONVERTED_UI.
- **Docs.** DEC-032; docs/ams-bi-contract-v0.md 3.6 (the request body, the statuses, the retries), 4.2 (the callback and its body), 5, 6, 8, 9; docs/status.md; ARCHITECTURE.md; `.env.example`; TASK-090 completed.
- Tests: 2,045 tests in 190 files (database, route-permission and migration tests included); typecheck, lint, build, i18n:extract and the responsive check pass (no horizontal overflow at 375/768/1280, English and Arabic).

## 2026-10-20 — The evidence schema: definition, dataset, collection method, schedule (TASK-089)

Decisions: DEC-031 (new; changes the evidence part of DEC-030: items 2a and 5), DEC-030, DEC-019 and DEC-013 (the BI may receive evidence; the AMS sends none to AI), DEC-020 (forms stay), DEC-002 (nothing accreditor-specific), DEC-005. Migration 0064. TASK-090 (runs) is pending.
- **Why.** The BI team builds against the evidence schema (docs/ams-bi-contract-v0.md, sections 3 and 4), so the owner fixed it before more is built on it: an item is a title, a type, a definition, collected by ONE method on an optional schedule. Collecting is a schedule plus a method on the item, not a staged cycle; cycles are for reports and Quality Assurance (coming).
- **Renamed.** `evidence_item.description` is `definition` (column, API, screens, tests; the word is gone); the type `data` is `dataset` (rows, check, API, screens, contract); the dataset's own `dataset_spec.definition` was merged into the item's and dropped. **Decision taken while merging:** when both had text and differed the dataset's was APPENDED after a blank line instead of being lost (the owner said copy when the item's is empty). **Decision taken for existing rows:** a dataset whose online form is open or has responses became `method = form`; every other row is `manual` with no schedule.
- **Added.** `method` (manual | form | request | bi | survey), `method_config`, `schedule`, `next_due_at`, `last_run_at`, with checks (the form needs a dataset; a request names exactly one person or address; a BI endpoint is a name that cannot hold a URL; the schedule's shape) and a trigger that keeps the owner, the owner unit and the person a request goes to inside the institution. Zod validates `methodConfig` per method (`checkMethod` in `packages/shared/src/evidence.ts`); a BI query is a metric, dimensions and filters, strict, never SQL. `survey` is accepted by the enum and the API, shown disabled "coming" in the form.
- **The schedule is pure.** `nextOccurrences(schedule, from, count, terms)` and `nextDue()` in `packages/core/src/evidence/schedule.ts`: dates are calendar arithmetic (a month keeps its day, or the last day of a shorter month, counted from the start date so it never drifts), then placed at the local midnight that begins them in the schedule's time zone, so daylight saving never moves them; where midnight does not exist (clocks jump over it) the date starts at its first instant, where it happens twice at the first. A semester is the start of each term of `academic_term`; fewer terms than asked for is a `gap` (`no_term`, after a date), never a guess. The due time is the END of the due date (the next local midnight); the card shows the due DAY in the schedule's zone.
- **Removed from the cycle UI.** The Cycle section of the evidence card and its menu item, New cycle (Cycles tab; the launch dialog now only reviews a run a plan proposed, so its evidence picker is gone), New plan and Change (Plans tab), `components/cycles/plan-dialog.tsx`, `components/evidence-cycle-section.tsx` and their tests. The engine and its API are untouched; the Evidence collection template stays defined and is labelled "coming" with the other templates made for named anchors (`isComingCycleTemplate` replaces `fitsEvidenceCycle`).
- **Traps met.** `z.email().trim()` validates before it trims (use `z.string().trim().toLowerCase().pipe(z.email())`). A validation refusal reaches the browser as `invalid_request` with the detail in `issues`, so the item dialogs show the issues (`errorText`). A `fieldset` given an `aria-label` equal to its select's made `getByLabelText` ambiguous: the legend names it. The migration test runs 0064 over a database built from the journal without it, seeded with the old shape.
- **Merge notes.** The journal entry is idx 64 with `when` 1792040000000 (idx 63 is TASK-088's, built apart). `evidence_request_rules()` and `dataset_spec_rules()` are replaced in 0064; if 0063 replaces either, 0064 must keep the `'dataset'` type name.
- Tests: 1,954 tests in 183 files (the database, route-permission and migration tests included): shared method and schedule schemas; core schedule (`nextOccurrences`, `nextDue`), method settings and schedule validation, type rename, owner and definition on the form; database migration over seeded data and the rules on the new columns; API; web item form per method and schedule, card chips and Collection section, the removed cycle UI; responsive states in e2e/responsive.mjs (the item form with each method and schedule, the chips, the Collection section, Edit details).

## 2026-10-20 — Cycles simplified: evidence collection, one owner, not linked to standards (TASK-087)

Decisions: DEC-030 (new; changes parts of DEC-029: items 4, 9, 12, 14), DEC-002 (Evidence collection is a template, not code), DEC-005 (the review reads "Internally approved"), DEC-006 (nothing here is AI). No migration.
- **Why.** The owner found the cycle model too confusing: a cycle could be about a standard, a unit, a program or the institution, had a subject, a lead, a responsible unit and a unit and owner per stage, and plans were inherited down the IQF. Decided 2026-10-20: cycles attach to an evidence item now, to an accreditation later (TASK-082), and Quality Assurance / report cycles are out of scope for now.
- **What stayed.** The whole engine, the tables and the API: a unit, program or institution cycle or plan can still be created through the API, existing ones are listed, and the engine's tests keep running on them. Scope and champion on standards, Link evidence and Map to IQF stay. Decisions inside the brief: no `0063_cycle_single_owner.sql` (the unit column stays NOT NULL and is derived: the evidence's unit, else one the owner heads, else one the owner holds a role in by name, else the top unit); a stage "follows" the cycle owner when its owner IS the cycle's owner, so no new column (changing the owner moves the not finished stages that had the old owner); the new output is a `note` (not a new kind, so no constraint change) that a new evidence version writes and finalizes while Collect is in progress.
- **What was refused.** A new cycle on a requirement or a standard version, and a new plan on a requirement or a framework (400 with the reason). An existing plan on a standard can still be changed or removed, so nothing is stranded; its runs cannot be launched (`canLaunch` false).
- **Traps met.** A plan on an evidence item used to need "applies to" (it had no subjects otherwise); with nothing to narrow it, the item is now its own subject (one run per period, `subjectKind` null) and a skip of such a period is stored with no subject and read back as the item's. The plan's owner must be able to start a run without `cycle:manage` (My work is for owners), so `launchCycle` and `activateCycle` allow it for a run of a plan they own. `addStage` by hand now gives the stage the cycle's owner (an explicit null still leaves it open).
- **Left behind on purpose.** `requirementContexts` still computes the plans of each requirement (the API field stays; no screen shows it); the legacy unit rules stay in old templates, only the editor stopped editing them.
- Tests: 1,888 tests in 179 files (database and route-permission tests included); typecheck, lint, build, i18n:extract and the responsive check pass.

## 2026-10-19 — Recurrence, academic calendar and cycle plans with inheritance (TASK-081)

Decisions: DEC-029 (items 11 and 12), DEC-002 (no accreditor in code: ABET, WSCUC and ISO cadences are plans and templates), DEC-005 (nothing says met or compliant). No new decision. Migration 0062.
- **A plan makes runs about its own anchor.** A plan on Standard 4 makes one run per subject per period about Standard 4 (which covers its sub-standards); inheritance and opt-out decide which plan a node, and the external requirements mapped to it, show as in effect. Otherwise an external requirement mapped to an IQF node would make a second run of the same cycle. Plans do not inherit down the org chart (a unit or program takes its own plan only).
- **Per template.** A node can have one plan or opt-out per template; resolution is per template (own, else the first not-opted-out plan of its APPROVED mapped IQF nodes in code order, else the nearest ancestor's, else the whole standard's; an opt-out stops that template at the node and below). The source is the ORIGIN ("From Standard 3" for a grandchild), not the immediate parent. Pure and tested in `cycles/plans.ts`.
- **Whole standard.** The IQF as a whole is an anchor of its own kind (`framework`, by framework id); its runs are about the newest published version. A requirement is named by (framework, code) like scope and champion, so plans survive new versions.
- **Engine (`cycles/recurrence.ts`):** pure, takes the calendar as data. A gap is reported only where the horizon reaches past what the calendar defines; the summer between terms is not a gap. A period is proposed while it is under way or begins within the horizon; periods already over are not proposed. `cycle.period_start` (new column) is how a run is matched to its period; `period_label` carries the words.
- **Scheduler:** `listDueRuns` is computed on request (no job; no automatic launch; a template flag may come later, no column now). Skips are rows with a reason. Launching a proposal is `POST /api/cycles` with `planId` and `periodStart`; the previous run is the subject's previous run of the same plan.
- **Decision-dated plans:** `{after: 'previous_ends', setBy: 'decision', dates}`: the person records the next date (`POST /api/cycle-plans/{id}/next-date`); until then the plan says it waits.
- **Wording and lint traps met:** `Plan` and `RecurrenceSchema` already exist in `@ams/shared` (tree moves, framework lifecycle), so the new ones are `CyclePlan` and `CycleRecurrence`; `createTerm`/`updateTerm` exist in the glossary, so the calendar's are `createAcademicTerm` etc. In UI tests the Settings rows are disabled until the person's permissions arrive: wait for the Add form first, and click a button only when it is enabled (the row remounts after each save).
- Tests: core `recurrence.test.ts`, `plans.test.ts`, `plan-service.test.ts`; db `plans.test.ts`; api `plans.test.ts`; web `plans-ui.test.tsx`; responsive pages for the calendar, Due to launch (list, launch dialog, skip), Plans (list, New plan) and the plan dialog, with the Arabic interface.

## 2026-10-19 — Quality Management screens: cycles, cycle page, My work (TASK-080)

Decisions: DEC-029, DEC-005 (approvals read "Internally approved", "Internally approved with conditions", "Returned for changes"), DEC-002 (nothing accreditor-specific). No new decision, no migration.
- **One launch dialog:** `components/cycles/launch-cycle-dialog.tsx` serves "New cycle" and the ⋯ menu; `create-cycle-dialog.tsx` is now a thin wrapper that fixes the anchor to the standard. The API has no dry run, so "show what the rules resolved before it starts" is step 2 of the dialog, after the DRAFT exists: stage unit, owner and approver are editable there (each change is its own request with an Undo toast), then "Start the cycle". Closing after step 1 leaves a draft on purpose.
- **API gaps filled in the list only:** `CycleSummary.nextStage/late/dueSoon` and the filters `due` (late, or ending within 14 days) and `aboutId` (anchor, subject or responsible unit). The page reads a cycle with one request and every mutation answers with the whole cycle, so the page puts the answer in the query cache (`['cycle', id]`) instead of refetching.
- **UI rules:** a missing input is shown, never blocking; Complete explains which required outputs are not final instead of sending a request that would be refused; a completed or skipped stage folds away (its header keeps status, dates and the skip reason); only `canDecide` shows the approval buttons; viewers get `ReadOnlyNote`. `?stage=<id>` (My work links) opens and scrolls to a stage. The list keeps its rows while a filter loads. Dates are calendar days formatted in UTC so no time zone shifts them.
- **Menu:** "My work (N)" next to "My requests", only while N > 0 (`AppLayout` takes an optional `cycles` client for tests).
- **Not done:** reports open in the report editor (TASK-085); cycles anchored to an evidence item, engagement or framework version are not offered in "New cycle" (the ⋯ menus of those come with TASK-083); no drag to reorder the stages of a draft.
- Tests: web `cycles-ui.test.tsx` and `standards-ops-ui.test.tsx`, core `cycles.test.ts`; responsive pages `qm-cycles*`, `qm-cycle-page*`, `qm-my-work` and their Arabic runs.

## 2026-10-19 — Cycle templates in Settings: list, editor, shipped defaults (TASK-079)

Decisions: DEC-029, DEC-002 (defaults are data), DEC-005 (approvals are "Internally approved"). No new decision, no migration.
- **Screens:** Settings -> Quality Management (`/settings/quality-management`, and `/settings/quality-management/$templateId` for the editor). Read-only for everyone with `org:read`; `cycle:manage` edits. Duplicate is a client-side `createTemplate` (key `<key>_copy`); delete of a never-published draft and the other changes answer with X-Undo like the rest of the app.
- **Editor model:** `editor-model.ts` keeps an unfinished copy of the stages; inputs point at outputs by an editor id, so moving stages never breaks them; stage and output keys are made from the name on first save and fixed afterwards (cycles and `previousCycle` inputs refer to them). Only a missing name or number stops a save (the stored Zod shape needs them); everything else saves, and Publish lists what to fix. `validateTemplateStages` runs in the browser and its issues are rewritten in plain words by stage name (`labels.ts`). A missing approver rule on an approval is a note, not a blocker (the launcher may choose one). Removing an output turns the inputs that read it into "something the stage owner picks".
- **Defaults:** `packages/shared/src/cycle-defaults.ts` (data), `installDefaultTemplates(ctx)` in core: idempotent by key, PUBLISHED version 1, origin `default`, never overwrites or restores a template that exists in any status; `POST /api/cycle-templates/install-defaults`. No Undo for the install (published templates cannot be deleted; retire instead).
- **Not done:** drag to reorder stages (up/down buttons only), importing the institution's own templates (TASK-075 engine, later), editing `child` (nesting, TASK-082: preserved, not shown).
- Tests: shared `cycle-defaults.test.ts`, core `cycles/defaults.test.ts`, api `cycles.test.ts`, web `quality-management-ui.test.tsx` and `editor-model.test.ts`; responsive pages `settings-quality-management*`, `qm-template-*` (375/768/1280, no overflow).

## 2026-10-19 — Standards in operation: scope, champion, Create cycle (TASK-086)

Decisions: DEC-029 (the model), DEC-002 (nothing accreditor-specific: inheritance is by tree and mapping), DEC-005 (a scope is where a standard applies, a champion who answers for it; no "met"), DEC-006 (the worker role cannot write these tables). No new decision; the choices below are inside the plan.
- **Data:** migration 0061 (`scope_level`, `requirement_scope`, `requirement_champion`), keyed by framework + code like mappings, so they sit outside the frozen tables and carry to new versions without copying. If the number collides on merge the lead renumbers.
- **Resolution order (external requirement):** own, else the union of its APPROVED mappings' IQF nodes, else its parent's. The mapping beats the parent. A champion is taken from mapped nodes only when every one of them has the same one; if they differ or only some have one the answer is "needs one" (never guessed), and a child below such a node still needs one. Proposed mappings pass nothing.
- **Scope with no list:** Institution, Course and custom levels hold no items (empty = all); a trigger refuses a list there. Course is a placeholder level. A deleted unit or program drops out of a shown list.
- **UI:** the operations live in Quality Management -> Standards (the IQF tree reused, `operational` hides the authoring); Settings -> IQF shows the same menu items plus authoring. The hover cards read the version's one batched requirement-context (now with scope and champion). Create cycle needs a unit or program (the cycle's unit comes from it) and links to /quality-management until TASK-080.
- **Undo:** setting, changing and clearing are undoable; removing several champions at once is not. Program lists follow RLS, so a program-scoped person sees fewer programs in the pickers.

## 2026-10-19 — Quality Management cycles: schema, services and API (TASK-078, no UI)

Decisions: DEC-029 (the model), DEC-005 (approval is "Internally approved", never "met"/"compliant"), DEC-006 (nothing here is AI; the worker role cannot write), DEC-002 (accreditor cycles are template data). No new decision; the choices below are inside the plan.
- **Data:** migration 0059 (`cycle_template`, `cycle`, `cycle_stage`, `cycle_output`, `cycle_input`) with the snapshot of the whole current schema (0055-0058 had none). Beyond the plan's columns: `cycle_stage.unit_unresolved` / `owner_unresolved` and `cycle_output.approver_unresolved` (the "never guess" flags) and `cycle_input.pick_kind` (what a pick may be filled with). Triggers carry the rules (see ARCHITECTURE.md); the worker role is granted SELECT only.
- **Lifecycle:** `launchCycle` makes a DRAFT (stages copied from the template, rules resolved, inputs wired); `activateCycle` starts it; `revert-to-draft` is allowed while no stage has started (the Undo of starting). A cycle completes by itself with its last stage and runs again if a stage is reopened. A draft is deleted to the Trash; anything else is cancelled with a reason (not undone).
- **Templates:** edited only as drafts; `revise` turns a published/retired one back into a draft; publish checks everything and bumps the version (a draft may be saved unfinished, only the shape is checked on save). Managed with `cycle:manage` at the institution (they are institution-wide settings).
- **Who can work:** `cycle:work` or `cycle:manage` for the stage's unit, or being the stage owner; the named approver alone decides an approval (any role, nobody else, also enforced by a trigger). Routes that a plain viewer may legitimately use (own stage, own approval) declare `cycle:read` and the service decides.
- **Approval:** `returned` reopens the stage that produced the outputs the review stage reads (nearest earlier one) and puts those outputs back to draft; the approval stays undecided for the next review. Decisions and cancellations carry no Undo; every other mutation does.
- **Rules that resolve:** unit = the subject's unit / its parent / the one unit of a type (several: the one the subject sits in or under, else unresolved) / the cycle's; person = head of the unit / of its parent / the one holder of a role at the nearest level / the cycle lead. A rule that cannot tell leaves the field empty and flagged. The previous cycle is the subject's latest active or completed run of the same template.
- **Not done here (own tasks):** screens (TASK-080), the template editor and shipped defaults (TASK-079), recurrence/plans/terms (TASK-081), nesting and the Accreditations side (TASK-082), assistant (TASK-084), report engine for `report` outputs (TASK-085: a report slot says "report pending" and may be marked final by hand), the IQF operations (TASK-086). Replacing or removing an uploaded file is not undoable (the old file is deleted).
- Tests: db `cycles.test.ts` (tenant isolation, worker read-only, every guard), core `cycles/cycles.test.ts` (templates, rule resolution including unresolved, wiring, previous-cycle inputs, stage/approval rules, returned-reopens, permissions, Undo, Trash, tenants), api `cycles.test.ts`, shared `cycles.test.ts`, web `lib/cycles-api.test.ts`.

## 2026-10-19 — External requirements: Map to IQF, Link evidence, hover card, one layout (owner request)

Decisions: DEC-016 (mappings and evidence belong to the institution, keyed by code), DEC-005 (no "compliant"/"met"), DEC-006 (proposed, then reviewed). No new decision.
- **Evidence link target:** `evidence_link (internal_framework_id, internal_code)` may now name any framework's requirement code (migration 0058 drops the "internal framework only" insert rule from `evidence_link_rules()`; the immutability of a link's evidence and target stays). Service `linkToRequirement` (alias `linkToInternal`), same routes (`/api/requirements/{id}/evidence-links`); the link DTO's target has kind `external` plus `frameworkLabel` (the accreditor's short name). It works on a published version because links live outside the frozen tables; it starts as proposed and `evidence:review` approves it; Undo = delete (Trash).
- **Batched read:** `requirementContexts()` / `GET /api/framework-versions/{id}/requirement-context` (requires `framework:read`; the evidence parts are empty without `evidence:read`). Inherited evidence counts only through APPROVED mappings and APPROVED links on the IQF item, archived items left out, a piece also linked directly is shown once (as direct). Rejected mappings are not listed.
- **UI:** `MapToIqfDialog`, `RequirementHover`, `RequirementsLayout`; the ⋯ menu shows Map to IQF… to `framework:write` and Link evidence to `evidence:write` on any state of the version. The card opens on keyboard focus as well as hover (not on the focus that a click gives).
- **Layout reading:** the owner described the IQF page as tree-left with a "Select a requirement…" panel; in the code only the external page had a side panel (the source viewer, wide screens only) and the IQF page was cards only. Both now use `RequirementsLayout`; the IQF gets a panel for the selected standard ("Select a standard…"). Say if the IQF should not have one.
- Tests: core (external link, contexts, pending/rejected mappings, Trash), api, db (`evidence-link-targets.test.ts`), web `external-iqf-ui.test.tsx` (menu, dialog with Arabic search, hover card and one request, Loading…, keyboard focus, link evidence, commentary edit, layout class parity), `e2e/responsive.mjs` states `version-external-menu`, `version-map-iqf-dialog`, `version-link-evidence-dialog`, `version-hover-card(-focus)`, `iqf-detail-panel`.

## 2026-10-18 — Org chart: edit on the Chart view (owner request, TASK-072 follow-up)

Decisions: DEC-026, DEC-028. No new business rules, no migration, no new API.
- **What:** people with `org:write` edit the Chart view directly. Drag a box onto another to move it under that unit (target outlined green, or red with the reason for itself or its own sub-units; empty canvas cancels); keyboard path: Space on a focused box picks it up, arrows choose the unit in words, Space drops, Escape cancels. Double-click or F2 renames the English name in a field over the box (`dir="auto"`, Enter saves, Escape cancels; Arabic stays in the drawer). The ＋ on a box (hover or focus; always on touch) adds a sub-unit with its parent's type, which appears expanded and focused. Delete / Backspace on the focused box goes through the drawer's question and the Trash (programs attached: refused with names). Every change is one Undo toast from the server's `X-Undo`. Viewers see the chart as before.
- **How:** the same calls as the Tree and drawer (`move-many` through `orgTreeAdapter`'s optimistic update, `createOrgUnit`, `updateOrgUnit`, `previewDelete` + delete). Where a unit may go is `resolveDrop` (pure helpers `chartDrop`, `boxAt`, `lockedReason`, `defaultChildType` in `chart-model.ts`). The drag chrome is an overlay outside the memoised boxes, marked `data-export-skip`; the name fields are HTML over the SVG, so exports never show them. Zoom and pan are kept across the re-layout.
- **Choices to note:** a click on a box waits 250 ms before opening the drawer (editors only) so a double-click can rename; a locked unit is not moved from the chart (the reason is shown), although the Tree still moves it — the owner asked for the chart rule; say if the Tree should match.
- Learnings: a word selected in the SVG (a double-click selects it) starts Chromium's own drag on the next press and cancels the pointer drag with `pointercancel`; the viewport is `select-none` and refuses `dragstart`. The fitted 300-unit chart is wider than the screen (the fit has a smallest scale), so the e2e drag picks two boxes that are on screen.
- Performance (Chromium, 300 units): box drag at a steady 16.7 ms frame gap (worst 16.8), drop to Undo toast 62 ms; zoom and pan unchanged (16.7 ms).
- Tests: `apps/web/src/org-chart-ui.test.tsx` (inline rename, add sub-unit, Delete with Undo and the programs refusal, keyboard move and the locked refusal, pointer drag with the descendant refusal and empty-canvas cancel, export without the edit chrome, read-only chart), `chart-model.test.ts`; `e2e/responsive.mjs` has chart edit, rename (F2 and double-click), add sub-unit and drop highlight states, the box-drag numbers in the 300-unit run, and `--pages=perf-org-chart-300` to run that check alone.

## 2026-10-14 — IQF and standards in the secondary language (TASK-071)

Decisions: DEC-028, DEC-021, DEC-006. ROADMAP-012. Section D of docs/organization-plan.md.
- **Storage:** `content_translation` (migration 0057), kinds `iqf` / `standard`, fields `title` / `statement` / `note`, keyed by entity id with the framework version beside it. No foreign keys to the entity or version on purpose: the frozen-version triggers guard requirement, requirement_note and the other version tables, so a PUBLISHED version can still receive translations while its English stays immutable; rows also survive the Trash and return on restore (orphans of a purged version are harmless: readers join to the live requirement). Worker limits as `ui_translation` (trigger + column grants).
- **Job:** the TASK-070 engine is unchanged apart from kind-aware permission (`framework:write` for content, `institution:write` for `ui`) and the one-active-run check being per scope. Sources live in `translation/content-source.ts`; services in `translation/content.ts`; routes in `apps/api/src/routes/content-translations.ts`.
- **Unofficial:** a standard's translation is labelled "Unofficial translation" wherever shown; English is only ever hidden in the view, never replaced; quote matching and exports read the English tables only.
- **Not done:** glossary as a source (it already has Arabic columns), report templates and lifecycle labels, carrying translations to a new version's copies, the assistant offering to translate a selection. Migration 0056 is reserved for another change; 0057's journal `when` (1791970000000) must stay later than 0056's.

## 2026-10-14 — Org chart from an uploaded image (TASK-073)

Decisions: DEC-028, DEC-006. ROADMAP-012. Section E.2 of docs/organization-plan.md; the worked image example is section 2.5 of docs/ai-import.md.
- **No new engine, no migration:** the `org_chart` target (`packages/core/src/org/org-chart-import.ts`) uses the reading (vision) model for extraction. The picture is turned into page text by the existing `aiOcr` hook; for documents of the `org_chart` scope the hook now uses the new `ocr` v2 prompt (the chart as an indented outline, one line per box) so the boxes and the tree survive as text the import can cite. `import_org_chart` v1 proposes the units.
- **Honest verification:** nothing can be quote-matched on pixels (the quote is checked only against the model's own outline), so rows are flagged for low confidence, no parent, unclear parent, illegible text; the review shows the image beside the proposals.
- **Apply rules:** match by name (Arabic folded) rather than duplicate; locked or `edited_by_person` units are skipped with the reason; an unedited, unlocked existing unit under another parent is moved; new units go in with `source = 'image'`. Undo = Trash + moves back, Redo = restore group. Note `mark_person_edit` marks every non-worker update, so a moved unit (and siblings the move renumbers) count as person-edited afterwards; the undo check therefore compares names and parents, not that flag.
- Learnings: the PDF test fixture cannot carry Arabic (Latin-1), so Arabic folding is tested through `apply` directly; a worktree needs `pnpm install --offline` before anything runs.
- Tests: `packages/core/src/org/org-chart-import.test.ts`, `apps/web/src/org-chart-docs-ui.test.tsx`; `e2e/responsive.mjs` has the org chart Docs list, Import dialog and review with the image. Not run against a real vision model.

## 2026-10-14 — Documents and AI import foundation (TASK-075)

Decisions: DEC-028, DEC-006, DEC-013, DEC-019. ROADMAP-012. Section A of docs/organization-plan.md; contributor guide docs/ai-import.md.
- **One pattern:** `import_document`/`import_page` registry (migration 0053), scope registry (kind -> permissions, storage, link), target registry (schema, prompt, validate, apply, reverse), `import` job in the agent service, `DocsTab` + `ImportReview` + Settings -> Documents. No production target is registered yet (Programs, TASK-076, is the first).
- **Apply = one undoable group:** the target's `apply` runs as the person in the request transaction; `import_apply` stores the target's `inverse`; `reverse` is its own inverse, so Undo and Redo are the same call. Targets must skip, with a reason, any record a person edited.
- **Candidates:** the worker writes proposals as `candidate = true` (invisible); `propose` releases them. A database guard lets the worker touch only candidates, never decide, edit or apply.
- **Standards:** Settings -> Sources became the version's Docs tab (before Settings); `?tab=settings&section=sources` redirects to `?tab=docs`; the report's source links and the split view's "Open in Docs" open it. The adapter returns `source_document` rows in the shared shape; nothing migrated.
- Learnings: a toast lives 9 s, shorter than the tests' 10 s wait: find it by test id at once. Never `cd` to the shared checkout from a worktree session (an early edit went to /home/user/ams by mistake and was reverted).
- Tests: `packages/core/src/documents/*.test.ts` (invented target `test-target.ts`), `packages/db/src/imports.test.ts`, `apps/api/src/documents.test.ts`, `apps/web/src/docs-ui.test.tsx`; `e2e/responsive.mjs` has the Docs tab, import dialog, review, report and Documents states.

## 2026-10-14 — Org chart visual builder (TASK-072)

Decisions: DEC-028, DEC-026. ROADMAP-012. Section E.1 of docs/organization-plan.md.
- **Data (migration 0054):** unit types are rows (`org_unit_type`, per institution, seeded by a trigger on `institution`), and `org_unit.type` is their key through a composite foreign key, so a type in use cannot be removed. `org_unit` gained `source`, `locked`, `display_order`, `head_user_id` / `head_name`, `description` and `edited_by_person` (the existing `mark_person_edit` trigger), the hooks for the image import and directory sync (not built).
- **One tree layer, two trees:** `components/tree/tree.tsx` now takes a `TreeAdapter` (query key, depth limits, how to move and delete, the optimistic update, words); the requirement trees pass `requirementAdapter`, the org chart passes its own. Moves reuse `planMoves` / `planPlacements`; deleting a unit with its subtree goes to the Trash (kind `org_unit`) and is refused while programs are attached.
- **Chart:** `layoutOrgChart` is pure (tidy tree; leaf sub-units hang in one column, which is what keeps 25 departments with 6 sections each readable instead of 30,000 px wide). The drawing is an SVG with inline attributes only, so the same markup is the export; PNG is drawn client-side at 2x (less for huge charts, canvas limits). Print uses a sheet appended to `body` and a named `@page` (landscape), one PDF page.
- Learnings: a Dialog button named "Close" appears twice (the X and the footer) so tests pick the first; a form that opens before its data loads must derive defaults at submit time, not in `useState`; headless Chromium needs `window.print` stubbed and `emulateMedia('print')` to produce the sheet's PDF; SVG boxes shrunk by a 3% fit cannot be clicked by Playwright, dispatch the click.
- Performance (Chromium, 300 units): tree open about 0.5 s, select all 83 ms, chart open 97 ms with 182 boxes, expand all (300) 74 ms, zoom and pan at a steady 16.7 ms frame gap, SVG export 117 ms, PNG 332 ms, 1 PDF page.
- Tests: `packages/shared/src/org-layout.test.ts`, `packages/core/src/org/org-chart.test.ts`, `apps/api/src/org-chart.test.ts`, `packages/db/src/org-chart.test.ts`, `apps/web/src/org-chart-ui.test.tsx`, `chart-model.test.ts`; `e2e/responsive.mjs` has the org chart states and the 300-unit run. The `org_chart` document scope points at the Institution tab until its Docs tab (TASK-073).

## 2026-10-14 — Languages: secondary language, interface language, translate job (TASK-070)

Decisions: DEC-028. ROADMAP-012. Section D of docs/organization-plan.md (the interface half; content is TASK-071).
- **Data model:** `institution.secondary_language` (nullable, registry code), `default_locale` kept but now "default interface language" (`en` or the secondary; existing `ar` became secondary `ar`), `app_user.ui_locale`, `ui_translation`, `translation_run` (migration 0057, numbered apart from other work; the lead renumbers on merge). Triggers: a person's language must be en or the secondary; changing the secondary clears others' choices and fixes the default; the worker may write only unreviewed AI `ui_translation` rows.
- **Generic job:** `translate` (agent group, compose `WORKER_QUEUES`), kind `ui`; `TranslationSource` registry (`translation/register.ts`) is where TASK-071 adds kinds. One job = one batch; run row holds cursor, progress, usage, set-aside items; a spend stop is `stopped` and Resume gives a fresh allowance (`report.spendBase`).
- **Honest coverage:** the app had 15 `t()` calls against about 1,700 hard-coded literals (0.9%). Converted the shell and shared chrome; now 11.1% (docs/i18n-coverage.md, `pnpm i18n:coverage`). The version pages and the org chart section were left alone because other work is in them. A warning-level lint rule protects converted files.
- Learnings: a CHECK like `a = 'en' OR a = b` passes when b is NULL (use `IS NOT NULL`); `GRANT EXECUTE ON ALL FUNCTIONS` in a later migration re-grants functions earlier migrations restricted (the Trash tests caught it); i18next's `changeLanguage` is not synchronous, so Intl helpers read their own current-locale variable; the e2e Arabic pass seeds generated Arabic of 1.4x the English length (stresses layout, not meaning).
- Tests: `packages/shared/src/languages.test.ts`, `packages/db/src/languages.test.ts`, `packages/core/src/translation/translation.test.ts`, `apps/api/src/languages.test.ts`, `apps/web/src/languages-ui.test.tsx`, `i18n-extract.test.ts`, `lint-rules.test.ts`; `pnpm test:responsive` has Arabic and Chinese passes (`--pages=languages` for only them).

## 2026-10-13 — Organization tabs, institution logo, read-only Settings (TASK-069)

Decisions: DEC-028. ROADMAP-012. Step 1 of docs/organization-plan.md.
- **Organization** is one screen with two tabs (`?tab=institution|programs`, keyboard tablist); Institution holds Details, Logo and the org units editor as "Org chart"; Programs is the old Programs page. `/settings/programs` redirects; the Settings menu lost Programs.
- **Institution logo:** same rules as the accreditor logo, now one helper (`framework/logo-image.ts`) both use; migration 0052 adds `logo_path/mime/updated_at`; `PUT/GET/DELETE /api/institution/logo`; replacing or removing deletes the old object after commit. Shown in the sidebar, the small-screen bar and drawer, and the sign-in page (falls back to the name; alt text is the name).
- **Public route:** the sign-in page needs the name, accent and logo before authentication. `GET /api/public/branding` and `/logo` read one SECURITY DEFINER function that returns nothing unless exactly one institution exists. Exposure documented in docs/organization-plan.md and ARCHITECTURE.md.
- **Settings for every role:** the Settings entry shows for `org:read` (every role but external reviewer); read-only pages show "You can view this; ask an administrator to change it." No role definition changed (the roles are in code, `ROLE_PERMISSIONS`, not in the database).
- Learnings: TanStack parent routes pass the raw `search` through to children, so an invalid `?tab=` must be dropped in the component as well as in `validateSearch`; `app.request` tests need the app's `fetch` in place before `lib/api` is imported (a hoisted delegate).
- Tests: `apps/api/src/institution-logo.test.ts`, `packages/core/src/org/institution-logo.test.ts`, `packages/db/src/public-branding.test.ts`, `apps/web/src/organization-ui.test.tsx`; `e2e/responsive.mjs` has the new tab and logo states.

## 2026-10-12 — Redo in the undo system (TASK-065)

Decisions: DEC-026, DEC-027. ROADMAP-012.
- **Redo is the same mechanism run again.** Every undo descriptor points at an ordinary endpoint that already reports how to reverse itself, so the answer to an Undo is the redo. The client marks the request (`X-Replay: undo|redo`); the chain tags the reported descriptor `kind: 'redo'|'undo'`. No service changed its reporting, except: a restore now reports the delete again (`trash/redo.ts`, built from the payload before `markRestored` empties it), and `unsplit` reports a re-split last (a restore of the split-out requirement would have left the original's text whole). Merge now records `useMergedWording` so it can be merged again.
- **Client:** per-screen redo stack (20) beside the history, cleared by any successful non-GET that is not an undo/redo; toast "Undone: ... Redo"; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y outside text fields; a refused redo shows the server's reason and stays on the stack.
- Learnings: redo of a split makes a new requirement id (unsplit trashed the old one); a restore from the Trash page now offers its own Undo (delete again). Redo that would not fit the 6000-byte header is simply not offered.
- Tests: `apps/api/src/redo.test.ts`, `apps/web/src/redo.test.tsx`, `packages/core/src/trash/redo.test.ts`. Pattern written up in `docs/trash.md`.
## 2026-10-12 — In-app assistant, phase 1 (TASK-066)

Decisions: DEC-027, DEC-006, DEC-010, DEC-012, DEC-024. ROADMAP-012.
- **Built:** bubble and panel, conversations per person, `assistant` job (agent service) running as the person, read-only framework tools plus `propose_memory`, scoped memory with confirmation, Settings -> Assistant role and memory page. No write tools.
- **Progress while a turn runs:** the job's own transaction would hide it until commit, so `Ctx.detached` runs a short separate transaction as the same identity; each tool step is saved that way and the panel polls once a second.
- **Privacy:** audit rows for conversations and memory hold metadata only, so deleting a conversation really deletes what was said; private memory is invisible to everyone but its author, including administrators and the worker; the worker cannot write memory.
- **Memory retrieval is by words only.** Embedding memory text needs a DEC-023 amendment first (embeddings are limited to framework text).
- Not done: phase 2 (bulk edits), the nightly memory clean-up, a chip for the report tab's run.

## 2026-10-11 — Analysis report, run readiness and the import checkbox removed (TASK-054, step F1)

Decisions: DEC-022, DEC-005, DEC-006. ROADMAP-009.
- **The report is computed, not stored:** `getAnalysisReport` joins the run's record with the live draft, so it follows edits; only usage, duration and the run's own stats are frozen. A gap about a requirement a person deleted drops out. The conflict gap now keeps both wordings (`variants`) and each job records the models in use under `report.runtime`; older runs show them as not recorded.
- **Wording:** counts only. "n of m quotes found in the source (x%)", never a score or verdict; a test scans the DTO and its Markdown for compliant / met / score / readiness / predict. The Markdown builder is in `@ams/shared`.
- **Readiness checks** never decrypt-and-show a key; a key that cannot be decrypted is a blocking problem. No parser heartbeat exists, so that check was skipped.
- **Import:** `autoApprove` is gone from `importVersion`, the API and the page (DEC-022: pending line by line, publishing is the review). Seeds and fixtures no longer pass it.
- Not done: "Create from files" and the source viewer (other agent); a real printed-PDF check.

## 2026-10-11 — Switched to the owned @drmoyassine/liteparse; upstream kept only as a fallback (TASK-053, DEC-011)

Decisions: DEC-011 (amended again). ROADMAP-008.
- **The TASK-052 entry below describes the wrong package.** Steps A–D used the unrelated `@llamaindex/liteparse` (PDFium + LibreOffice). The owner chose the owned `@drmoyassine/liteparse` 0.5.0 (https://github.com/drmoyassine/liteparse): pure JS, pdfjs-dist for PDF, mammoth for DOCX, SheetJS for XLSX/CSV, injectable raster, OCR and vision gateway. Written up in `docs/liteparse-appendix-d-status.md` (per LP1–LP10 and D.3 case: met / partly / not met, what the AMS wrapper does, and the changes to make in the liteparse repository, by importance).
- **Learnings about the library** (all by experiment): a digital PDF comes back as ONE page; scan-or-digital is decided once from the first three pages (a scanned page 1 sent all three pages to the vision model); native text has no line breaks, so words fuse across lines; DOCX and Office files are one page; the multi-sheet XLSX is `# Sheet` + CSV; RTF and unknown kinds are decoded as text and, with a vision gateway set, sent to it; UTF-16 CSV is taken for audio and BOM-less UTF-8 CSV is read as Windows-1252; the README's "diacritics are stripped by default" is about speech only (documents keep tashkeel); it never normalises to NFC; `@napi-rs/canvas` 1.x breaks pdfjs 4.10 page rendering (0.1.100 works); its `xlsx` dependency is a cdn.sheetjs.com tarball (blocked by the egress proxy: overridden to `@e965/xlsx@0.20.3` on npm).
- **The wrapper's trick:** `parseDocument()` opens the PDF with pdfjs itself and gives liteparse an injected pdfjs that shows ONE page, so classification, extraction, rendering and escalation happen per page with true page numbers; the vision hook is its `vlm` gateway. Costs two text extractions per page and no process isolation (timeouts are cooperative).
- **Formats it lacks** (PowerPoint, OpenDocument, RTF, legacy DOC/XLS) keep working through `parse-document-fallback.ts`, the only user of the upstream package and of LibreOffice; ImageMagick is gone from the parser image. Delete the fallback when the owner's library reads them.
- **Local OCR (RapidOCR) was not enabled:** it needs `onnxruntime-node` (install fetches from nuget) and three model files (Hugging Face), both unreachable here, and its model is English only. `PARSER_LOCAL_OCR=rapidocr` exists, off.
- Not verified: the Docker build; the D.3 documents; a real vision model. After the first deploy check `docker compose logs parser` for "libreoffice found", then read a text PDF, a scanned PDF, an Arabic DOCX, a two-sheet XLSX and a PPTX and check the job result's `parser` field.

## 2026-10-11 — Every format is read by liteparse; the parser image gets LibreOffice (TASK-052, DEC-011)

Decisions: DEC-011 (amended), DEC-008.
- **Owner decision reversed the TASK-043 shortcut:** `parseDocument()` no longer has its own DOCX/XLSX/PPTX/CSV readers or `fflate`. liteparse reads every format; for non-PDF it converts with LibreOffice (found as `soffice`/`libreoffice` on PATH). Only the `parser` image installs LibreOffice (writer, calc, impress), ImageMagick and Noto/Liberation fonts. Learning: the sandbox had `libreoffice-core` alone, which silently fails every conversion ("source file could not be loaded"); writer, calc and impress are separate packages.
- **What liteparse returns:** pages are the printed pages of the converted PDF. DOCX/ODT/RTF: pages by page break; spreadsheets: a page per sheet, but a wide or long sheet continues on further pages (print layout), and tables are space-aligned text, not `a | b`; presentations: a page per slide, speaker notes are not included; images: one page, no text, flagged `scanned` (so OCR via the hook). CSV/TSV are not recognised from bytes (liteparse sees `.txt` and refuses), so the bytes go in as a temp `.csv`, with `;` and tab delimiters rewritten to commas first because LibreOffice split on commas only here.
- **Arabic got worse for Office files:** the converted PDF's words come back in visual order and with lam-alef pairs swapped (a native-PDF limitation of liteparse that already applied to Arabic PDFs). Letters are all there; word order is not reliable. Quote matching (which normalises) can miss a verbatim Arabic quote from a DOCX; OCR of the page image through the hook is the way round it and is not applied automatically because the page has a text layer.
- **needsOcr** now comes from liteparse's per-page reasons: `scanned`/`garbled`, or (PDF and images) under 20 characters. `sparse-text` alone is ignored because liteparse flags nearly every normal short page with it; `embedded-images`/`vector-text` give a warning only.
- **Failure is a typed `DocumentReadError`** (unsupported, corrupt, converter_missing, timeout) recorded by `extract_text` as failed with the reason. Each file is parsed in a killable liteparse worker process (`PARSER_TIMEOUT_SECONDS`, `PARSER_MAX_PAGES`). Legacy DOC, XLS, PPT, plus ODT/ODS/ODP, RTF, TSV and PNG/JPEG/TIFF/WebP/BMP/GIF are now readable too.
- Not verified: the Docker build (no registry here). After the first deploy check `docker compose logs parser` for "libreoffice found", then read a DOCX, an XLSX and an Arabic DOCX from the Sources screen.
## 2026-10-11 — Settings -> AI redesigned around accounts (TASK-051, DEC-025)

Decisions: DEC-025 (new), DEC-012, DEC-023, DEC-008. ROADMAP-009.
- **Credentials and choices are separate now.** `ai_account` holds a label, provider and an encrypted key (write-only, last 4 shown); `ai_setting` says which account + model each role uses (analysis, reading/vision, embeddings) and holds the one cap. Switching OpenAI <-> Gemini is a dropdown; the same OpenAI account serves analysis and embeddings. OpenRouter is a provider of its own (fixed address, same openai-compatible package, `model.ts` still the one import point).
- **Nothing the person cannot know is asked for.** Model ids come from the provider's own list (server side, metadata call, 10-minute cache, typed-id fallback); the embedding vector size is found by a probe call; prices are never typed: a USD cap exists only where the list publishes the price (OpenRouter), otherwise the cap is tokens. Learning: kind classification must trust the provider's metadata (Google `supportedGenerationMethods`, OpenRouter modalities) and use id heuristics only as a fallback.
- **Reading finally has settings.** OCR on/off, an optional separate vision model, a per-file page cap (pages beyond it are not even rendered) and a language hint. The hint overrides the source language because every source has one (default English), so a fallback-only hint would never apply. Learning: with a different reading account that has no key, the analysis must still run; the runtime carries `visionError` and `extract_text` leaves pages flagged with the reason.
- **Migration 0045 moves, it does not re-encrypt.** The old connection and embeddings endpoint become accounts with the ciphertext copied as is (same `APP_SECRET`), legacy key columns are cleared, legacy columns stay unused. Tested against a database built to 0044 and seeded old-style. Pre-existing hazard noticed: migration 0044's journal `when` is earlier than 0043's, and drizzle skips migrations older than the last applied one, so a database that had 0043 but not 0044 would skip 0044; check `iqf_item_proposal` exists on deployed databases.
- Not verified against real providers (no network here); the list and embeddings shapes are tested from fixtures and stubbed requests.

## 2026-10-11 — Three background services; the app prepares Garage (TASK-049, DEC-024)

Decisions: DEC-024 (new), DEC-010, DEC-011, DEC-012, DEC-008.
- **One worker became three:** `worker` (export, notify), `parser` (extract_text), `agent` (analyse, ai_extract, ocr). Same code and entry point; `WORKER_QUEUES` picks the job types, `QUEUE_GROUPS` in `packages/shared` is the single table, and a test parses `compose.yaml` to keep them equal. Unset `WORKER_QUEUES` still means every type, so local dev and tests are unchanged.
- **The agent no longer reads files.** The analysis `read` stage queues `extract_text` for the parser and waits by re-queuing itself (5 s, at most 360 looks); the pending job is kept in the run report. Learning: a retried job must not queue the reading twice, so the queued job id is recorded in the same transaction as the enqueue. Scanned-page OCR stays inside `extract_text` (liteparse hands each page image to the hook while parsing), so the parser makes the model call for it; separating it would mean re-parsing in the agent. It degrades to `needsOcr` without a provider.
- **Garage setup moved into the app:** `garage-init` (a one-shot compose service that Easypanel handled badly) is gone; `bootstrapGarage` runs before the API serves when `GARAGE_ADMIN_URL` is set and stops the start on failure. The simplest robust wait order: the three services depend on `app: service_healthy`, and the app is healthy only after migrations and the bucket exist, so nothing else needs a shared step. The app health check got a 180 s start period for that reason.
- Not verified on a live stack (no Docker daemon here); CI `compose-smoke` is the check.
## 2026-10-11 — Analysis proposes links to the IQF and new IQF items (TASK-050)

Decisions: DEC-006, DEC-021, DEC-022, DEC-023. ROADMAP-009 step E.
- **Same job chain, three more stages:** `embed`, `map`, `propose_new` run after `write` and before `finalise` (no new job type; the `agent` service still runs `analyse`). Code lives in new files (`mapping-stages.ts`, `shortlist.ts`, `iqf-context.ts`, `mapping/proposals.ts`); `stages.ts` only routes to them and sends a spend-limit stop in these stages to `finalise` (the mapping ends, the run does not fail).
- **Ranking never decides.** Shortlist = words (in-core BM25 over normalised, stemmed tokens with the Arabic folding of `quote-match.ts`, title containment, explicit code references) fused by rank with vector similarity when embeddings are on; padded with top-level IQF items when too few words match. The model judges each candidate (`map.v1`); similarity numbers are kept nowhere. No pg_trgm: the in-core scorer needs no extension (DEC-008).
- **Proposals look like proposals.** Links reuse `requirement_mapping` (origin `ai`, review `pending`, reason in `rationale`); new items are `iqf_item_proposal` rows. Migration 0044: the worker can only insert pending proposals and refresh untouched ones (guard triggers, same style as 0039/0041); `edited_by_person` on links; the worker guard now also refuses the internal framework, so the worker can never write the IQF; the publish gate's "AI item needs a source page" is for external standards only (an accepted IQF item has none; the IQF still needs every item approved).
- **The demo data has no external-to-IQF mappings** (only glossary terms), contrary to what the brief assumed, so the evaluation set is hand-labelled: 64 pairs in `packages/core/eval/mapping-labels.json`. Lexical recall@10: 48.4% overall (WSCUC 68.6%, ABET 77.8%, Arabic PUC 0.0%). The Arabic number is the case for embeddings; the hybrid number still needs a real endpoint (`pnpm analysis:eval-mapping` with `EMBED_*`). Accreditor names are not allowed in `packages/*/src` (DEC-002 test), so the labels are data outside `src`.
- **Learnings:** a re-run must pre-check what the database guard would refuse (a refused update aborts the step's savepoint); the IQF has a fixed depth (its level names), so a new item proposed under the deepest level goes under its ancestor; accepting a proposal needs both `framework:review` and `framework:write`.

---

## 2026-10-10 — Settings -> AI: more providers than Anthropic (TASK-048)

Decisions: DEC-012 (switching provider is configuration).
- **The limit was ours, not the SDK's:** only `@ai-sdk/anthropic` was installed and the provider was shown as fixed text. Now `anthropic`, `openai`, `google` and `openai_compatible` (Base URL: OpenRouter, Ollama, vLLM, LM Studio, Azure ...) are choices; `model.ts` stays the only place a provider is chosen and the only importer of the provider packages (the import-point test now says so).
- **A saved key belongs to its provider.** Switching provider removes it unless a new key arrives in the same save (the safe option over "require re-entering later", because the old key must never reach another company). Migration 0043 adds `ai_setting.base_url` (only `openai_compatible` may hold one) and widens the provider check.
- **Environment fallback is per provider:** `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `AI_BASE_URL` beside `ANTHROPIC_API_KEY`; another provider's variable is never borrowed. An OpenAI-compatible server may run without a key.
- Learning: OCR already degrades safely. A model that rejects images raises `AiCallError`, `parseDocument` turns it into a warning and the page stays `needsOcr`. For `openai_compatible` the schema only reaches the model if `supportsStructuredOutputs` is on, so it is.

---

## 2026-10-10 — Publishing is the review for external standards (TASK-047)

DEC-022 applied to the publish gate. Decisions: DEC-006, DEC-022.
- **The old rule lived only in the database:** `enforce_publish_gate()` (0005) demanded every requirement and note approved. Core never checked review status; the UI added per-line Approve/Reject and review badges. Migration 0042 replaces the function body: for an external standard pending rows publish (a rejected row still blocks); the internal quality framework keeps the 0005 rule. Required-note quote and AI source-reference checks stay for both. No rows are mass-approved; `published_by`/`published_at` is the approval, and pending AI rows are frozen as pending.
- **Validation now covers content, not just configuration,** for external versions: a `required` note without a verified quote (and a rejected line) is a blocking issue; requirements whose quote was not found are a non-blocking `warnings` entry on the validation result and API. The version page shows warnings in a softer banner below the amber problems banner.
- **UI:** external requirement cards and notes show provenance only (AI marker, page and quote, "Quote not found in source"); `ai_suggested` reads "Suggested by the analysis (not confirmed in the source)". The IQF's own requirement view (RequirementsTab) keeps its approve/reject, and `NotePanel` takes `perLineReview` to tell the two apart.
- Learning: the analysis writer and the gap finder treat any non-pending row as a person's (`reviewStatus !== 'pending'` locks it), so seed data imported with `autoApprove` stays locked against re-runs even though the UI no longer shows the label.

---

## 2026-10-09 — Framework analysis check and recover: exhaustive but bounded (TASK-046)

Step D of the framework analysis pipeline. Decisions: DEC-002, DEC-006, DEC-012, DEC-022.
- **Two new stages, same chaining:** `gaps` (cursor = the round about to be asked; no model call) and `recover` (cursor = the question group; one `aiExtract` with `recover.v1`). Recovery answers are Appendix B items logged in `extraction_item` with `payload.round` and `payload.gap`, so the next check and the writer read them exactly like the extraction's. Window numbers from 1,000,000 keep their temp ids apart; their `seq` sits next to the gap's neighbour, so a recovered 2.3 lands between 2.2 and 2.4.
- **Gap finder is pure and accreditor-blind** (`analysis/gaps.ts`): codes are split into prefix words and parts (numbers in any digit script, letters, roman); siblings share prefix, parent parts and depth; "i"/"v"/"c" are read from the siblings, then from the structure stage's numbering examples. Holes over 3 are jumps; a leading hole needs a series. Pages are "substantive" by a cheap heuristic (≥ 40 words, not mostly lines ending in page numbers, not a contents/index heading, not the continuation of the item before).
- **Stopping:** no open gaps, nothing to ask, the round limit (`ai_setting.max_recovery_rounds`, default 2, snapshot per run), a round that raises neither the verified count nor the confirmed-absent count, or the spend limit. `BudgetExceeded` in `recover` ends the recovery, not the run: the next check closes the round and the run writes and succeeds (`report.recovery.stopped = 'budget'`).
- **Merge now prefers a copy that checks out** (quote found, wording on the page) before the longest one, so a re-cited copy replaces an unverified one.
- **Deletion memory is a trigger** (`record_ai_dismissal`, AFTER DELETE on requirement and requirement_note), like `mark_person_edit`: every delete path counts. It stores the note's raw text; the fingerprint is computed in core (`noteFingerprint`), which owns normalisation. The worker cannot write it.
- **Bug fixed in passing:** `markFailed` runs after the job's transaction rolled back, so the attempt `markRunning` counted was lost and a step that kept failing never reached `MAX_ANALYSIS_ATTEMPTS`; `markFailed` now counts it.
- **Gotchas:** a job envelope has no payload (read the job row); the AI SDK does not retry a plain `Error` from the fake model; jsdom blocks a form submit when a number input is outside its `min`/`max`, so test the API for out-of-range values.

---

## 2026-10-09 — Framework analysis runs: requirements from a draft's sources (TASK-045)

Step C of the framework analysis pipeline. Decisions: DEC-006, DEC-012, DEC-013, DEC-022.
- **Job chaining:** one job type `analyse` with `{runId, stage, cursor}`; each step is its own transaction and queues the next. `runJob` used to forbid this (`noQueue`, throwing `afterCommit`); it now collects `afterCommit` hooks and runs them after the commit, with the queue the worker passes (`pgBossQueue`). The run row is the cursor: a job that does not match the run's stage and cursor is a no-op, so pg-boss retries resume cleanly.
- **Savepoints, not `tx.transaction()`:** our `Tx` is a `drizzle(client)` inside `withIdentity`'s BEGIN; calling `.transaction()` on it would issue a second BEGIN/COMMIT. Steps run under `SAVEPOINT analysis_step` so a failed step can still mark the run failed in the same job.
- **Budget across jobs:** each job seeds `AiBudget` from the run's persisted usage. A call the budget refuses is logged but not counted as a call.
- **Human edits win via a trigger:** `edited_by_person` is set by `mark_person_edit` on any update by a role other than `ams_worker` (so every existing and future edit path counts) and the worker guard refuses to touch such rows. Origin stays `ai` (PRD 16).
- **reviewStatus stays `pending`** for AI rows: it is the only value that does not claim a person looked; the worker cannot write review columns at all. The existing publish gate still wants approvals, so DEC-022's gate change is left to step F.
- **Gotchas:** PL/pgSQL does not short-circuit `TG_TABLE_NAME = 'x' AND NEW.col` (nest the IFs when the column exists on one table only). Drizzle renders `${table.column}` inside a correlated `sql` subquery as a bare column name, which binds to the inner table: write the outer table name literally. `now()` is per transaction, so rows created in one transaction tie on `created_at`; order with a tie-breaker.
- **Quote normalisation now folds ة/ه, ى/ي, hamza seats and Arabic-Indic digits** for notes too (`quote.ts` delegates to `quote-match.ts`).

---

## 2026-10-08 — The AI connection, embeddings and Settings → AI (TASK-044)

Step B of the framework analysis pipeline. Decisions: DEC-012 (one import point), DEC-021 (IQF text may go to the AI), DEC-023 (embeddings).
- **One import point:** `packages/core/src/ai/index.ts` is the only file that imports `ai`. `aiExtract`, `aiOcr` and `embed` run only inside an AI scope that `runJob` opens around each handler (and the settings connection test opens for itself); elsewhere they throw `AiScopeError`. A test checks no other file imports the SDK and the API and SPA never call them.
- **AI SDK 7:** `generateObject` is deprecated there, so structured output uses `generateText` with `Output.object({ schema })`; images go as `file` parts.
- **Per-run log and budget:** each call is appended to `runtime.calls` (task, prompt version, model, tokens, ms, ok/error, cost) and written as one JSON line; handlers store `runtime.calls` in `job.result`. `AiBudget` throws `BudgetExceeded` before a call that would pass the token or cost limit, and caps the output to what is left. Embedding tokens count; they are not priced.
- **Settings:** `ai_setting` (migrations 0036-0037) and Settings → AI (admin only, permission `ai:manage`). Keys are AES-256-GCM encrypted with a key derived from `APP_SECRET` (else `AUTH_SECRET`); changing the secret makes saved keys unreadable, so they must be typed again. The API returns only "configured" and the last 4 characters. A cost limit needs both token prices.
- **Test connection** is the one model call outside the worker: a fixed tiny prompt, no institution data.
- **Embeddings (DEC-023):** separate OpenAI-compatible endpoint, off by default. The `embedding` table (owner type CHECKed to `requirement`) holds vectors as `real[]`; `upsertEmbeddings` re-embeds only on a new text hash, model or dimension; `rankBySimilarity` is an exact cosine scan in TypeScript. The score only orders a shortlist; it is never shown as a match, coverage or confidence.
- **OCR wiring:** `extract_text` passes `aiOcr` to the reader when AI is on, so scanned pages are read within the run's budget; with AI off they stay `needsOcr`.
- **Tests never reach the network:** `setAiModelForTests(createFakeAiModel([...]))`, `setEmbedderForTests(createFakeEmbedder())`.

---

## 2026-10-08 — Source files are read into page text (framework analysis, step A)

`parseDocument()` (`packages/core/src/framework/parse-document.ts`) is now the single point that reads a file into pages (TASK-043, DEC-011). Learnings:
- **liteparse is `@llamaindex/liteparse`** (the unscoped `liteparse` name is not on npm). It installs a native PDFium binding and parses PDF bytes offline; its OCR is switched off because OCR belongs to Step B (`aiOcr` through the `ocrPage` hook). Its non-PDF support needs LibreOffice, so DOCX/XLSX/PPTX/CSV are read directly with `fflate` and a small XML reader instead; nothing outside Node is required in the worker image.
- **The worker has no object store unless `runJob(..., { store })` is given one**; `apps/worker/src/main.ts` passes `s3Store(env)`, which moved to `packages/core/src/evidence/s3-store.ts`.
- **The worker role cannot read `role_assignment`**, so job handlers must not call permission-checked services (`readSourceFile`); use the permission-free loaders. The person's permission is checked when the job is queued.
- **A page is overwritten by a re-read only if `from_file` and not `reviewed`.** Pages that existed before migration 0035 have `from_file = false` on purpose (a blanket UPDATE would have hit the published-version immutability trigger).
- `pnpm db:generate` needs `pnpm --filter @ams/shared build` first.

---

## 2026-10-08 — The app works on phones and tablets

Three agents worked in parallel on separate files; the work was merged and checked here.
- **App shell:** below `lg` the sidebar becomes a slim top bar with a ☰ drawer (Escape, backdrop and following a link close it; focus moves in and back). Page padding is smaller on phones.
- **Settings menu:** it is one sideways-scrolling row, and so is a standard's own Settings section menu. Their Details form is one column on phones.
- **Shared card:** it lays itself out by its own width (container query). A narrow card gives the title a full line, with counts and badges on a second line, and long words wrap. Hover tooltips are capped to the screen and hidden on touch screens. The review badge becomes a dot and one word on phones.
- **Tables:** they scroll inside their own box.
- **Dialogs:** every dialog now uses one shared component that fills the screen on phones, with the title and ✕ pinned at the top. Escape closes only the topmost dialog.
- **Page headers:** they stack (title, then version, status and date, then actions), and toolbars wrap or scroll. Engagement phase and key-date cards wrap.
- **"Version Version 2019-V2":** fixed by a shared `versionLabel`.
- **New check:** `pnpm test:responsive` boots the real app on a fresh test database, signs in with Chromium, screenshots 13 screens at 375, 768 and 1280px, and fails on any sideways scroll. Before the fixes it found 14 overflowing page/width pairs; after them it found none.
- **Note:** one agent hit a usage limit after committing its work but before its final checks, which were then run here.

---

## 2026-10-08 — Evidence as cards; requests under Evidence and My requests

The Evidence page now uses the same closable cards as standards and requirements (built in parallel by a delegated agent and merged here).
- **Closed card:** a tile showing what the item is (PDF, DOC, XLS, DATA, LINK), the title (description on hover), and on the right: how many places it is linked to, an amber "N to review" when links wait for approval, the latest version and date, rows, form state and new responses for data, and "Not linked", "Open request" or "Archived" when they apply.
- **Opened card:** description, versions, what it is linked to (approve or reject there), form requests, and for data the Sheet, Form and Responses inside the card.
- **⋯ menu, by type:** Upload a new version or Open sheet, Link to a standard, Request an update or Ask people to fill in the form, Download latest, Edit details, Archive or Restore.
- **Above the list:** filters (All, Documents, Data, Not linked, To review, Archived).
- **Requests:** they are a second tab on Evidence (all requests, open first). /requests became My requests, and the sidebar shows "My requests (N)" only while someone has open requests.
- **Server:** the list carries proposed-link, open-request, form and pending-response counts (grouped queries) and leaves archived items out unless asked. A type change is refused when it would orphan files or data.

---

## 2026-10-08 — Requirement wording is the description; titles that hold wording are corrected

On external standards, the field that was called "Official text" is now labelled **Description**: in the requirement dialog, on the card and in its tooltip (the data is unchanged; it is still the requirement's own wording, verbatim from the source). The owner found a PUC draft whose indicators had their wording in the title and no description. None of the seed files (PUC, ABET, WSCUC) has that shape, so it came from that draft's own history. One generic rule now puts it right: when a requirement has no description and its title reads as wording (a sentence, or more than 60 characters), the wording becomes the description and the code becomes the title. It is applied on import, when a new version is copied from an existing one, and by migration 0034 to existing draft and in-review versions of external standards. Published and retired versions stay frozen; starting a new version from one gives a corrected copy.

---

## 2026-10-08 — Sources move under Settings, with their originals and pages

A standard's page now has three tabs: Requirements, Mappings and Settings. Sources moved into Settings, between Details and Lifecycle. Each source is a card with readable labels ("Policy and procedure · Binding", not codes), its page count, and whether its original is held. Inside are the original file (uploaded to the object store, opened inline when it is a PDF) and the pages: pick a page to read its text, or on a draft correct it, remove it or add the next one. On a draft, the ⋯ menu edits a source, uploads or replaces its file, or deletes it. A source a note cites cannot be deleted, nor can a quoted page, because quote verification reads exactly that text. A published version's sources stay fixed (the existing freeze trigger), and a new version copies them. Migration 0033 adds file name, type and size. The owner asked for a full document parsing and intelligence pipeline here: that is M7, the framework compiler (ROADMAP-009: upload, classify, parse, AI extraction with quote verification, side-by-side review, publish), gated by the liteparse track (ROADMAP-008). Sources with their originals are what it will read; until then, page text is pasted by hand.

---

## 2026-10-08 — A standard's page: its name in the header, four tabs, details editable

A version page now has a header with the standard's name, its accreditor and scope, the logo, a version picker, and the one action the version's state calls for: Submit for review (draft), Publish (in review) or Start a new version (published). Download JSON, Return to draft and Retire are in its ⋯ menu. Configuration problems show as a banner instead of on a tab. The tabs went from seven to four: Requirements, Mappings, Sources and Settings. Settings holds Details (the standard's name, scope and description; the accreditor's name, short name, type, country and website; the logo), Lifecycle and vocabularies, Report templates, and Terminology. Details belong to the standard, not to a version, so they stay editable while its versions are published (new `PATCH /api/frameworks/{id}` and `PATCH /api/accreditors/{id}`; the internal framework is refused there). On the External Standards page the card's ⋯ menu is now Open, Edit details (which opens Settings → Details), Start a new version and Import a new edition; the logo moved to Details.

---

## 2026-10-08 — External Standards as cards, with accreditor logos

The External Standards page now shows one card per standard, built on the same accordion as the other requirement lists. The closed card has the accreditor's logo (or its short name on a tile) and the standard's name, with a sub-line under it: scope (Programmatic, Institutional), the version in use with its publication date, and a note when a newer draft is in progress. There is no button on the closed card; the card opens to its versions, each with View or Edit, and the ⋯ menu has Open current version. Opened, it shows the accreditor, how complete the version in use is (requirements, how many assessable ones have an approved mapping to the internal standards, how many engagements use it) and every version with the same counts, plus "Start a new version" (a draft copied from the one in use) and "Import a new edition". Editors add, change or remove a logo from the card's ⋯ menu: PNG, JPEG or WebP up to 512 KB, checked by content (SVG is refused because it can carry script), stored in the object store (migration 0032). Counts come from the standards list itself. Not done: grouping by institution and program, and the institution's own logo (Settings still says it comes later).

---

## 2026-10-07 — External requirements laid out like the internal ones

An external standard's Requirements tab now follows the internal framework's: full-width closable cards with a shaded tag (the code, with the level in front when the code is only a number), items indented under their parent, a title, the level name and the review state on each card, and a hover tooltip. The ⋯ menu adds an item at the next level, edits, approves or rejects, and deletes while the version is a draft; "+ Requirement" opens a dialog (code, title, level, parent, official text, assessable). Inside a card: the official text and the notes with their authority badges, verified quotes and the add-note form. No evidence is linked here; it is linked once to the internal standards these map onto. Both screens now share one accordion component (`components/accordion.tsx`).

---

## 2026-10-07 — External Standards move into Settings

Standards are no longer in the main menu. Settings now has Organization, Programs, Internal Quality Framework and **External Standards**: the accreditors' standards, where you add one (import a file or start from scratch), edit its requirements while it is a draft, and publish it. A version opens at `/settings/versions/{id}` and keeps the Settings sub-menu. The old `/standards` and `/versions/{id}` addresses redirect. Settings now shows for anyone who can write or review frameworks, not only for org and program admins. The model stays: (1) Settings: define the internal standards and link evidence once; (2) map external to internal standards once; (3) accreditation cycle, collection and reporting in Engagements (still to build).

---

## 2026-10-07 — Requests connected to forms

A request can now ask someone to fill in a data item's form instead of sending a file. From the Form tab, "Ask people to fill it in" takes one or more addresses, a due date and a message, and gives each person their own request. AMS users see "Fill in the form" under Requests; anyone else gets a one-time link that opens the form. The request itself is the permission, so it works even while the form is closed to everyone else. One answer closes the request, and the answer waits under Responses to be added to the data. Requests list form requests with a "Form" tag.

---

## 2026-10-07 — Form builder: form and sheet views (DEC-020)

A data item now works like Google Forms: its columns are the questions (with help text), and it has Sheet, Form and Responses views. The Form view opens or closes the form and gives two ways to answer: a link for AMS users, who sign in, and an optional public link for anyone. The public link takes any number of answers until it is turned off, replaced, or the form is closed (DEC-020). Answers are checked with the same cell rules as the sheet and kept as responses. They join the data only when someone with edit rights clicks "Add N responses to the data", which saves the next version. Next: the BI connector, when the warehouse exists; the deferred items (reporting frequency, IQF tab layout) stay open.

---

## 2026-10-07 — Data evidence: definition and an online sheet

A data item now has a definition: what it means, what one row is, and its columns, each with a type (text, number, whole number, percent, date, choice, yes/no), an optional unit, whether it is required, and the choices of a choice column. Its data lives in an online sheet that we built ourselves, following the grid trial. You can type into it or paste a block from Excel. A cell that doesn't fit its column turns red and says why, and Arabic digits and d/m/yyyy dates are accepted. Saving checks every cell again on the server, using the same rules from `@ams/shared`. The result is kept as the next version, along with the columns it was saved with, so later changes to the definition never alter saved data. The Excel template carries the column rules as data validation and opens right-to-left when the titles are Arabic. Import of Excel or CSV (comma, semicolon, tab) matches headers by name and loads the rows into the sheet to check before saving. ExcelJS and Papa Parse load on demand from one module. TASK-040 is complete. Next: the form builder (form and sheet views).

---

## 2026-10-07 — Evidence requests, with one-time links (DEC-018, DEC-019)

First built-in collection source. From a standard's ⋯ menu, "Request evidence" asks a person by email for something specific, with an optional due date and message. An AMS user sees it under Requests → Asked of me and supplies the file there. Anyone else gets a one-time link (DEC-018) that opens a page with only that request. The link's secret is kept only as a hash, expires in 30 days, and stops working once used, replaced or cancelled. Either way the file becomes a document with a proposed link to the standard, which a reviewer approves. The API gained a third access kind, `responseLink()`, allowed only on `/api/response-links/{token}` (checked by the route coverage test). No mail is sent yet; the requester copies the link.

The owner also approved sharing AMS evidence with the connected BI, whose AI may process it (DEC-019, amending DEC-013 for the connector only). The AMS still makes no AI calls on evidence files. Next: data definition with an online grid (ExcelJS and Papa Parse import/export), then the form builder.

---

## 2026-10-07 — Evidence kept simple: document or data

At the owner's request evidence type is just Document or Data (migration 0023: datasets become data, everything else a document, the earlier kind kept in a new `subtype` column for the sub-types to come). The New evidence dialog, now also behind "+ Evidence" on the Evidence page, asks only for a title, document or data, an optional description and the file. Period, tags, confidentiality, link-instead-of-file and the student-data flag stay in the model with their defaults but are not shown. Next to design together: how data is collected (manual upload, request to an owner, or from the BI warehouse).

---

## 2026-10-07 — The AMS and the warehouse stay separate (DEC-017)

Uploads confirmed working on the deployment. The owner's institutional data warehouse (AI-native BI on PostgreSQL and S3 with a governed metric layer) is a separate product: each keeps its own storage, the AMS consumes metrics from the warehouse through an optional adapter, and either works without the other. Recorded as DEC-017; it confirms DEC-014, so datasets keep the source switch (manual upload now, governed metric when a warehouse is connected) and nothing built moves.

---

## 2026-10-07 — Link evidence: one search, create from it, justification

The Link evidence dialog is a single search box with a results dropdown (no "repository / new" switch, no permanent list box). The dropdown always ends with "+ Create new evidence", which opens a second dialog (title prefilled from the search; type, period, confidentiality, tags, file or link) and returns with the new evidence chosen. The reason field is called Justification and appears only once evidence is chosen. The same dialog now serves the requirement workspace ("+ Link other evidence") and the older version page; the inline link form is gone. Reporting frequency stays with engagements (accreditors' cycles); an evidence refresh frequency on internal items belongs with the review cycle, later.

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

## 2026-10-10 — Settings → AI split into tabs

Connection, Limits and Embeddings are now tabs (the tab survives a save); the Save / Test connection bar stays at the bottom. The provider was a disabled one-option dropdown that looked broken; it is now plain text. Help text shortened.

## 2026-10-11 — Migration order fix (0044)

0044's journal timestamp was earlier than 0043's. Drizzle applies only migrations newer than the last one applied, so a database that already had 0043 would have silently skipped 0044 (the IQF proposals table). Its timestamp now sits between 0043 and 0045. Safe because no database can have applied 0044 before 0043.

## 2026-10-11 — Settings → AI: adding an account did not stick

The Accounts panel (with its "Add account" dialog, itself a form) sat inside the settings form, so submitting the dialog also submitted the settings form, which saved settings in the same moment and re-keyed the page under the open dialog. The Accounts panel now sits outside the settings form, the settings form ignores submits that did not come from itself, and the dialog shows any unexplained failure instead of failing silently. Regression tests added.

## 2026-10-11 — Create from files and the split-view review (F2, TASK-055)

External Standards has a primary Create from files flow: one transaction makes the accreditor (or reuses one), the standard, a draft and one unset-role source per file; the browser uploads each file (retry per file) and starts the analysis, and an analysis that cannot start leaves the draft and files in place with the reason. The Requirements tab shows the cited page beside the list (bottom sheet on phones) with the quote highlighted: the range is computed on the server by the verifier's own matcher (`locateQuote`), never in the browser. Needs a look chips, merge, split and move were added; merge and split are audited by the row triggers and mark rows as edited by a person. No migration. The responsive run caught a picker bug (the file list was cleared before it was read).

## 2026-10-12 — Plan snapshot: what is left after steps A–F

Steps A–F of the framework compiler (ROADMAP-009) are built and tested with a fake model; nothing has run on a real accreditor document yet. Recorded in the plan: ROADMAP-009 now carries a snapshot table of the remaining work, and new tasks hold each item — TASK-056 real-document run and tuning (needs the owner's run), TASK-057 lifecycle/vocabularies/templates from policy documents, TASK-058 Appendix D changes in the liteparse repository and removal of the temporary fallback, TASK-059 production check of the three services and the parser image, TASK-060 small gaps found while building, TASK-061 backlog outside the compiler. ROADMAP-008 progress note rewritten to the current truth (owned liteparse in use; fallback for formats it lacks).

## 2026-10-12 — Trash, Undo and the in-app confirm dialog (TASK-062, DEC-026)

Deleting is a snapshot into `trash_item` (30 days, restorable with the original ids), not a flag: no `deleted_at` anywhere, no query changed. A delete removes the whole subtree in one step and one Trash group; the confirm question says how much goes. Restore refuses a frozen version, offers a choice when the parent is gone, renames a taken code ("(restored)") and drops links whose other side is gone. A daily pg-boss schedule (`purge_trash`, in the `worker` service) removes expired rows and the stored files they name as a system actor; the worker's database role can delete nothing but expired `trash_item` rows. Reversible actions return an `X-Undo` header (`{label, method, path, body}`); every call through the typed client becomes an Undo toast and Ctrl/Cmd+Z, with no per-screen code. `window.confirm` is gone from the web app and a lint rule keeps it out; the shared Dialog now traps and returns focus. Migration 0046. Inventory of what is and is not covered: `docs/trash.md`.

Learnings to carry forward:
- `updateRequirement` had been applying the create schema's defaults (Zod 4 applies a default inside `.optional()`), so any edit reset language, assessability and position. The update schema is written out now; check any `.partial()` of a schema with defaults.
- A bare array parameter in a Drizzle `sql` template is expanded to a comma list; build a SQL array with `array[...]::uuid[]` (`uuids()` in `trash/rows.ts`).
- A links-between-standards row is keyed by code, so it leaves with the last requirement that bears the code and returns only if both sides still exist.

## 2026-10-12 — Multi-select, bulk delete, drag and drop (TASK-063)

Requirement trees (quality framework, external standards, version page) share one interaction layer: ticking rows (checkbox, ctrl/cmd, shift, Space, Shift+arrows, Select all), a bulk bar with Delete (the server's `previewDelete` question, one Trash group, one Undo) and Move to…, and drag and drop (dnd-kit mouse, touch, keyboard) to re-parent and re-order. One batch service `moveMany` does it atomically with one Undo that restores every position; the rules (cycles, depth by level model, gap-free order) are pure code in `@ams/shared` used by server and screens. Moving never renumbers codes.

Learnings to carry forward:
- dnd-kit renders its own `role="status"` live region; it is portaled into an aria-hidden container so the toast stays the only status element.
- Keep per-row interaction state in a store read through `useSyncExternalStore` per row; otherwise ticking a row re-renders 600 cards. Queries inside every card (same key as the page's) also fan out re-renders: keep them in the open body only.
- user-event is very slow on 600-row trees; time with `fireEvent` or in a real browser.
- The IQF derives a sub-standard's parent from its code only when its code is edited; a dragged item keeps its code.

## 2026-10-12 — Indicator statement as the title; assistant plan

The demo standards stored an indicator as title = code ("1-1-1") with the statement in the description, so a card showed only a code. The statement now is the title when it fits (300 characters or fewer): `placeWording` (importer, new versions, analysis writer), migration 0047 for drafts and in-review versions (published versions are frozen; a new version made from one gets the correction when copied), and the demo fixtures. Longer text stays in the description. Planned, not built: an in-app assistant for bulk edits (docs/assistant-plan.md, TASK-064).

## 2026-10-12 — Assistant decisions and memory design

Owner decisions recorded as DEC-027: the assistant is a companion that inherits the user's privileges, uses the analysis model by default, edits only drafts (it may create one), keeps conversations, and has scoped memory (conversation, personal, workspace) read through the same authorization as the screens. Memory design in docs/assistant-plan.md. Still planning only.

## 2026-10-12 — Assistant: confirm in chat, no preview table

The owner dropped the before/after preview (every change is undoable) and asked that the assistant confirm in the chat before it changes anything. DEC-027 and docs/assistant-plan.md updated: the apply step takes only a one-time token issued by the chat's Do it button; Redo is added to the undo system (TASK-065), which the assistant depends on.

## 2026-10-13 — Project docs brought up to date; ledger repair

Added docs/status.md (what is built, what is left, in order, what waits on the owner) and linked it from index.md; refreshed the ROADMAP-009 snapshot, noted the library work done since ROADMAP-012 was completed, set TASK-064 to in-progress (phase 1 built) and added TASK-067 (assistant phase 2: bulk edits confirmed in the chat) and TASK-068 (assistant follow-ups). Repair: the commit that added TASK-064 (e45f128) overwrote TASKS.md with only the new entries (the file was opened for writing before it was read). TASKS.md was rebuilt from the last good version plus every task file, and is now consistent with docs/tasks/ (69 entries). The other generated ledgers were checked and are intact.

## 2026-10-13 — Compiler step H: lifecycle, vocabularies and report templates from policy and template documents (TASK-057)

Decisions: DEC-006, DEC-022. ROADMAP-009.
- **Where it sits.** Three new stages in the existing `analyse` chain (`config_survey`, `config_extract`, `config_write`), after `write` and before the IQF mapping: the requirements are settled first and the costly mapping stays last, so a spend limit cuts that and not the configuration. `write` skips them (no extra job) when the version has no policy, report-template or guidance document, and the report says so. The spend limit inside them ends only them: `config_write` still checks and writes what was extracted.
- **Dates are never converted.** The schema allows `due: null` ("set manually"), so a "reviewer must set the due rule" state needed a place to live: `MilestoneTemplate` gained optional `due_text` (the document's words, copied) and `due_pending`, and `checkFrameworkConfig` reports a pending milestone, so `validateVersion` blocks submit and publish until a reviewer sets a rule. A step with no timing in the document carries no mark.
- **Human edits.** Whole-part granularity, enforced by the database: `framework_version.config_edited` (trigger, any non-worker update that changes a configuration column) and `config_found` (what the analysis wrote, with page and quote per item); the worker guard lets it write a part only when it is empty or recorded as its own and not edited since. So an imported or copied part counts as a person's without any marker. `report_template` got `edited_by_person` and the existing `mark_person_edit` trigger. A template a person deleted is remembered through `config_found` (no new table) and not added back. The worker writes in its own transaction under the same guards instead of calling `updateVersionConfig`/`upsertReportTemplate` (which need a person's permission and set `origin: manual`).
- **Eligibility** has no field of its own in the configuration: eligibility conditions become milestones of type `task` in an eligibility phase.
- **Learnings.** Migration 0050 first ended with `GRANT EXECUTE ON ALL FUNCTIONS`, which silently undid the REVOKEs of 0046 and 0049 (caught by the trash database test): grant only the new functions. A budget limit counted per call shifted every existing job/call count by the guide's survey call, so the older tests were updated rather than special-cased. jsonb reorders object keys (shorter first), so lists built from `config_found` are not in reading order: sort when order matters.
- Not done: no recovery rounds for configuration (the flagged list and the "not found" lines stand in), decision follow-up rules, recurrence, `next_cycle`, `reply_template_key` and dataset bindings are left to the reviewer. Not run on a real document: the prompts follow the PRD's Appendix A fixtures and need the TASK-056 run.
- Tests: `config-merge.test.ts`, `config.test.ts` (core), `packages/db/src/analysis-config.test.ts`, `apps/web/src/config-ui.test.tsx`, plus updates to the analysis, mapping, report and report-UI tests. Fixtures: `config-fixture.ts` (invented documents, one Arabic).

## 2026-10-13 — Assistant phase 2: bulk edits confirmed in the chat (TASK-067)

Decisions: DEC-027, DEC-006, DEC-026, DEC-010. ROADMAP-012. Details and the list of what is where: docs/assistant-plan.md, Status.
- **What it is.** The assistant proposes a change set (typed operations: nine recipes the model parameterises and ten general operations), the chat card says in plain words what will happen (count, 2 to 3 real examples, skipped, named deletes), and the person presses Do it / Change it / Cancel. Nothing is written before that, and only the button applies it.
- **Where the dry run lives.** The job runs as the worker database role, which cannot write standards, so `propose_changes` checks the change set by simulating the rows in memory (cycles, collisions, frozen version, depth, permission). The service-level dry run (always rolled back) is in `confirm`, in the API as the person. Both use one planner (`changes/plan.ts`), also used by the apply.
- **Token.** `assistant_confirmation` is written only by `confirm`; the worker role has no grant on it and a trigger refuses an AI or system identity. Tied to person + message part + SHA-256 of the exact operations + plan hash; ten minutes; consumed by one atomic UPDATE. A refusal that is a 4xx rolls the request's transaction back (so nothing is consumed); every result that spends the token (applied, failed, stale) is a 200 with a status, so its use commits. A tampered proposal has another hash; changed data gives another plan hash: both end as `stale`, nothing changed.
- **Undo and Redo reuse what the services already report.** Applying wraps `ctx.undo` per service call and stores the collected descriptors; one descriptor (`/api/assistant/changes/{id}/undo`) reports the group. Undo replays them in reverse in one transaction; what that reports is the redo. No second inverse logic. Link reviews have no endpoint, so a pair of internal descriptors stands in.
- **Marking.** `rewrite_text` texts go to `assistant_written_text`; the requirement shows "Written by the assistant" with Keep and Revert while the field still holds exactly that text.
- **Learnings.** The API client type grew past what the compiler will print (TS7056): `createApi` now has an explicit `ApiClient` type. The chat card appears while the turn is still being polled, so its buttons wait for the end of the turn (tests wait for that). Tests of expiry move the confirmation's row (the trigger is switched off for that one statement), not the clock. A fixed-value rule (bulk assessable) does not depend on other fields, so a later edit of a title does not make it stale; a rule that reads the text does.
- Not done: IQF proposals as an operation; clean-up of expired confirmations; the evaluation script does not run the tool loop.
- Tests: `changes/changes.test.ts`, `changes/eval.test.ts` (core), `packages/db/src/assistant-changes.test.ts`, `apps/api/src/assistant-changes.test.ts`, `apps/web/src/assistant-changes-ui.test.tsx`; responsive states `assistant-change-proposal` and `assistant-change-applied`.

## 2026-10-13 — Plan: Organization, languages, org chart

Owner asked for a secondary language (primary always English) with translation of the IQF and standards, content and UI language switchers; an org chart built visually, from an image, and synced from a directory; Programs as a tab under Organization. Planned in docs/organization-plan.md with TASK-069 to TASK-074 (all pending); five decisions need the owner's answer. Nothing built.

## 2026-10-13 — Organization plan: owner's answers and the Docs pattern

Owner answered the five questions (DEC-028): Organization has two tabs (Institution with Languages and Org chart; Programs); one secondary language; translations of standards labelled unofficial; per-person UI language; org-chart images may go to the vision model; directory sync waits on what QuickLaunch and the university's Active Directory offer. New requirement: wherever the AI parses uploads into drafts, a Docs tab (who uploaded, when) plus a general Documents area. Plan rewritten around that pattern; TASK-075 (foundation) and TASK-076 (Programs from documents) added; TASK-069 to TASK-074 rewritten.

## 2026-10-14 — Programs from documents (TASK-076)

Programs registered as an import target on the shared engine; the Programs tab got a Docs tab. See docs/ai-import.md.

## 2026-10-15 — Navigation; Quality Management designed (TASK-077, DEC-029)

Quality Management menu item above Accreditations (Engagements relabelled; routes unchanged); app name removed from the top. Design of cycles and reporting agreed with the owner over several rounds: a cycle is ordered stages, each with inputs -> process -> outputs, a responsible unit, an owner and dates; reports are outputs or inputs; cycles at any level (anchors), recurring, nested, inherited down the IQF and to mapped external standards with overrides; the IQF ⋯ menu becomes Link evidence, Assign scope, Assign champion, Create cycle (external standards the same, inherited). Build broken into TASK-078 to TASK-086. Plan: docs/quality-management-plan.md.

## 2026-10-15 to 2026-10-18 — AI on real models; editable org chart; import review

- **Org chart from an image, first real runs.** The extract step had been set to the Reading model (an OCR-only model gave "No output generated"); it now uses the Analysis model. Slow free models and thinking models (GLM) failed silently for minutes: calls now stream with a start limit and a silence limit, a model that returns nothing or times out ends the run at once with the reason, a plain-JSON fallback is checked against the schema, and reading/extraction always ask for no thinking (task level), taking the JSON from the reasoning if the reply is empty. 86 units imported on the owner's chart.
- **Learnings.** Thinking models spend the whole allowance reasoning on extraction and answer nothing; the AI SDK's `reasoning: 'none'` plus the usual compatible-server fields fixes it, with a plain retry for servers that refuse unknown fields. OpenAI refuses a 1x1-pixel test image. A PDF's text layer loses an org chart's lines (a one-step vision import was discussed and not built).
- **Editable Chart view.** Move by drag or keyboard, rename in place, add a sub-unit, delete to the Trash, each with Undo; no new API.
- **Link evidence** takes several pieces at once.
- **Programs import review.** Nothing applied because the degree level was missing on all 21 rows and the enum refused a typed "Bachelor": degree level now accepts the usual spellings, fixed-list fields are a choice, units come from the org chart (new names allowed), "Set a field on N selected", prompt v2 reads a heading's degree level.
- Tests: 1,588 tests, 175 database tests.

## 2026-10-19 — Plan review

Status and the plan reviewed. ROADMAP-013 (Quality Management: cycles and reporting) added and TASK-077 to TASK-086 moved under it; TASK-064 closed (assistant phases 1 and 2 are built). External standards got Map to IQF, direct evidence links, the hover card and the same layout as the IQF, without side panels. Order ahead: real-document checks (owner), Quality Management core, M4 report engine, cycles further, M5/M6 on the cycle engine (to decide), liteparse, P1 features.

## 2026-10-20 — Evidence link review: auto-approve, reasons, notifications (TASK-088)

Owner request. A link made by someone who may review it (the check `assertMayReview` uses: `evidence:review` for library links, `engagement:review` for engagement links) is created approved, by that person, with no comment; everyone else's stays proposed; answers to evidence requests keep their own flow and the AI never approves (DEC-006). A rejection now needs a reason (schema and a dialog in every list of links) and shows "Rejected by X on date: reason". Migration 0063 adds `notification` (own rows only by row-level security, worker read-only): the proposer is told of a rejection or of an approval by someone else (never of their own decision), sees it in a Notifications section of My work (counted in the menu) and can Resubmit (the link goes back to proposed with a new justification; the audit log keeps the history), Mark as read or Dismiss. Email of the notices waits for SMTP (TASK-061); the `notify` job is still a stub. BI-proposed links stay proposed (a service identity is not a reviewer).
- **Learning.** An insert that RETURNs a row for another person fails row-level security (the SELECT policy applies to the returned row): `createNotification` generates the id itself and does not read the row back.


## 2026-10-21 — Plan: reports, report and QA cycles, accreditation, assistant

Analysis and plan in docs/reports-and-cycles-plan.md. One report engine (M4) wrapped two ways: accreditation milestones and report/QA cycles; two approval layers (report sections, then cycle sign-off); a report's requirement set for a subject is the IQF standards in its scope, owners are champions; QA report templates live on the IQF version; accreditation keeps its roadmap (TASK-082 replaced). New tasks TASK-091 to TASK-101; TASK-085 replaced by TASK-098. Awaiting the owner's decisions.

## 2026-10-21 — Requirements: URLs as sources, template resources, schemas for everything

Owner: a URL wherever a document can be provided for scraping; cycle templates take documents and URLs as resources (like org chart and programs); programs, courses and everything have schemas. Recorded as DEC-033 with the analysis and plan in docs/schema-and-sources-plan.md and TASK-102 to TASK-106 (pending). Open questions to the owner: HTML pages and domain allow-list, courses from a catalogue and member of several programs, read-only data dictionary versus custom fields, the program field list.

## 2026-10-22 — Plan: documents for the IQF and standards; embeddings

Owner asked whether documents can furnish the IQF and external standards, and whether embeddings are on. Findings: external drafts can be furnished (merge by code, human edits kept); the IQF cannot; published versions are frozen; embeddings are built and used only for IQF mapping, off by default, unmeasured. Added TASK-107 and TASK-108.

## 2026-10-22 — Decision: documents may propose wording edits

Owner: uploaded documents may propose changes to the wording of requirements a person wrote, as a diff a person accepts (TASK-107). Assistant memory search by meaning: explained to the owner, recommendation is to keep words-and-codes only; awaiting the owner's yes or no.

## 2026-10-25 — Reports: the engine (TASK-091)

A report is created from a reviewed template: the template's structure is copied into section rows (a later template edit never reshapes a report already made), requirement codes resolve against the version now (an unknown code is a defect the creator hears about), and each section's owner defaults to the requirement's owner in the engagement, or — for a report about a subject — to the standard's champion through the unit chain, with parent-code inheritance; where two champions tie at the same tier the section is flagged `owner_unresolved` and nobody is guessed. Wrapper rules live in the database (migration 0066): a report starts as a draft, what it was made from never changes, draft -> internally_approved -> submitted only, internal approval needs every section approved, the section shape is frozen, content is written only while the report is a draft and the section is draft or returned, and a narrative's word count is recomputed by the database. The worker role reads reports and writes none (DEC-006). Services in `packages/core/src/reports/`, seven routes under `/api/reports` with the five-step chain and scope-based `report:manage`; permissions report:read/write/review/manage by role; delete moves the whole report to the Trash as one group with Undo and Redo, restore re-links requirements and flags owners who are no longer of the tenant. Route documents declare the section tree opaque (`z.array(z.unknown())`) because `z.lazy` recursion breaks @hono/zod-openapi — the service validates the real schema, as the templates route already did.
- **Learning.** `NULLIF(app_user_id(), '')` throws inside a trigger: the function returns uuid and uuid is never compared to a string — assign it bare.
- **Learning.** A BEFORE INSERT OR UPDATE trigger silently misses DELETEs; guard all three, and on DELETE only `OLD` exists (`COALESCE(NEW.x, OLD.x)` for the row's keys).
- Tests: full suite green except the known environment failures (Windows path separators in the import-point guards, openssl and localStorage on this box, load-flaky UI waits); 10 new database tests for the report rules, 8 API tests.

## 2026-10-25 — Reports: the editor (TASK-092)

The report page (/reports/$id) is one full-width column, no side panels: the header carries what the report is, its word total and its section progress; the sections follow in template order, each with its block's editor. The narrative is Tiptap (StarterKit without headings), stored as { doc, text } — the plain text is what the database recounts, what the diff (TASK-094) and the export read; Arabic keeps dir="auto". Evidence is cited inline as the token [E:<evidenceVersionId>] inserted at the cursor from a sheet listing the approved evidence of the section's linked requirements plus a library search; the export (TASK-093) numbers the tokens by first appearance. The data table edits by the template's columns, imports CSV (labels matched, case-insensitive) and, when bound to a dataset, shows the binding and refills its rows from the dataset's latest version. The attestation takes signatory, title and statement, and the signed letter goes up whole (bytes, not parsed) into the object store and comes back inline; the appendix attaches evidence versions, which the service checks belong to the tenant. Word counts are live with over-limit warnings. The engagement's Reports tab lists the reports and makes one from a reviewed template only — unreviewed templates are greyed out. Nine UI tests run against the real API and database, like the other screens'.
- **Learning.** jsdom cannot type into contenteditable (the browser, not the page, inserts the characters), but ProseMirror reads pastes itself: tests `fireEvent.paste` with `getData` answering `text/plain` only — PM also reads other clipboard flavours (it JSON.parses `vscode-editor-data`) and a mock that answers everything breaks the paste.
- **Learning.** ProseMirror measures the selection to scroll it into view; jsdom has no layout, so every editor dispatch throws `getClientRects is not a function` until the test stubs `Range.getClientRects`/`getBoundingClientRect` and `window.scrollTo`.
- **Learning.** The typed RPC client drops an `undefined` `:id` path segment, silently hitting the collection route — a page expecting a detail gets an array; the crash (`sections of undefined`) names the symptom, not the cause.
- **Learning.** The editors' save buttons disable on the click (local `saving`) and only the dirty flag clears after the API answers: a test must wait for the button to read Save again, not merely be disabled, before reading back.

## 2026-10-25 — Reports: the workflow (TASK-094)

PRD §10.4 steps 2–5 on the report page. A writer sends a section for review; a reviewer approves it or returns it with a note, and the note with the decider's name shows on the section for the writer to act on. Reopening an approved section records a `returned` decision and sends the section back to draft — and if the report was already internally approved, the report is demoted to draft in the same transaction. When every section is approved, a reviewer internally approves the report; the database checks the sections and the attestation and stamps approved_at/by; the wording is exactly "Internally approved" (DEC-005). A manager then freezes the submission snapshot: the whole report in one manifest — sections and content, the requirements they answer, who approved each and when, the attestation, the cited evidence (inline `[E:]` tokens and appendix items) with its sha256 — hashed, one per report, immutable by database triggers (PRD §6.9); a round-2 report carries the word-level diff of every changed section against the nearest earlier round that has a snapshot (PRD §11.4). "Mark submitted" refuses without a snapshot (what went out is frozen before anyone says it did), stamps submitted_at/by, keeps the accreditor's reference as given, completes the engagement's submission milestone, and locks the report. All of the discipline lives in migration 0067: decisions are kept as they were made, a returned decision needs its note, snapshots are frozen, and a deferred constraint trigger catches at COMMIT an internally approved or submitted report that still has an unapproved section — even against a service that forgot the demotion. Twelve new tests across the three layers; the review flow and the snapshot/submission flow are driven through the real page. Full suite: 2 075 passed; the 13 failures are the box's known environment set (Windows path separators in the import-point guards, openssl, localStorage, load-flaky UI waits) plus one inherited from TASK-092 — the citation hint's `[E:<id>]` broke the locale's HTML-free guarantee — reworded to `[E:id]` here; verified by running the two failing files in a throwaway worktree at HEAD.
- **Learning.** In PostgreSQL a NULL verdict passes a CHECK: `decision <> 'returned' OR length(btrim(note)) > 0` admits a NULL note, because FALSE OR NULL is NULL and a NULL check result is not a violation. A presence rule must say so explicitly: `note IS NOT NULL AND length(btrim(note)) > 0`.
- **Learning.** In a plpgsql trigger, on DELETE `NEW` is unassigned and `NEW.field` silently reads NULL — so a membership check that mentions `NEW.x` fires the wrong error on DELETE. The TG_OP immutability raise must come first in the function body, before any check that touches NEW.
- **Learning.** A forgotten multi-row invariant is cheaper to catch at COMMIT than to spread across every service: the same `AFTER UPDATE ... DEFERRABLE INITIALLY DEFERRED` trigger that guards each write also guards the transaction that only looked like it updated everything, so the service may trust the database and stay thin.

## 2026-10-26 — Tests: the box's environment failures fixed

The known Windows-environment failure set is gone, not waived. The import-point guards compare forward slashes (`path.relative` yields backslashes on Windows); the SAML spike reads committed throwaway fixture certs instead of shelling out to openssl, which Windows PATH lacks; `vitest.setup.ts` installs an in-memory `localStorage` where jsdom 30 leaves `window.localStorage` undefined, so every browser-hint test works. The glossary flake turned out to be a product bug the test exposed: "No terms yet." and the seed button rendered while the first fetch was still in flight, so a cold first-file run clicked seed before the initial GET resolved; `invalidateQueries` deduped against that running fetch and the late, pre-seed response cleared the invalidated flag — the refresh was swallowed and the page stayed empty. The page now shows the empty state and offers seeding only once the first fetch has landed (`glossary.isSuccess`), and keeps the invalidation inside the mutation's own promise. The glossary and languages UI tests read refetch-rebuilt nodes from the live DOM, prefer `findByRole` over bare reads, and give loaded machines longer waits. Verified: 6/6 cold glossary-first batches, 3/3 swapped-order batches and a solo run green where the old code failed ~20–50% of cold batches; typecheck and lint clean.
- **Learning.** An `invalidateQueries` fired while that query's fetch is still in flight dedupes against it and issues no request, and the fetch's own success dispatch clears the invalidated flag: the refresh silently never happens. A UI must not offer an action whose next screen depends on refreshing a query that may still be loading.
- **Learning.** `data?.items ?? []` makes "loading" and "empty" indistinguishable — the empty state and its action render during the first fetch, and users (and tests) race it. Gate the empty state on the query having succeeded.
- **Learning.** Committed fixture certs beat shelling out to openssl from a test: the binary is not on Windows PATH, and `-subj` quoting differs between mingw and real openssl anyway.

## 2026-10-26 — Tests: the last five failures (and a correction to the count above)

The first full-suite run after the environment fixes still failed 5 of 2 091. Three were the import-point guard's twin: `one-import-point.test.ts` compares `path.relative` output against forward-slash allow-lists and needed the same separator normalisation as parse-document's guards — the first pass fixed one file and missed the other. One was environment leaking in rather than out: `model.test.ts` expects each provider's own endpoint, but the SDK constructors fall back to ambient variables (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GENERATIVE_AI_BASE_URL`) when the config carries no Base URL, and this box exports one (a gateway); the test now stashes and clears those variables around every case. And one was real, not environment: `reports.test.ts` expected `internally_approved → draft` with every section still approved to be refused by the transition guard, but 0067 admits that move in its table precisely so the reopen flow can demote, and refuses a bare demotion with the other message ("a report returns to draft only when one of its sections was reopened"). The expectation was wrong from birth, so the TASK-094 entry above mislabeled this failure as part of the box's environment set — a genuine test bug was hiding in that count.
- **Learning.** When a fix normalises `path.relative` output, grep the repo for the same pattern instead of trusting the one file that failed: the identical helper existed twice and failed three tests.
- **Learning.** A provider SDK constructed without an explicit baseURL inherits the ambient endpoint variables; a test that asserts a fixed endpoint must clear them, and product code that promises a fixed endpoint must pass one.
- **Learning.** When a trigger pairs a transition table with a conditional refinement of one move, the refinement's message is the one raised — assert the message the design speaks, not the nearest guard's.

## 2026-10-26 — Co-deployment with the BI (DEC-034)

The BI product starts in its own repository (drmoyassine/ai-native-bi, same stack). The owner wants a mode where both run in one Compose project and share resources. Recorded as DEC-034: one PostgreSQL server and one Garage store shared, but separate databases, roles and buckets, and the products still talk only through the contract. The AMS's https-only rule for calling the BI gained one exception, `BI_PRIVATE_HOST`: a single-label name (a Compose service such as `bi-api`) that may be called over plain http, in production too, because such a name resolves only on the private network. The combined Compose file lives in the BI repository and builds the AMS from its checkout; the AMS's own compose.yaml is unchanged.
## 2026-10-26 — The IQF reads its own documents (TASK-107)

The internal quality framework got its Documents tab and its analysis: the same generic engine as an external standard's, run on the institution's own papers, with the internal prompt variants (survey, structure, extract, recover v2) chosen per run and recorded in promptVersions. Three boundaries hold it. The institution names its own levels: the structure stage records the model's labels on the run but never applies them, and the worker guard rewritten in 0068 keeps it that way at the database — the worker now drafts unreviewed AI rows into an internal draft exactly as into an external one (the old blanket refusal was wrong: the IQF is a draft like any draft), and the one thing it may still not touch is level_labels. The framework maps onto nothing: it IS the frame, so embed and map are routed around and the config stages jump to wording only when internal, leaving external runs' job count alone. And wording — the new stage, internal only — proposes edits to items a person wrote, one wording_proposal row per proposal (current text, proposed text, the word-for-word verified quote and page, the reason), decided by a person from the review inbox above the Requirements tab: an acceptance is one updateRequirement (back to review, undo reported) plus the decline of its sibling pendings; no-ops (same words) are never proposed, an accept whose item drifted since is refused, and a published version takes no analysis — the Documents tab offers "Start a new version" instead. URL sources are deliberately out (TASK-102).
- **Learning.** drizzle's migrator applies only the files registered in `meta/_journal.json`; a new SQL migration without its journal entry silently never runs, so the tests keep hitting the old trigger while the fix sits in the file.
- **Learning.** A barrel's `export *` turns a fixture name clash into an error far from any use site: two FIXTURE_POLICY exports (config fixture and internal fixture) broke tsc in the barrel file itself — name fixtures after their subject (FIXTURE_MANUAL), not their role.
- **Learning.** The wording stage's no-op guard (proposed text equals current text) means a second run over the same documents proposes nothing new — correct, and a test that wants a second proposal must hand its fixture a different answer.

## 2026-10-27 — The AMS signs people in to the BI (DEC-035, TASK-109)

The BI asked (its #10, our issue 3) to act as a person with that person's rights, for its app and for MCP clients. The AMS is now its authorization server: Better Auth's `@better-auth/oauth-provider` (1.7.7, matching better-auth) with the `jwt` plugin. Issuer `APP_URL/api/auth`; discovery there and at the root for RFC 8414 clients; EdDSA JWKS; PKCE for every client; clients only from `OAUTH_CLIENTS` (no registration, no consent screen); access tokens for `BI_OAUTH_AUDIENCE`, 10 minutes, with `bi_role` and `bi_scope` derived from role assignments at every token and refresh, so disabling a person stops the BI at the next refresh. Migration 0069 adds the plugin tables (outside RLS, like 0002) and `app_bi_principal`.
- **Learning.** The plugin refuses an authorization request whose `resource` is not seeded and linked to the client (`invalid_target`); config-defined clients are written straight to `oauthClient` with the plugin's own secret hash (SHA-256, base64url unpadded), because its create-client routes need a signed-in session.
- **Learning.** Replaying a used refresh token revokes the whole chain, including the newest token: a test that reuses an old one must come last.
- **Learning.** The plugin's documentation site was not reachable from the box; the type definitions and a throwaway end-to-end test were enough to learn the flow (sign-in, `/login?…&sig=` for a person not signed in, authorize, token, verify against JWKS, refresh).

## 2026-10-27 — One database, a schema per product (DEC-034 revised)

The owner preferred one database with a schema per product to a database per product, and reserved `public` for the BI's analytic data. Migration 0070 renames `public` to `ams` (every object moves with the schema; catalogue references are by identity), creates an empty, closed `public`, sets the database's default search path to `ams`, re-points the 37 `SET search_path = public` SECURITY DEFINER functions, and lets only `ams_app` / `ams_worker` use `ams`. `ams-schema.test.ts` proves a role of another product sees neither `ams` nor `public`. The BI side (its role and schemas on the shared database, its job queue out of `pgboss`) is asked of the BI through the issue bridge.
- **Learning.** `ALTER DATABASE ... SET search_path` reaches new connections only; a migration that renames the schema must also `SET search_path` for the rest of its own run. A role-level setting (the BI's) wins over the database's.
- **Learning.** The AMS's migrations now need the database owner or a superuser (the default Compose `POSTGRES_USER` is a superuser).
