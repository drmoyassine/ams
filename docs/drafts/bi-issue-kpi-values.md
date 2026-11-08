# Draft for the BI (label `for-bi`): what the AMS will ask of it for KPIs (not filed)

The AMS now treats evidence as a **KPI or a document** (AMS DEC-037). A KPI's card (symbol # % $, scope, targets, thresholds, owner)
lives in the AMS; its formula and values are the BI's when connected, as in the BI's DEC-007. What the AMS will ask for:

1. **A reading per course offering.** For a course-scope KPI, one set of rows per offering (course, term, section) with one row per
   CLO: the CLO code, the share of students at or above the threshold, and the number of students assessed. Aggregates only; hidden
   under the BI's small-count rule. The AMS adds the CLO text and the PLOs it maps to from its own course and outcome tables.
2. **Offerings as an entity.** A configured entity (course ID, term, section) so a result can be keyed; the AMS keeps a label-only
   offering record and joins on course ID, term and section.
3. **The metric names** exposed with `meta.metric`, one per KPI the AMS points at, with period and dimensions, as `collect` reads today.

Nothing here changes the contract yet; if it needs a new field, the AMS changes the contract first.
