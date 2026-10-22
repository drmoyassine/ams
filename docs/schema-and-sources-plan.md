# Sources by URL, cycle template resources, and schemas for everything — requirements and plan (2026-10-21)

Recorded from the owner (2026-10-21):
1. Everywhere a document can be provided for scraping (AI-powered), a **URL** can be provided as well.
2. When creating or editing a **cycle template**, documents and/or URLs can be uploaded as **resources**, like the org chart and programs.
3. **Programs have a schema.**
4. **Courses have a schema.**
5. **Everything has a schema.**

Decision: DEC-033. Tasks: TASK-102 to TASK-106. Nothing is built.

## 1. What exists

| Piece | Today |
|---|---|
| AI-powered document places | Standards (source documents), Programs, Org chart, Glossary: each has a Docs tab and the shared import engine (TASK-075). Uploaded files only. |
| A link instead of a file | Evidence can register a URL (it is not AI-powered, DEC-013). Documents for import need a stored file (`file_path`, `sha256`). |
| Cycle templates | Editor in Settings; no documents, no AI. |
| Program | `orgUnit`, `nameEn`, `nameAr`, `degreeLevel`, `discipline`, `tags`, `active`. The review already shows code, duration and mode but "the program record has no column for these yet". |
| Course | Not an entity. "Course" is a placeholder scope level with an empty list. |
| Schemas | Each entity has Zod (API) and Drizzle (database) definitions, written separately. The evidence item's schema was fixed on 2026-10-20 (DEC-031). There is no single place that lists every entity's fields. |

## 2. Analysis and proposed design

### 2.1 URL as a source (TASK-102)
A URL is fetched **by the AMS**, stored as a snapshot, and from then on behaves exactly like an uploaded file: same pages, same
AI import, same review. So no engine change, only a **fetch step**:
- **Where:** every place with a Docs tab (standards, Programs, Org chart, Glossary, and now cycle templates and Courses) and the
  standards' "Create from files". One shared "Add by URL" next to Upload.
- **Fetcher:** one internal function (one import point, like parseDocument()). HTTPS only; blocks private, loopback, link-local and
  metadata addresses, re-checks after every redirect and after DNS (no DNS rebinding); size and time limits; a few redirects; allowed
  content types (PDF, Word, Excel, PowerPoint, images, plain text, **HTML**). No cookies or logins: pages behind a login are not
  supported (say so plainly).
- **HTML:** turned into readable text pages (main content, headings, tables) behind `parseDocument()`, so the parser stays the only
  reader of documents.
- **Snapshot and refresh:** the fetched bytes are stored like an upload with `source_url` and `fetched_at`; **Refresh** fetches again,
  and a changed page becomes a new version of the same source (the old one is kept; the review shows what changed). No automatic
  re-fetching in this task.
- **Egress:** the agent and parser services need outbound HTTPS; on a locked-down host that is an environment setting, documented.
- **Not for evidence** (DEC-013): evidence keeps registering URLs as links and never sends them to the AMS's AI.

### 2.2 Cycle template resources (TASK-103)
A cycle template gets a Docs tab (a new scope kind `cycle_template`), like Programs. Two uses of the same documents:
- **Reference:** the procedure, policy or manual a cycle follows, kept with the template and shown on cycles made from it.
- **AI-powered import:** a new target that proposes **stages** (name, process text, checklist, outputs, inputs, owner rule and offsets
  where the text says them) from the documents, reviewed in the shared review screen and applied to the **draft** template, as one
  undoable change. Never edits a published template (revise first).

### 2.3 Program schema (TASK-104)
Fix the Program fields so they are columns, not just review cells:
`code`, `nameEn`, `nameAr`, `degreeLevel`, `discipline`, `orgUnitId` (owner), `mode` (full-time, part-time, online, blended),
`durationYears`, `credits` (total), `languageOfInstruction`, `campus`, `status` (planned, active, suspended, closing, closed),
`startYear`, `description` (the program's definition, in the evidence item's wording), `tags`, `externalId` (for the BI and the
student system). The import target writes them; the Programs screen shows and edits them. Migration is additive and every existing row stays valid.

### 2.4 Course schema and entity (TASK-105)
A real Course record, because scope, assessment cycles ("course assessment every semester") and the BI all need it:
`code`, `titleEn`, `titleAr`, `description`, `credits`, `level` (year of study), `languageOfInstruction`, `orgUnitId` (owner),
`status`, `externalId`, and a **many-to-many link to programs** (`course_program`: program, role core / elective / service, year,
term). Learning outcomes belong to a later assessment task. UI: a third tab **Courses** under Settings → Organization (DEC-028 had
two tabs; this is a change to record) with list, form, bulk delete to the Trash with Undo, and a Docs tab (import from a course
catalogue). The "Course" scope level in TASK-086 then lists real courses.

### 2.5 Everything has a schema (TASK-106)
A **single declared schema per entity** (fields: key, label EN/AR, type, required, choices, definition text, limits), kept in
`packages/shared`, and the other things **derive** from it instead of repeating it:
- the Zod used by the API and by the AI extraction (an import target's schema is built from the entity's);
- the review screen's choices (the fixed-list fields) and column order;
- the BI contract: a read route `GET /api/bi/v0/schema/{entity}` and a generated `docs/data-dictionary.md`;
- a read-only **Data dictionary** in Settings (every entity, field, type, required, choices, definition), exportable as JSON/CSV;
- a test that fails when an entity's database columns and its declared schema disagree.
First entities: evidence item, evidence version, dataset spec, program, course, org unit, framework requirement, report template
(when built), cycle template. The rest follow the same way as they are touched.

## 3. Order and size

1. **TASK-106** first (small registry plus the dictionary; later tasks use it).
2. **TASK-104** (program columns), **TASK-105** (courses) on it, in parallel.
3. **TASK-102** (URL fetcher) independent, can run beside 104/105; the biggest security-sensitive piece.
4. **TASK-103** after 102 and the registry.

## 4. Risks
- **Fetching arbitrary URLs from a server is the classic SSRF risk.** The fetcher is the one place that touches the network for
  sources; it gets its own tests (private ranges, redirects, rebinding, oversize, wrong type).
- **Websites change or block bots.** Snapshot-on-fetch keeps a record of what was read; refresh is manual.
- **Terms of use / copyright of web pages** are the institution's responsibility; the AMS stores what it fetched and says where from.
- **Scope creep in "everything has a schema":** only declare what is used; do not let it become a second ORM.

## 5. Questions for the owner
1. URL sources: are **HTML pages** welcome (text extracted), or only documents (PDF, Word, Excel)? Any domain allow-list required by IT?
2. Courses: do they come from a catalogue import now and the student system / BI later? Is a course a member of **several programs**?
3. "Everything has a schema": a **read-only data dictionary** that the code derives from now; are **custom fields** per institution wanted later?
4. Programs: is the field list above right? Anything missing (accreditation status, department, intake terms)?

## 6. Added 2026-10-22: furnishing the IQF and standards by documents; embeddings

**Documents to update or furnish standards (TASK-107).** An external standard can already be furnished by documents while its version is
a **draft**: the analysis adds new requirements by code, updates the ones the AI wrote, and keeps what a person edited. Gaps: the
**IQF has no Docs tab or analysis** (it is only extended by proposals from external standards and by hand); a **published** version is
frozen, so documents must go to a new draft; URLs wait for TASK-102; proposing **edits to the wording** of human-written requirements
as a reviewable diff does not exist (open question).

**Embeddings (TASK-108).** Built (DEC-023, TASK-050/051): `embed()`, the `embedding` table, hybrid vector + word ranking, a Settings
account and model with a probe for the dimension. Used only by the **IQF mapping** stage, **off by default**, and **not measured**
(words-only recall@10 was 48.4%; TASK-056 decides the default). Not built: vectors kept current when text changes (a job and a Rebuild
action), search by meaning in the library, "similar requirements", a read tool for the assistant, status in Settings. Framework
text only: evidence, datasets, memories and requests are never embedded (DEC-023, DEC-013); the BI does retrieval over evidence
(DEC-019). TASK-068's "meaning-based memory search" conflicts with that rule and needs its own decision.

