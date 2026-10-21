# Reports, report and QA cycles, accreditation cycles, the assistant — analysis and plan (2026-10-21)

Status: plan for the owner's approval. Nothing here is built. Sources: PRD §10 to §12 and §18.4 (M4), DEC-029 to DEC-032, what
is built today (docs/status.md).

## 1. What exists and what does not

| Piece | Today |
|---|---|
| Report **templates** (sections, block types) | Built: `report_template` on a framework version (the external standards' Templates tab; the compiler fills them). |
| A **report** made from a template, its sections, editor, workflow, snapshot, export | **Not built.** This is M4. Engagement milestones carry `deliverable.report_template_key` and a `report_id` column that nothing fills. |
| **Cycle engine** (stages, inputs, outputs, owner, approvals, templates, recurrence, plans, due list) | Built (TASK-078 to TASK-081, 087). Evidence collection left it (DEC-031); report/QA cycles are parked and not offered in the UI. A cycle's `report` output is a stub ("Report engine pending"). |
| **Accreditation lifecycle** | Built as the engagement **roadmap**: phases and milestones with owner, due rule, status, `deliverable`, `recurrence`. |
| Evidence, links, collection runs, scope, champion | Built. |

So three things are missing, and they depend on each other: the **report engine**, **report/QA cycles** that use it, and the
accreditation timeline's tie to it.

## 2. The key analysis: one report engine, two ways to wrap it

A report (PRD §10) is the same object everywhere: sections, blocks, owners, approvals, a snapshot, exports. What differs is the
**wrapper**:

| Wrapper | Where it lives | What it adds |
|---|---|---|
| **Accreditation milestone** | Accreditations (the engagement roadmap) | The accreditor's lifecycle, due rules, "Mark submitted", and later the response sub-cycle (M5, M6). |
| **Report / QA cycle** | Quality Management (the cycle engine) | Steps before and after the report (collect, self-evaluate, review chain, close), a repeating schedule, one owner. |

Rules that keep this simple:
1. **One report engine** (M4); the cycle's `report` output and the milestone's `deliverable` both point at a report made by it.
2. **Two kinds of approval, different jobs.** Inside a report: **section approvals** by section owners (content). In a cycle:
   **approval outputs** by named people (management sign-off of the whole). A cycle's report output becomes *final* when the
   report is **internally approved** (all sections approved, attestation present if required). Never "met" or "compliant" (DEC-005).
3. **A report's requirement set comes from scope.** A QA report about Program X covers the IQF standards whose **scope** includes
   X, and each section's default owner is the standard's **champion** (TASK-086). That is the real link between scope, champion and
   reports; it needs no new object.
4. **Where QA report templates live:** on the IQF framework version, in the same Templates tab (the IQF is a framework, so the
   table and editor already apply). Defaults are shipped as data (annual program report, periodic review, admin unit review,
   internal audit), never code per accreditor (DEC-002).
5. **Accreditation does not get a second engine.** Engagement milestones already are stages (owner, due, status, deliverable,
   recurrence). Maintenance "runs the annual report each year" is a *recurring milestone whose deliverable is a report*. So TASK-082
   (nested cycles in Accreditations) is not needed as designed; it is replaced by wiring milestones to reports (M4f) and by the
   recurring-milestone work in M6. What remains is small: an org unit as an engagement's subject (ISO for IT or Facilities).

## 3. Proposed work, in order

### A. M4 Reports (ROADMAP-005), six tasks
| Task | What | Needs |
|---|---|---|
| **TASK-091** | **Report model and engine core:** `report`, `report_section`, creation from a template (requirement codes resolved; sections get owners from requirement owners or champions), statuses, round field reserved, permissions, Trash, Undo, audit, API. | — |
| **TASK-092** | **Report editor:** section tree, `narrative` (Tiptap, Arabic RTL, prompt, linked requirements and their approved evidence in the panel, inline citation `[E-n]`), `data_table` (columns, dataset binding with refresh, paste/CSV), `attestation`, `appendix`, word counts and limit warnings. Full width, no side panels: the evidence panel is a sheet. | 091 |
| **TASK-093** | **Generated blocks:** `compliance_matrix` (one row per applicable requirement: code, title, internal status, approved evidence titles; worded as internal, never "compliant"), `evidence_index` (numbered, cited versions), `feedback_response` (renders from M5 items; empty-state until M5). | 091, 092 |
| **TASK-094** | **Workflow and snapshot:** section owner → in review → approved or returned, report "internally approved", **submission snapshot** (immutable manifest, DB triggers like other frozen things), "Mark submitted" (date, who, accreditor reference), lock, section diff between rounds. | 092 |
| **TASK-095** | **Export:** DOCX and PDF of the whole report in template order with generated blocks rendered and RTL for Arabic; evidence index as XLSX; self-contained ZIP package; behind one internal function (`renderReport()`), like parseDocument(). | 093, 094 |
| **TASK-096** | **Wire into Accreditations:** a milestone with a report deliverable creates its report; submitting completes the milestone; the Accreditations UI shows the report and its state; recurring milestones create a report each period. | 091, 094 |
Done when (PRD §18.4): the WSCUC institutional report and the ABET self-study report export with a populated matrix and evidence
index; an Arabic PUC report renders right-to-left; snapshots cannot be changed.

### B. Report and QA cycles, three tasks
| Task | What | Needs |
|---|---|---|
| **TASK-097** | **QA report templates on the IQF and defaults:** report templates in the IQF version's Templates tab (editor reused), shipped defaults as data (annual program report, periodic review, admin unit review, internal audit), each wired to a cycle template of the same name. | 091 |
| **TASK-098** | **Report output on cycles:** a cycle's `report` output creates the report from the template for the cycle's subject (sections = in-scope standards, owners = champions); the output turns final when the report is internally approved; the cycle page shows and opens the report. Replaces TASK-085. | 091, 094, 097 |
| **TASK-099** | **Offer report cycles in the UI:** "New cycle" for a unit, program or institution (template, subject, owner, start, **Repeat** every term / year), the Due-to-launch list and plan screens back in their simple form (a switch on the cycle, no plan inheritance tree), QA templates un-hidden. | 098 |
Done when: a program runs its **annual program report** end to end: the cycle starts for the term or year, the program's in-scope
standards become sections owned by their champions, evidence is pulled in, the report is internally approved, a review chain
signs it off, and the next one is proposed.

### C. Accreditation cycles
| Task | What |
|---|---|
| **TASK-082** | **Replaced.** Cancelled as designed (no nested engine). Its useful parts become TASK-096 (milestones produce reports) and M6 (recurring maintenance milestones). |
| **TASK-100** | **Engagement subject may be an org unit** (ISO for IT, Facilities): schema, wizard, lists; small. Needs nothing from M4. |

### D. Assistant for cycles
| Task | What | Needs |
|---|---|---|
| **TASK-101** | **Read-only assistant tools:** what is late, what is waiting on me (collection runs, cycles, reports, notifications), what a standard's evidence and mappings are. Safe, small, useful now. | — |
| **TASK-084** | **Assistant proposes** (create a report cycle, set a repeat, assign a champion) as a confirmed change. Waits on TASK-099; stays P3. | 099, 101 |

### E. After M4
M5 accreditor responses and M6 decisions and maintenance (ROADMAP-006, ROADMAP-007), built on the report engine and the
milestones (the response sub-cycle is milestones plus items, not a second cycle engine). Not detailed here.

## 4. Order and size

1. **TASK-091, 092** (engine and editor): the foundation, the largest part (two of the biggest tasks left in the project).
2. **TASK-093, 094** in parallel after 092; then **TASK-095** (export) and **TASK-096** (wiring).
3. **TASK-097 to TASK-099** (report/QA cycles) once the engine can approve and snapshot.
4. **TASK-100 and TASK-101** can go any time, in parallel, because they do not depend on M4.
5. M5 and M6 after.

## 5. Risks

- **Editor and export are the heavy parts.** Rich text with Arabic RTL, then DOCX/PDF with RTL, are where real-document trouble
  shows up. Plan a real-document pass (the WSCUC report and a PUC report) before declaring M4 done.
- **Two approval layers** (sections, then the cycle) can feel duplicated. The rule above keeps them apart; the cycle page shows the
  report's state instead of repeating it.
- **AI drafting of narratives** is out: DEC-013 keeps evidence away from the AMS's own AI; the BI may help, outside the AMS.
- Report templates today come only from external standards and the compiler: the IQF templates (TASK-097) are the first
  hand-made ones, so the Templates tab needs to feel complete for authors.

## 6. Decisions for the owner

1. QA report templates live on the **IQF version** (same editor as external templates).
2. A report's requirement set for a subject = the IQF standards **in the subject's scope**; section owners = **champions**.
3. Two approval layers as described (report sections, cycle sign-off).
4. TASK-082 is **replaced** (milestones produce reports; no nested engine in Accreditations).
5. Order: M4 first, then report/QA cycles; TASK-100 and TASK-101 alongside.
