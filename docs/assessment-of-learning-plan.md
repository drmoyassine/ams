# Assessment of learning (AOL): what the AMS/QMS must hold

Source material (2026-11-01, owner): AIU Policy IE-001 (SLOs Assessment, 14 June 2026), the QAIEO *Course and Program AOL Interim
Guidance* for Fall 2026-27 (V3a), the EDUVAL upload templates (*CL CLO-PLO Mapping*, *CL Course Details*) sent by the Chief Digital
Transformation and AI Officer, the owner's *Program Assessment Plan & Report* template and *Integrated Assessment Plan* workbook,
and the program review rubric of the baseline audit the President asked for. Three collections run in parallel today (QAIEO
guidance, EDUVAL, the integrated plan). **They share one data model; the AMS keeps it once and exports each format.** No code is
written yet; the tasks under ROADMAP-014 build it after TASK-104 (program schema) and TASK-105 (courses).

Rules that carry over unchanged: no accreditor- or institution-specific code (DEC-002): level names, benchmarks, cycle lengths and
rubrics are configuration; official ≠ internal (DEC-005): the words are "at or above target" / "below target" and maturity levels,
never "met" or "compliant"; evidence files never go to a model (DEC-013).

**Status (2026-11-01):** built — sections 1-7 and the workbook load of section 8 (migrations 0073-0075, `packages/core/src/outcomes/`,
Settings -> Organization -> Programs, Courses, Learning outcomes). Open: the EDUVAL export (TASK-113), linking corrective actions to
quality-cycle runs, and survey imports as dataset sources.

## 1. The outcome hierarchy

```
Institution ── ILO (institutional learning outcome, approved by the Board on Faculty Council recommendation)
  └ School / College (org_unit) ── Department (org_unit)
      └ Program (TASK-104) ── mission, vision (one approved version, cited by the website and the catalog)
          ├ PEO  (program educational objective: what graduates achieve a few years after graduation; reviewed with constituencies)
          ├ PLO  (program learning outcome; ABET calls it SO) ── performance indicators (sub-outcomes, e.g. SO2.1 … SO2.5)
          └ Course (TASK-105, many-to-many through course_program: core/elective/service, year, term)
              └ CLO (course learning outcome; one measurable verb, Bloom level)
```

| Entity | Fields (beyond id, institution, audit columns) | Notes |
|---|---|---|
| `ilo` | code, text (en/ar), order, status, approved_on, approval_ref | One approved list with fixed numbering. The catalog has 7 ILOs, the QAIEO guidance 8 with other names: the first job is one list. |
| `peo` | program, code (PEO1…), text, status, approved_on, review_cycle_years, last_reviewed_on | Versioned: a change keeps the old text (history is evidence for "changes documented"). |
| `plo` | program, code (PLO1/SO1…), text, bloom_level, status, approved_on | ABET programs use the standard SO texts; programs without accreditor outcomes write their own. |
| `performance_indicator` | plo, code (SO2.1), text, bloom_level | The guidance asks every program for them. |
| `clo` | course, code (CLO1…), seq, text, bloom_level, status | Course ID + CLO code unique (EDUVAL rule). |
| `outcome_link` | from (clo/plo/peo), to (plo/ilo/peo), level (configurable), program | CLO→PLO carries the level; PLO→ILO and PLO→PEO plain links. A CLO serves several PLOs; one row per pair. |

**Mapping levels are configuration** (decision DEC-036): default `I` Introduced, `R` Reinforced, `M` Mastered; `D` (Developed, the
QAIEO wording) is accepted as a synonym of `R` on import. Coverage checks: every PLO reaches `M` somewhere; every required course maps
to at least one PLO; orphan and over-covered outcomes are listed (the EDUVAL "PLO Coverage" tab and the rubric criterion 4).

## 2. The assessment plan (IE-001, per program, every year)

For every PLO: the approved statement; the **benchmark** (e.g. 75% of students at "Meets expectations" or above); the **direct**
method (instrument, the course it is embedded in, at the Mastered level, rubric); the **indirect** method (survey, focus group,
external feedback; frequency; respondents); the responsible faculty; the calendar (weeks of collection, submission date); the
assessment year in a rotation where **every PLO is directly assessed at least every two years** (half the PLOs each year) and a
re-assessment year. Reviewed yearly by the Assessment Coordinator, endorsed by the Dean, submitted to QAIEO before the year starts; a
program without a current approved plan is flagged (QAIEO notifies the VPAA within 10 working days of the deadline).

Benchmarks are institution settings with a program override: a CLO threshold (score and share of students, e.g. 75% / 70%), a PLO
threshold, and an indirect threshold (e.g. 4.5/5). The guidance leaves the AIU values open; the AMS must not hard-code any.

## 3. Course-level attainment (the QAIEO method, direct measures)

1. Each assessment (quiz, assignment, mid, final…) is split into questions; each question carries marks and one or more CLOs.
2. CLO share of an assessment = marks on that CLO / total marks; CLO contribution = share × class average (or per student when
   student-level marks are available).
3. Summed over the course's assessments: attainment per CLO and overall; CLO → PLO roll-up through the course's CLO-PLO links.
4. Per CLO and per PLO: the share of students at or above the score threshold, compared with the benchmark → at or above target /
   below target. A below-target CLO or PLO opens an action (section 5).
5. Diagnostics the guidance asks for: weight of each CLO in the assessment design (CLO 4 worth 3% is a design issue, not only a
   learning issue), bottleneck courses, comparison with the previous offering.

The ECE files show today's shape: **CAP** (course assessment: per SO, the CAF weight, the tool weight and the score), **CAS** (student
course survey: per CLO mean ± sd out of 5, response rate; > 60% wanted), the instructor report, the focus-group report, the
SO assessment matrix (course × SO, tool, term) and the frequency table of indirect tools (alumni and employer surveys every 2 years,
training survey and course surveys every semester, advisory board yearly, graduation project survey). Import of these sheets is a
DataSource of the dataset layer (DEC-012: governed numbers only through `datasetSource.fetch()`); student-level marks stay in the
BI (nothing student-level leaves it, BI rule 5) and reach the AMS as aggregates.

## 4. Indirect measures

Course surveys mapped CLO → PLO; focus groups (participants, 6-10 recommended; reflection with root cause and comparison with the
previous year); alumni, employer, graduate exit, internship supervisor surveys; advisory board input. Each is an instrument with a
frequency and a responsible person, its results a dataset response with sample size and response rate.

## 5. Closing the loop: the corrective action plan (CAP)

For every PLO (or CLO) below its benchmark in a cycle: the gap and the share of students above/below; root-cause analysis; the action
(what changes, where, when); the owner; the implementation term; the **verification plan** (how and when the program re-assesses);
then the re-assessment result linked back. For a PLO at or above target: the confirmation, contributing factors and the next plan.
An assessment cycle without a documented close-the-loop step is incomplete (IE-001). These are action items of the quality cycles
(ROADMAP-013) with a link to the outcome and the result that opened them.

## 6. The annual cycle and the ILO rotation

A cycle template (ROADMAP-013) per program per year: **Plan** (September/January: PLOs and ILOs to assess, methods, benchmarks,
assignments, calendar) → **Collect** (during the semester) → **Analyse** (within 20 working days of semester end: above / near /
below target, contextual factors) → **Close the loop** (within 30 working days; reported in the Annual Assessment Report). The ILO
rotation (two or three ILOs a year over five years, year 5 a full review) is an institutional cycle fed by aggregated data from
designated courses, producing the yearly ILO Assessment Audit Report for the Faculty Council and the President.

## 7. The program review rubric (baseline audit)

Eight criteria, each with key questions and evidence to review: 1 mission, 2 educational objectives, 3 PLOs, 4 PLO-to-CLO mapping,
5 assessment design, 6 assessment results, 7 closing the loop, 8 stakeholder input and external validation. A review records per
program and criterion: an internal maturity **level** (configurable; default Not evident, Emerging, Developing, Established, plus
Pending review), the finding, the evidence seen (links to evidence items), the gaps, the audit date and the reviewer. It is an
internal self-rating (P1 self-rating, ROADMAP-010) and is never shown as an accreditation outcome. The rubric is configuration (an
internal framework with the 8 criteria as requirements works today; the level scale is the new part).

## 8. Import and export formats

| Format | Tabs / fields | Direction |
|---|---|---|
| EDUVAL *CLO-PLO Mapping* | CLOs (Course ID, Course Title, CLO ID, CLO Text); PLOs (Program ID, Program Title, PLO ID, PLO Text); CLO-PLO Mapping (Program ID, Course ID, CLO ID, PLO ID, Mapping Level I/R/M) | export (and import) |
| EDUVAL *Course Details* | per course (COLLEGE, DEPT, CRSE, SHORT_TITLE): Description; CLOs (SEQ, CLO, PLO map); Required textbook (title, publisher, author, ISBN, year); Recommended reading (type list); Weekly outline (week, topic, CLO no, type list); Assessment methods (category, type, weight, CLO mapping, teaching method, performance indicator, institution and NQF competencies); Objectives; Learning methods | export (and import) |
| Integrated Assessment Plan | Programs (mission, PEOs, PLOs), PEOs, PLOs (ILO, courses, CLOs), courses, CLOs (activities, assessment methods), PLO-course-CLO mapping with level, rubric, report | export |
| QAIEO forms | syllabus CLO table with Bloom level and CLO × SO/ILO map, CAP/CAS sheets, focus group, CAP template, five-year plan (Table 8) | import of results; export of plan |

IDs follow the student information system (Course ID and Program ID as text, same spelling everywhere): the course and program
`externalId` (TASK-104/105) is the join key. The course-details fields (textbooks, weekly outline, assessment methods with weights)
belong to a **course offering / syllabus** record, versioned per term, not to the course itself.

## 9. Order of work

1. Outcomes and links (ILO, PEO, PLO, indicators, CLO, links with configurable levels), after TASK-104/105; screens on the program
   and course; coverage checks. 2. Imports/exports above (EDUVAL first: that is what is being requested of programs now). 3. The
   program assessment plan. 4. Course results and attainment (dataset sources, roll-up) and indirect measures. 5. Closing the loop on
   the cycles. 6. ILO rotation and the institutional report. 7. The rubric review with levels and its report.
