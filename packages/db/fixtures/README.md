# Framework fixtures

Test data for every milestone (PRD Appendix A). Each file is a framework export (`format: "ams-framework"`) that the
importer accepts and `pnpm test` loads, publishes and exports again.

| File | Source in the PRD | State |
|---|---|---|
| `wscuc-2023.json` | A.1 WSCUC (institutional) | **Skeleton** |
| `abet-eac-2027-28.json` | A.2 ABET EAC (program) | **Skeleton** |
| `puc-2019.json` | A.3 PUC Kuwait (institutional, Arabic) | **Skeleton** |

## What is real and what is a placeholder

Everything the PRD specifies is carried over as written: level labels, the lifecycle (phases, milestones, due rules),
the decision, finding and response vocabularies, and the report-template structures.

The accreditors' own text is **not** here, because the source documents are not in the repository and `official_text`
must be verbatim (DEC-006):

- Requirement `official_text` is empty, and titles are the accreditor's codes ("CFR 2.4") or, where the PRD gives a
  name (ABET criteria, PUC standards), that name in English. Replace them with the official wording.
- WSCUC lists only Standards 1-4 and CFRs 1.1-1.8, 2.1-2.14, 3.1-3.11, 4.1-4.8. The PUC fixture has the 7 standards
  without measures or indicators, and no Arabic titles. The ABET fixture has Criteria 1-8, one example program
  criterion and two APPM policy items.
- No source documents, page text, quotes or notes yet, so nothing is quote-verified.
- Data-table columns are given only where the PRD lists them (WSCUC alignment review, ABET Table 5-1); the others
  carry a single placeholder column to be completed from the questionnaire.

Open items the PRD marks "confirm" are kept as milestone descriptions rather than guessed: WSCUC annual-report
due date (no recurrence set), information-request and annual-report-query reply windows, the PUC committee-review
step, and every ABET follow-up offset ("verify against the current APPM").

Real fixtures are TASK-011 (WSCUC, PUC) and TASK-012 (ABET). They replace these files once the documents are
supplied; the tests do not depend on any particular wording.
