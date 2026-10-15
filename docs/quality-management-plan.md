# Quality Management — Cycles and Reporting (TASK-077)

Status: design, revised with the owner on 2026-10-15 (DEC-029). Nothing is built yet.

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
- **Owners**: the template says who, as a role or an org-chart rule ("head of the unit", "head of the parent unit",
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
