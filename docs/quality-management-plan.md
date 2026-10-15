# Quality Management — design draft (TASK-077)

Status: draft, in design with the owner (2026-10-15). Nothing here is built.

## Owner's answers so far

- Each unit or program runs its own rhythm; there is no shared institution year.
- The review chain is configurable per cycle template.
- Outcome assessment (PRD §13: outcomes, measures, targets, results) lives in Quality Management.
- One shared action register for Quality Management and Accreditations (sources: self-evaluation, assessment, accreditor finding).
- Cycle kinds: generic custom, annual program report, periodic program review, admin unit review, internal audit.
- Cycles are defined at several levels: the whole IQF, a standard or sub-standard, and evidence collection. The same holds for external standards.
- KPIs and measure values from BI: out of scope for now.
- AI: draft narratives, suggest actions, summarise for leadership (AI proposes, humans approve).

## Core idea: one obligation scheduler for both menus

Time is attached to the framework, not to the menu. Any framework (IQF or external) can say how often something happens at any level, and one scheduler turns that into dated work for a subject (a unit, a program, the institution). Quality Management and Accreditations both read the same obligations; they differ only in whose framework and which cycle templates they use.

### Two kinds of time

1. **Review cadence** — how often a subject evaluates itself against a node of the framework (whole IQF every 5 years; Standard 3 every year). Set on any node; a node without one takes its nearest ancestor's (inheritance, overridable lower down).
2. **Evidence cadence** — how often a piece of evidence must be collected or refreshed (course syllabi each term; graduate survey every year). Set on an *evidence expectation* hanging off a requirement. Independent of the review cadence: evidence is collected continuously; reviews read whatever is current.

### Objects (proposed)

| Object | What it is |
|---|---|
| `cadence` | A rule: every N terms/months/years, anchored to a date or to the academic calendar, with a due window; or "on event" (new program, accreditor finding, change notice). |
| `cadence_rule` on a framework node | The default cadence for a framework version, level by level (whole framework, standard, sub-standard, requirement). Versioned with the framework (like the lifecycle template); the AI compiler can propose it from phrases like "reviewed every five years". |
| `evidence_expectation` | On a requirement: what evidence is expected, its cadence, who usually provides it (role or unit type), optional form. |
| Applicability | Which subjects a cadence applies to (unit type, program level, a list of units), so graduate programs can be on 7 years and undergraduate on 5. |
| Subject overlay | A unit's own exceptions (dates, a skipped year with a reason), outside the immutable framework version. |
| `cycle_template` (Settings) | A kind of cycle: steps with due-date rules, scope (whole framework or chosen standards), review chain, report template. Kinds: annual program report, periodic program review, admin unit review, internal audit, custom. |
| `quality_cycle` | One run for one subject, from a template: period, steps, status. Created when the scheduler says it is due (proposed to QA, or launched automatically if the template says so). |
| Self-evaluation item | Per cycle × requirement in scope: narrative, evidence links, status through the review chain up to "Internally approved". Never "met"/"compliant". |
| Collection task | Per evidence expectation × subject × period: who must provide what by when; reuses evidence requests. |
| Action (shared) | Improvement action with source (self-evaluation, assessment result, accreditor finding, audit finding), owner, due date, follow-up. |

### How IQF and external standards meet

- The IQF↔external mappings already exist. When an external expectation maps to an IQF one with an equal or more frequent cadence, the scheduler does **not** create a second collection task: one collection serves both.
- Accreditation maintenance (annual reports, follow-ups) keeps its lifecycle template; per-standard evidence cadences in external frameworks (e.g. continuous-improvement data each year) become collection tasks inside the engagement through the same scheduler.

## Screens (proposed)

Overview (subjects, cycles due and running, overdue) · My work · Cycles (per subject) · Standards (IQF tree with each subject's latest review status) · Evidence collection (calendar of expectations) · Actions (shared register) · Assessment (outcomes, measures, results) · Reports.

## Decided (2026-10-15, DEC-029)

- Cadences live in the framework version (versioned, AI-proposable) plus a per-subject overlay for dated exceptions.
- When a cycle falls due it is proposed and QA launches it; per-template automatic launch later.
- An academic calendar (years and terms) in Settings.
- Cadences can differ by unit type, program level or a list of subjects.

- Review chain steps are org-chart based: "head of the unit", "head of the parent unit", "QA office", "Quality committee", resolved per subject from the org chart and roles.
- A reviewer can comment and return, approve, approve with conditions (creating actions in the shared register), and review per item (one standard at a time) as well as the whole cycle. The last approval reads "Internally approved".
- Report templates: defaults per cycle kind, and import from the institution's own templates through the Docs tab pattern.

## Build order (proposed)

1. **Foundations:** academic calendar (years, terms); cadence rules on framework nodes and evidence expectations, edited on the IQF and standards version pages and proposed by the AI compiler; applicability; subject overlays.
2. **Cycles:** the scheduler (what falls due, per subject); cycle templates (defaults, import from documents); quality cycles proposed and launched by QA; self-evaluation items; the org-chart review chain with per-item review.
3. **Evidence and actions:** collection tasks (reusing evidence requests), one collection serving mapped IQF and external expectations; the shared action register (engagement actions move into it).
4. **Assessment:** outcomes, measures, targets, results (PRD §13), linked to requirements.
5. **Reports and AI:** annual and periodic reports from templates; AI drafts narratives, suggests actions and summarises for leadership.
6. **Accreditations on the scheduler:** external standards' cadences become collection tasks inside engagements; maintenance views read the same obligations.
