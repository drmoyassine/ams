# AMS ↔ BI contract, v0 (draft)

Status: **draft v0, 2026-10-19; sections 3.1, 3.3 and 3.6 rewritten 2026-10-20 (DEC-031, TASK-089).** Written so the BI work can start in parallel with the AMS. Not implemented as an API yet:
everything marked **[exists]** is in the AMS today (the data and the services behind it); **[planned]** is decided but not
built; **[open]** needs an answer. v0 becomes **v1 at the freeze** (see "Freeze"): after that it changes only by addition.
Source decisions: DEC-031 (the evidence item: type, definition, collection method, schedule), DEC-017 (separate products, separate storage), DEC-019 (evidence may be shared with the BI, whose AI may
process it), DEC-013 (the AMS itself makes no AI calls on evidence), DEC-005 (official status is separate from internal
approval), PRD §9.4 to §9.6 (datasets and the governed-metric adapter).

## 1. The two systems

- The **AMS** owns the accreditation workflow: standards, mappings, engagements, cycles, reports, and the **evidence
  register** (what evidence exists, what it supports, who approved the link). It stays usable without the BI (PRD §9.6).
- The **BI** owns data: sources, warehouse, the governed metric layer, document search and its own AI over documents.
- They meet at one boundary: **evidence definition** (what evidence the AMS needs and how it is produced) and **evidence
  supply** (what the BI hands back). Neither reads the other's database. No write-back from the BI into accreditation
  records (decisions, official status, reports, approvals); those stay in the AMS.

```
        evidence definition (AMS -> BI)
 AMS ───────────────────────────────────────▶ BI
  ▲        needs, dataset specs, scope, due     │
  └──────────────────────────────────────────── ┘
        evidence supply (BI -> AMS)
        versions, files, dataset rows, lineage
```

## 2. Principles

1. **The AMS decides what counts as evidence for a requirement; the BI produces and finds it.** A link between evidence and
   a requirement, its reason and its approval are made in the AMS.
2. **A dataset item is the stable handle.** Reports, links and history point at the dataset item, never at its source.
   Switching `manual_upload` to `governed_metric` changes no report (PRD §9.6).
3. **Versions are append-only.** Every supply is a new evidence version with `as_of` and lineage; nothing is edited in
   place. A submitted report's snapshot never changes when new versions arrive.
4. **Aggregated, suppressed, no student-level rows** through the governed-metric path (PRD §9.5). Files that contain
   student data are flagged and `restricted`; the BI only receives what DEC-019 allows and the AMS permission model lets
   the service identity read.
5. **Official ≠ internal.** The BI never sets, and its data never implies, "met", "compliant", a readiness score or an
   official status.
6. **Host-agnostic.** HTTPS + JSON, bearer credentials, no vendor SDKs on either side.

## 3. Objects

### 3.1 Evidence item **[exists]**
An evidence item is a **title**, a **type** and a **definition**, with an owner, a confidentiality, tags and a status (DEC-031).
`id`, `title`, `type` (`document` | `dataset`), `definition` (what the evidence is and what it must contain; for a dataset, what the
data means: who is counted, from where, for which period), `subtype`, `ownerUserId`, `ownerUnitId`, `periodLabel`, `confidentiality`
(`public` | `internal` | `restricted`), `containsStudentData`, `tags[]`, `status` (`active` | `archived`), and how and when it is collected:
- `method` (**one** per item): `manual` (the owner uploads a file, registers a link or types the data), `form` (the dataset's online form
  and spreadsheet template; datasets only), `request` (ask a named person or an email address), `bi` (the BI supplies it, the case this
  contract is about) or `survey` (reserved: accepted, not yet selectable).
- `methodConfig`, validated per method (unknown keys are refused):
  - `manual`: `{ instructions?, expectedFormat? }`
  - `form`: `{}` (the questions are the dataset's columns, 3.3)
  - `request`: `{ assigneeUserId | assigneeEmail` (exactly one)`, note? }`
  - `bi`: `{ endpointKey?, query?, period?, timeoutSeconds? }` where `endpointKey` is a **name** the AMS resolves from its own environment
    (never an address typed by a person; letters, digits, `_`, `.`, `-`, starting with a letter), `query` is **structured data, never SQL**:
    `{ metric, dimensions?: string[], filters?: [{ field, op: eq|ne|in|gt|gte|lt|lte, value }] }` (names are letters, digits, `_`, `.`, `-`),
    `period` is the grain asked for (`day` | `week` | `month` | `quarter` | `semester` | `year`; absent = the schedule's), and
    `timeoutSeconds` (1 to 600) is how long the AMS waits for the answer. A `bi` item may be a document or a dataset; **a dataset is
    recommended**, because it carries columns the BI's answer is checked against.
  - `survey`: `{}`
- `schedule` (`null` = none): `{ every: day | week | month | quarter | semester | year, startDate (yyyy-mm-dd), dueAfterDays (0 to 3650),
  timezone (IANA) }`. Period starts are calendar dates counted from `startDate` (a month keeps its day of the month, or the last day of a
  shorter month; a quarter is 3 months, a year 12), each placed at the local midnight that begins it in `timezone`, so daylight saving never
  moves them; the evidence is due `dueAfterDays` after the period starts, at the end of that local day. `semester` means each **term** of
  the institution's academic calendar (3.6); a period the calendar does not define is a gap, not a guess.
- `nextDueAt`, `lastRunAt` (timestamps, null until there is one) are kept by the AMS.
The old fields `description` and the type `data` no longer exist: `description` is `definition` and `data` is `dataset`.

### 3.2 Evidence version **[exists]**
`id`, `evidenceItemId`, `versionNo` (append-only), the content (`file` with `sha256`, `fileName`, `mime`, `size`; or a
registered `url`; or `data` rows for datasets), `asOfDate`, `notes`, `lineage` (jsonb: who supplied it, from what).

### 3.3 Dataset specification (`dataset_spec`) **[exists]**
One per dataset item: `grain` (e.g. "programme × academic year"), `columns[]` (`key`, `label`, `type`, `unit`, `required`, `choices`, `help`),
`sourceKind` (`manual_upload` | `governed_metric`), `sourceConfig` (for `governed_metric`: a structured query, never SQL), data owner. **What the
data means is the item's `definition` (3.1)**; the specification has no definition of its own any more (DEC-031: the two were merged). The
columns are the questions of the online form (`method: form`) and what a BI answer is checked against (`method: bi`). **[planned for periods]**:
`periods` and `refresh` (`manual` | `on_open` | `scheduled`) as in PRD §9.4 are now the item's `schedule` (3.1). `sourceKind` and `sourceConfig` (the
governed-metric adapter, 3.7, PRD §9.5) and the item's `method: bi` overlap and are to be reconciled with the runs (TASK-090, M9): the proposal is
that the method says WHEN and by WHOM the item is collected, and the source configuration says WHAT the governed metric is.

### 3.4 Evidence link **[exists]**
Evidence version to a target, with a required `rationale` and a review (`proposed` | `approved` | `rejected`). Targets: an
engagement requirement, an item of the IQF, or (since 2026-10-19) a requirement of any framework, keyed by framework and
code so it survives new versions of the standard. Approving is an AMS act; the BI cannot approve.

### 3.5 Evidence request **[exists]**
A request for evidence on an IQF item, sent to a person or an email address (one-time link, DEC-018), answered with a file or
a form. The answer becomes evidence with a proposed link.

### 3.6 Evidence need = a collection run **[planned: TASK-090]**
An evidence **need** is no longer a separate object or a cycle (DEC-031): it is a **collection run** of an evidence item, made for each period of
its schedule. What exists today is the definition side (3.1: type, definition, method, settings, schedule, next due) and the pure function that
lists a schedule's periods; **nothing fires a schedule or calls the BI yet** (TASK-090).
What exists for the calendar since TASK-081 (migration 0062): the institution's **academic calendar** (`academic_term`: years and terms with dates and English and Arabic names), which a `semester` schedule reads. Scope and champion on standards (TASK-086) stay plain facts that tell the BI where a standard applies and who answers for it. The earlier cycle plans on evidence items (TASK-081, TASK-087) are still stored and listed, but evidence is no longer collected by cycles and they are not a source of needs.
A run (planned):
- `id`, `evidenceItemId`, the period (`periodStart`, `periodEnd`, `periodLabel`, e.g. "Fall 2026"), `dueAt`, `status` (`pending` | `requested` | `supplied` | `late` | `failed` | `skipped`),
  the evidence version that supplied it, and the reason for `failed` or `skipped`.
- By the item's method a job fires the run: `bi`: the AMS **sends the BI an API request** (the endpoint resolved from `endpointKey` in the AMS's environment, the
  structured `query`, the period, the timeout) and waits for the response; the request carries a **per-run one-time token** (stored as a hash, expiring, used once)
  for the BI's callback if it answers later; `request`: the evidence request is sent (DEC-018); `form`: the dataset's form is opened for the period (DEC-020);
  `manual`: the owner gets a task in My work.
- The BI reads the runs addressed to it to know what to produce and for whom, and supplies against them (4.2). A failed, timed-out or refused call makes the run `failed` with the reason; a person retries or skips it.
- Open: the exact request and callback bodies (to be written with TASK-090 and frozen with the other routes), and whether a failed call retries by itself.

### 3.7 Governed metric source **[exists: spec; adapter planned, M9]**
`DatasetSource.fetch(spec, period)` returns `rows`, `as_of` and `lineage` (`definition_version`, `steward`,
`external_snapshot_id`, `query`). Suppressed cells arrive as `null` with a flag and show as "suppressed (n<5)".

## 4. Flows

### 4.1 AMS to BI (definition)
- **Read evidence items** (3.1), their **collection runs** (3.6) and **dataset specifications** (3.3) the service identity may see, filtered by scope.
- **Read evidence item metadata** (3.1) and, if permitted, the file of a version, so the BI can index and process it
  (DEC-019). Restricted items and items with student data are excluded unless the identity is granted them.
- **Change notices** (webhook, below) so the BI does not poll.

### 4.2 BI to AMS (supply)
- **Supply a dataset version:** rows for a dataset item, validated against `columns`, with `as_of` and `lineage`; creates
  an evidence version (or answers a run). A supply to a submitted snapshot's period does not change the snapshot.
- **Supply a document:** a file or URL as a new version of an existing item, or a new item answering a run.
- **Propose a link:** the BI may propose an evidence link with a rationale; it is `proposed` until a person approves it. A link made by a person who may review it is approved at once (TASK-088); a service identity is not a reviewer, so its links stay proposed.
- **Mark a run supplied:** a status change on the run (with the one-time token of 3.6), never on a link's review.

### 4.3 Refresh
`governed_metric` datasets refresh `manual`, `on_open` or `scheduled`; each refresh is a new version. The AMS calls the
BI's governed API (pull) or the BI pushes a supply (4.2); both write the same kind of version.

## 5. Interfaces (proposed; versioned under `/api/bi/v0`)

All are new routes with `requires(...)` (the five-step chain); none exists yet.

| Direction | Method and path | Purpose |
|---|---|---|
| AMS → BI | `GET /api/bi/v0/runs?updatedSince=` | Collection runs (3.6) with the item's definition, type, method settings, scope, champion, due |
| AMS → BI | `GET /api/bi/v0/datasets/{evidenceItemId}/specification` | Dataset specification (columns, grain) |
| AMS → BI | `GET /api/bi/v0/evidence?updatedSince=` | Item metadata (3.1), latest version summary |
| AMS → BI | `GET /api/bi/v0/evidence-versions/{id}/file` | File of a version (DEC-019) |
| BI → AMS | `POST /api/bi/v0/datasets/{evidenceItemId}/versions` | Supply rows with `asOf` and `lineage` |
| BI → AMS | `POST /api/bi/v0/evidence/{id}/versions` | Supply a file or URL |
| BI → AMS | `POST /api/bi/v0/runs/{id}/supplied` | Mark a run supplied by a version (one-time token) |
| BI → AMS | `POST /api/bi/v0/links` | Propose a link (with rationale) |
| AMS → BI | webhook `POST {bi}/hooks/ams` | `run.created|updated`, `evidence.version.created`, `link.reviewed`, `dataset.specification.updated` |

Idempotency: every POST takes an `Idempotency-Key`; a repeat returns the first result. Pagination: cursor, `updatedSince`
ordering. Errors: the AMS's existing problem format (code, message, issues).

## 6. Identity and security **[open: to build]**

- The BI is a **service identity** in the AMS (a non-human user with a role limited to `evidence:read`, `evidence:write` on
  items it supplies, and nothing on frameworks, engagements, reports, org or settings), credentials rotated, never a
  person's session. Writes are audited as the service identity, with `origin = bi`.
- Row-level security still applies: the identity sees only what its scope grants. `restricted` and student-data items are
  denied by default.
- Webhooks are signed (HMAC, timestamp, replay window).
- Files to the BI over HTTPS only; the BI's use of them (indexing, AI) is governed by DEC-019 and the BI's own policy.
- Rates and size limits per route; a refused request returns the reason.

## 7. What the BI team can build now

1. The **semantic layer and metric definitions** that match dataset definitions (3.3, 3.7) and the PRD §9.4 dataset list:
   enrollment by level, retention, graduation, completions, faculty by rank, student–faculty ratios, financial indicators,
   outcome attainment.
2. The **document pipeline** over evidence files (indexing, search, its own AI), reading 3.1 and 3.2.
3. A **producer** for runs: given a run (3.6) and its item's definition and query (3.1), find or compute the evidence, then supply it (4.2) as a new version.
4. A mock of 4.1 and 4.2 against fixtures until the AMS routes exist (the shapes above are what to mock).

## 8. Freeze

v0 is promoted to **v1** when these are done in the AMS:

| Needed | Why it changes the contract |
|---|---|
| TASK-059, TASK-056 | Real documents and production may reshape what a definition holds |
| TASK-089 (evidence schema) | Done 2026-10-20: the definition, type, method and schedule of an item (3.1) |
| TASK-090 (collection runs) | The runs, the BI request and callback bodies (3.6) |
| TASK-086 (IQF in operation) | Scope and champion on requirements, inherited through mappings |
| TASK-081 (academic calendar) | Done: the terms a `semester` schedule reads |

After v1: only additive changes under `/api/bi/v1` (new fields, new routes, new webhook events). A breaking change is a v2
beside v1 with an overlap. M4 (reports) and M5/M6 do not change this boundary and are not required for the freeze.

## 9. Open questions

1. Pull or push for governed metrics: does the AMS call the BI's metric API (PRD §9.5, Cube-style), or does the BI push
   supplies? Proposed: both are allowed; the version written is identical.
2. Who creates an **evidence item** when a requirement has none yet: the AMS only (proposed), or may the BI suggest new items (proposed as
   `proposed`, accepted by the champion)?
3. Student-level or small-cell data: confirm the AMS never receives it (proposed: aggregated and suppressed only).
4. Which files the BI may fetch by default (all `internal`, none `restricted`?) and who can widen it.
5. Webhook delivery guarantees the BI needs (at-least-once with retries is proposed).
6. Does the BI need a read of **org units, programs and courses** (for scope) from the AMS, or does it own that dimension
   and the AMS maps to it? Proposed: the AMS exposes its org chart read-only (`GET /api/bi/v0/org`), and a unit may carry
   an external id the BI uses.
7. Does a failed BI call retry by itself, and how often (TASK-090)? And how are the dataset's `sourceKind` / `sourceConfig` (3.3) and the item's
   `method: bi` reconciled (proposed in 3.3)?
