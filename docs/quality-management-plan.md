# Quality Management — Cycles and Reporting (TASK-077)

Status: design agreed with the owner on 2026-10-15 (DEC-029, TASK-077). Nothing is built yet.

## Build tasks

| Task | What | Needs |
|---|---|---|
| TASK-078 | Schema, permissions, core services and API | — |
| TASK-079 | Cycle templates in Settings, editor, shipped defaults | 078 |
| TASK-080 | Quality Management screens: list, new cycle, cycle page, My work | 079 |
| TASK-081 | Recurrence, academic terms, plans with inheritance | 080 |
| TASK-082 | Nested cycles; cycles in Accreditations; org-unit subjects | 081 |
| TASK-083 | Start a cycle from the ⋯ menu; Cycles panels | 080 |
| TASK-084 | Assistant reads and proposes cycles | 083 |
| TASK-085 | Report outputs on the shared report engine | 080 + M4 report engine |
| TASK-086 | IQF in operation: ⋯ menu (Link evidence, Assign scope, Assign champion, Create cycle), scope levels, cascade and inheritance to mapped standards | 078 |

## Scope

TASK-077 covers **cycles and reporting only**. A report is an outcome of a cycle, or a stage of one.

Out of scope here, each to get its own task later if wanted: KPIs and measure values; outcome assessment (PRD §13); the
shared action register; cadences on framework nodes and the scheduler; the academic calendar; evidence-collection
cadences; AI help (drafting, suggesting, summarising).

## The model: a cycle is stages; a stage is inputs -> process -> outputs

```
Cycle  (subject, template, status, dates)
 ├─ Stage 1  owner · start · end · status
 │    inputs  ─▶  process  ─▶  outputs
 ├─ Stage 2        ▲                 │
 │    inputs ──────┘ (an output of an earlier stage)
 └─ ...
```

- **Cycle**: one run for one subject (the institution, a unit or a program), made from a **cycle template**. Statuses:
  `draft` (being set up) -> `active` -> `completed`, or `cancelled` with a reason.
- **Stage**: an ordered step with an **owner**, a **start date**, an **end date** and a status:
  `not_started` -> `in_progress` -> `completed`, or `skipped` with a reason. A stage is completed when its required
  outputs are final.
- **Inputs -> process -> outputs**:
  - The **process** is the stage's instructions: what to do, as text plus an optional checklist.
  - An **output** is a named slot the stage must fill. Its kind is one of: `report` (from a report template),
    `document` (an uploaded file), `approval` (a sign-off by a named person or role, with a comment), or `note` (short
    text). Each slot is `missing` -> `draft` -> `final`.
  - An **input** is a slot the stage reads. It points at an output of an earlier stage in the same cycle, at an output
    of the subject's previous cycle of the same template, at an uploaded document, or at something the stage owner
    picks (evidence, a document). A stage can start while inputs are missing; the screen says which are.
- **A report is an output or an input.** Stage 2 writes "Self-evaluation report" (output); stage 3 reads it (input) and
  produces "Review" (approval output); stage 4 reads both and produces "Final report". Last year's final report is an
  input to this year's stage 1.
- **Review is just stages.** A review chain is a run of stages whose output is an `approval`; returning work is
  reopening the earlier stage. No separate review engine.
- **Responsible unit and owner**: every cycle and every stage has a responsible unit (from the org chart) and an owner
  (a person). The template gives both as rules (the subject's unit, its parent, a unit of a given type such as the QA
  office; its head, or a role); launching resolves them, and both can be changed per stage.
- **Owners (detail)**: the template says who, as a role or an org-chart rule ("head of the unit", "head of the parent unit",
  "QA office"); launching the cycle resolves it to a person, which can be changed per stage.
- **Dates**: the template gives each stage an offset and a length from the cycle's start; launching turns them into
  dates, editable per stage. Order comes from the inputs, not from the dates, so stages may overlap.

## Cycles at any level

A cycle is attached to an **anchor**: anything it is about. One mechanism, any level:

| Anchor | Example cycle |
|---|---|
| Institution | Institutional quality review |
| Unit or program (org chart, Programs) | Annual program report; admin unit review |
| IQF, standard, sub-standard, item | Report on Standard 3 across programs |
| External standard or requirement | Evidence round for a CFR before an interim report |
| Evidence item | Collect and refresh one piece of evidence (e.g. syllabi each term) |
| Accreditation (engagement) | A preparation cycle inside an engagement |

- A cycle has one anchor (kind + id) and optionally a subject (the unit or program doing the work), so "Standard 3 for
  the BSc in Nursing" is anchor = Standard 3, subject = the program.
- **Start a cycle from the ⋯ menu** of almost anything: a unit, a program, a standard or requirement, an evidence item,
  an engagement. The dialog offers the templates that fit that kind of anchor, plus "blank".
- Each anchor shows its cycles (running and past) in a small "Cycles" panel, and the Quality Management menu lists all.
- Templates say which anchor kinds they fit; a blank cycle fits anything.

## AI-aware

Cycles are data the assistant can read and act on, within the existing rules (AI proposes, a person confirms; evidence
files never go to the AI):
- The assistant's read-only tools include cycles, stages, owners, dates, statuses and which inputs are missing ("what is
  late in my cycles?", "which stages wait on me?").
- The assistant can propose a cycle (anchor, template or stages, owners, dates) as a change proposal the person
  confirms, like its other edits; "set up an evidence round for Standard 2 for every program" becomes one confirmable
  change.
- The ⋯ menu's "Start a cycle" has "Ask the assistant to draft it" next to the templates.
- Drafting report text and summarising stay deferred (see Scope).

## Standards in operation: Link evidence, Assign scope, Assign champion, Create cycle (owner, 2026-10-15)

The ⋯ menu of an IQF standard, sub-standard or item becomes: **Link evidence · Assign scope · Assign champion · Create
cycle**. "Request evidence" leaves the menu: evidence is requested through a cycle (an evidence-collection cycle).

**Where:** these are operations, not settings. They live on the IQF tree shown in the **Quality Management** menu.
Settings -> Internal Quality Framework stays the place where the framework itself is written, versioned and published.

### Scope

- A scope says where a standard applies: a **level** (Institution, Unit, Program, Course, …) and optionally a **list**
  of specific ones at that level ("Standard 4: every Program", or "only BSc Nursing and BSc Pharmacy").
- The levels are a short list in **Settings -> Organization -> Institution** ("Scope levels"): Institution, Unit,
  Program, Course to start with. Course is a placeholder level until course records exist; its list stays empty.
- Scope cascades top-down: a sub-standard takes its standard's scope unless it has its own (override).

### Champion

- Same shape as scope: an overall champion for the standard, and optionally a champion per scoped item (each program's
  own champion for Standard 4).
- Champions cascade top-down by default (a sub-standard's champion is its standard's) with optional overrides at any
  level and for any scoped item.

### External standards: the same menu, inherited through mappings

- External standards, sub-standards and requirements get the **same ⋯ menu**: Link evidence, Assign scope, Assign
  champion, Create cycle. It sits on the standards' tree in **Accreditations** (the engagement's standards), the
  operational place for external standards; the version page in Settings stays for authoring.
- What a node shows is inherited by default and labelled with where it comes from ("From IQF 4.2"); choosing an action
  on an inherited value creates an override on that node, and "Back to inherited" removes it.
- Evidence linked on the mapped IQF node already counts for the external requirement (collected once); "Link evidence"
  here adds evidence for this requirement only.
  Such a link targets the requirement by framework and code at the library level (`evidence_link.internal_framework_id` +
  `internal_code`, migration 0058; any framework, not only the IQF), so it carries over to new versions of the standard. The
  effective evidence of an external requirement is its direct links plus what its approved mappings inherit.

- An external requirement mapped to IQF nodes takes their scope and champion by default; it can override either.
- Mapped to several IQF nodes: scope is the union of theirs; the champion is inherited only when they agree, otherwise
  the screen asks for one.
- The same rule already planned for cycle plans (inheritance down the IQF, then to mapped external requirements, with
  override or opt-out at any level).

### Schema additions

| Table | Columns | Notes |
|---|---|---|
| `scope_level` | key, label_en, label_ar, kind (`institution` \| `org_unit` \| `program` \| `course` \| `custom`), display_order, active | Settings -> Organization -> Institution; seeded with the four levels |
| `requirement_scope` | requirement_id, level_key, item_ids uuid[] (empty = all at that level) | an own scope on a node; none = inherit |
| `requirement_champion` | requirement_id, scope_item_kind + scope_item_id (both null = overall), user_id | an own champion on a node (overall or per scoped item); none = inherit |

These are operational rows outside the immutable framework version: they attach to a requirement and are carried to
the next version together with mappings and evidence links when a new version is started.

## Templates

- Cycle templates live in Settings -> Quality Management (new section). QA creates, edits and versions them; a running
  cycle keeps the template version it started from.
- Defaults are shipped for: annual program report, periodic program review, admin unit review, internal audit, and a
  blank custom template. The institution's own templates can be imported through the Docs tab pattern later.
- Report templates (sections, word limits, guidance) are shared with Accreditations: one report engine for both menus
  (it is also M4's report work).

## Screens

- **Quality Management** (menu): the list of cycles (filter by subject, template, status, due), "New cycle" (pick
  subject and template, check owners and dates, launch), and a cycle page.
- **Cycle page**: the stages as a timeline and a list; each stage shows owner, dates, status, inputs (with what is
  missing), the process text and checklist, and the output slots with their state. Reports open in the report editor.
- **My work**: the stages I own and the approvals waiting for me.

## Worked examples the model must hold (owner, 2026-10-15)

Accreditor timelines below come from PRD §5.2 (the accreditors' pages were not reachable from the build environment).
All of them are **templates (data)**, never code (DEC-002).

| Example | Anchor · subject | Shape |
|---|---|---|
| **ABET program accreditation** (Accreditations) | engagement · program | Readiness review (request Apr–15 Aug, report 1 Sep) -> Request for Evaluation (31 Jan) -> Self-study report (1 Jul) -> Visit (Sep–Dec) -> Draft statement + 30-day due-process response -> Final statement (by 31 Aug next year) -> **Maintenance** (interim report if IR/IV; changes reported) -> **Re-accreditation** (next general review, typically 6 years) |
| **WSCUC institutional accreditation** (Accreditations) | engagement · institution | Eligibility (inquiry, alignment and financial review, decision within 60 business days, application) -> Self-study and Institutional Report -> Offsite review -> Visit -> Commission action, letter within 30 days -> **Maintenance** (Annual Report every year; progress reports, special visits) -> **Reaffirmation** (6/8/10 years per the action) |
| **ISO certification of an admin unit** (Accreditations) | engagement · org unit (IT, Facilities) | Stage 1 and stage 2 audits -> certification -> yearly surveillance audits -> recertification every 3 years |
| **IQF annual reporting** (Quality Management) | IQF · each program / unit | Collect -> self-evaluate -> review chain -> annual report; **every year**; optional extra cycles on a standard or sub-standard |
| **Course assessment** (Quality Management) | a standard, sub-standard or evidence item · program | Collect course results -> analyse -> report -> close the loop; **every semester** |
| **External standards mapped to the IQF** | the mapped requirement | follow the IQF's cycle by default; can be overridden at any level |

### What the model needs for these (additions to the schema)

1. **Recurrence.** Cycles repeat: every semester, every year, every N years, or "date set when the previous one ends" (an
   accreditor's decision fixes the next review: 6/8/10 years). A cycle run carries a `period_label` ("Fall 2026",
   "AY2026-27", "2026-2032").
2. **Nesting.** A stage can run a **child cycle**: WSCUC's maintenance stage runs the Annual Report cycle every year
   until the stage ends; ABET's maintenance runs an interim-report cycle only when the decision asks for one; ISO's
   surveillance audits are yearly child cycles. Re-accreditation is the **next run** of the parent cycle.
3. **Plans with inheritance.** A *cycle plan* attaches a template and a recurrence to an anchor ("the IQF: annual
   report, every year, for every program"; "Standard 4: an extra cycle every semester"). Down the IQF tree a node uses
   its own plan or its nearest ancestor's. An external requirement mapped to an IQF node uses that node's plan unless it
   has its own; any level can **override** (own plan) or **opt out**.
4. **Academic terms.** "Every semester" needs the institution's terms: a small list (name, start, end) in Settings.
5. **Where they are managed.** Cycles anchored to an accreditation (engagement) live in **Accreditations**; all others in
   **Quality Management**. Same engine, same screens, two menus.
6. **Subjects.** Accreditations need an org unit as a subject too (ISO for IT or Facilities); today an engagement's
   subject is the institution or a program.

### Schema additions

| Table / column | Notes |
|---|---|
| `cycle_plan` | anchor_kind, anchor_id; template_id; responsible_unit_id and owner (default for its runs); recurrence (`{ every: n, unit: 'term' \| 'month' \| 'year' }` or `{ after: 'previous_ends', setBy: 'decision' }`); first start date; applies_to (subject kinds, unit types, program levels, or a list); `mode`: `own` \| `opt_out` (inheriting is the absence of a plan); active |
| `cycle.plan_id` | the plan that produced the run (null for one-off cycles) |
| `cycle.parent_cycle_id`, `cycle.parent_stage_id` | nesting: the stage that runs this child cycle |
| `cycle.period_label` | "Fall 2026", "AY2026-27" |
| stage definition `child` | `{ templateKey, recurrence, until: 'stage_end' }` or `{ templateKey, when: 'output', output: 'decision' }` |
| `academic_term` | name, name_ar, start_date, end_date (Settings) |
| `engagement.subject_type` | add `org_unit` |

The scheduler that reads plans and proposes the next runs is small: for each plan (and each subject it applies to), the
next run is due when the previous run's period ends; QA launches it (proposed by default, per DEC-029).

### Relation to today's Accreditation roadmap

Engagements already have a lifecycle template with phases and milestones. To stay additive, the roadmap stays as it
is in the first build; an engagement can additionally have cycles (maintenance annual reports, interim reports). A
later step can express the lifecycle template itself as a cycle template, so both menus run on one engine.

## Schema (proposed)

Five new tables plus a permission set. Every table has the usual `id`, timestamps, `created_by/updated_by`,
`institution_id`, tenant RLS and the audit trigger. Forward-only migration; nothing existing changes.

### `cycle_template` — a reusable shape (Settings -> Quality Management)

| Column | Type | Notes |
|---|---|---|
| key | text | unique per institution, e.g. `annual_program_report` |
| name, name_ar | text | |
| description | text null | |
| anchor_kinds | text[] | which anchors it fits (see `cycle.anchor_kind`); empty = any |
| stages | jsonb | the stage definitions, validated by Zod (below) |
| version | int | +1 on each publish; a cycle keeps the version it was launched from |
| status | `draft` \| `published` \| `retired` | only published templates are offered |
| origin | `default` \| `manual` \| `import` | shipped default, made by hand, or imported from a document |

`stages` (one entry per stage, in order):

```ts
{
  key: 'self_evaluation', name: 'Self-evaluation', nameAr?: string,
  process: 'What to do…', checklist: ['…', '…'],
  unit: { kind: 'subject' } | { kind: 'parent_of_subject' } | { kind: 'unit_type', type: 'qa_office' } | { kind: 'cycle' },  // responsible unit
  owner: { kind: 'head_of_unit' } | { kind: 'role', role: 'lead' } | { kind: 'cycle_lead' },                         // owner within it
  startOffsetDays: 0, lengthDays: 30,
  outputs: [{ key: 'ser', name: 'Self-evaluation report', kind: 'report' | 'document' | 'approval' | 'note',
              required: true, reportTemplateKey?: string, approver?: <same shape as owner> }],
  inputs:  [{ key: 'last_final', name: 'Last year’s final report',
              from: { stage: 'final', output: 'final_report' }      // earlier stage, same cycle
                  | { previousCycle: { stage: 'final', output: 'final_report' } }
                  | { pick: 'document' | 'evidence' | 'requirement' | 'any' } }]
}
```

### `cycle` — one run

| Column | Type | Notes |
|---|---|---|
| title | text | defaults to template name + anchor + period |
| template_id, template_version | uuid null, int null | null for a blank cycle |
| anchor_kind | `institution` \| `org_unit` \| `program` \| `framework_version` \| `requirement` \| `evidence_item` \| `engagement` | what the cycle is about |
| anchor_id | uuid | polymorphic, checked by the service (like `engagement.subject_id`) |
| subject_kind, subject_id | `institution` \| `org_unit` \| `program`, uuid; both null | who does the work, when not the anchor itself |
| responsible_unit_id | uuid | the org unit responsible for the cycle (required) |
| lead_user_id | uuid | the cycle's owner (a person); fallback stage owner |
| status | `draft` \| `active` \| `completed` \| `cancelled` | |
| cancel_reason | text null | required when cancelled |
| start_date, end_date | date | end = last stage's end unless edited |
| previous_cycle_id | uuid null | the subject's previous run of the same template (for `previousCycle` inputs) |
| origin | `manual` \| `assistant` | `assistant` when made from a confirmed assistant proposal |

### `cycle_stage` — a stage of a run

| Column | Type | Notes |
|---|---|---|
| cycle_id | uuid | |
| key, name, name_ar | text | from the template (or typed, for a blank cycle) |
| process | text | |
| checklist | jsonb | `[{ text, done, doneBy, doneAt }]` |
| display_order | int | gap-free |
| responsible_unit_id | uuid | the org unit responsible for the stage; defaults to the cycle's |
| owner_user_id | uuid null | the person who owns the stage; resolved at launch, editable |
| start_date, end_date | date | from the offsets at launch, editable |
| status | `not_started` \| `in_progress` \| `completed` \| `skipped` | completed only when every required output is `final` |
| skip_reason | text null | required when skipped |
| started_at, completed_at | timestamptz null | |

### `cycle_output` — a slot the stage fills

| Column | Type | Notes |
|---|---|---|
| stage_id | uuid | |
| key, name | text | |
| kind | `report` \| `document` \| `approval` \| `note` | |
| required | bool | |
| state | `missing` \| `draft` \| `final` | |
| report_template_key, report_id | text null, uuid null | the report (shared report engine) |
| file_key, file_name, file_mime, file_size | null | the uploaded document (object storage, like other uploads) |
| note | text null | for `note` |
| approver_user_id | uuid null | for `approval`: who must sign |
| decision | `approved` \| `approved_with_conditions` \| `returned`, null | for `approval`; `returned` reopens the stage that produced the inputs |
| decision_comment | text null | required for `returned` and `approved_with_conditions` |
| finalised_by, finalised_at | uuid null, timestamptz null | |

### `cycle_input` — what a stage reads

| Column | Type | Notes |
|---|---|---|
| stage_id | uuid | |
| key, name | text | |
| source | `stage_output` \| `previous_cycle` \| `pick` | |
| output_id | uuid null | the `cycle_output` it reads (this cycle's earlier stage, or the previous cycle's), set at launch |
| ref_kind, ref_id | text null, uuid null | for `pick`: `document`, `evidence_item`, `requirement`, … |
| required | bool | shown as missing when not satisfied; never blocks (parked Q3) |

An input is *satisfied* when its `output_id` points at a `final` output, or its `pick` has a `ref_id`.

### Permissions

- `cycle:read` — everyone with read access.
- `cycle:manage` — create, launch, edit dates and owners, cancel (admin, lead).
- `cycle:work` — fill outputs on stages you own (any role); stage owners can always work on their own stage.
- An `approval` output can be decided only by its `approver_user_id`.

### Trash, Undo, audit

- Deleting a draft cycle sends it to the Trash with its stages, outputs and inputs; active and completed cycles are
  cancelled, not deleted.
- Edits return Undo descriptors like the rest of the app; every change is audited.

## Fit with what exists (additive)

- New tables only: `cycle_template`, `cycle` (with anchor kind + id and optional subject), `cycle_stage`, `cycle_output`
  (slots with their content reference) and `cycle_input` (links). Engagements and milestones are untouched.
- Reuses: org chart and roles (owners), uploads and documents, evidence picker, Trash, Undo, audit, the Docs tab.
- Accreditation milestones already have owner, due date and deliverable; they could later be described as stages too,
  but that is not part of this task.

## Parked (not in the current focus)

1. Who may create and launch cycles: QA only, or also a unit head for their own unit?
2. A "next cycle" button on a completed cycle (copy with new dates, carrying final reports as inputs).
3. Whether a missing input can block a stage from starting (a hard gate) or is only shown as missing.
