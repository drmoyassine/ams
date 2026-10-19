# AMS ↔ BI contract, v0 (draft)

Status: **draft v0, 2026-10-19.** Written so the BI work can start in parallel with the AMS. Not implemented as an API yet:
everything marked **[exists]** is in the AMS today (the data and the services behind it); **[planned]** is decided but not
built; **[open]** needs an answer. v0 becomes **v1 at the freeze** (see "Freeze"): after that it changes only by addition.
Source decisions: DEC-017 (separate products, separate storage), DEC-019 (evidence may be shared with the BI, whose AI may
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
`id`, `title`, `description`, `type` (`document` | `data`), `subtype`, `ownerUnitId`, `ownerUserId`, `periodLabel`,
`confidentiality` (`public` | `internal` | `restricted`), `containsStudentData`, `tags[]`, `status` (`active` | `archived`).

### 3.2 Evidence version **[exists]**
`id`, `evidenceItemId`, `versionNo` (append-only), the content (`file` with `sha256`, `fileName`, `mime`, `size`; or a
registered `url`; or `data` rows for datasets), `asOfDate`, `notes`, `lineage` (jsonb: who supplied it, from what).

### 3.3 Dataset definition (`dataset_spec`) **[exists]**
One per dataset item: `definition` (plain language), `grain` (e.g. "programme × academic year"), `columns[]` (`key`,
`label`, `type`, `unit`), `sourceKind` (`manual_upload` | `governed_metric`), `sourceConfig` (for `governed_metric`: a
structured query, never SQL), data owner. **[planned for periods]**: `periods` and `refresh` (`manual` | `on_open` |
`scheduled`) as in PRD §9.4.

### 3.4 Evidence link **[exists]**
Evidence version to a target, with a required `rationale` and a review (`proposed` | `approved` | `rejected`). Targets: an
engagement requirement, an item of the IQF, or (since 2026-10-19) a requirement of any framework, keyed by framework and
code so it survives new versions of the standard. Approving is an AMS act; the BI cannot approve.

### 3.5 Evidence request **[exists]**
A request for evidence on an IQF item, sent to a person or an email address (one-time link, DEC-018), answered with a file or
a form. The answer becomes evidence with a proposed link.

### 3.6 Evidence need **[planned]** (the "evidence definition" side, new)
What exists since TASK-086: `scope_level`, `requirement_scope` and `requirement_champion` (framework + code; scope = level plus optional units or programs, champion overall or per item), with effective values resolved down the tree and through approved mappings (the version's requirement-context carries own, effective and inherited, with the source). Evidence needs themselves and cycle linkage are still planned.
What the AMS expects to be produced, before anything exists. Built from TASK-086 and the cycles (TASK-078 to TASK-081):
- `id`, `requirementRef` (framework + code, so it covers IQF items and external requirements), `evidenceItemId` or a
  description when the item does not exist yet, `kind` (`document` | `dataset`), `datasetSpec` (for datasets),
- `scope` (level: institution | unit | program | course; optional list of units, programs, courses) and `champion` (person
  accountable), both inherited down the IQF and through mappings, with overrides (DEC-029),
- `cycle` (the cycle and stage that collects it) and `due` (a date, or a recurrence: every term, year),
- `status` (`open` | `supplied` | `late` | `waived`).
The BI reads needs to know what to produce and for whom, and supplies against them.

### 3.7 Governed metric source **[exists: spec; adapter planned, M9]**
`DatasetSource.fetch(spec, period)` returns `rows`, `as_of` and `lineage` (`definition_version`, `steward`,
`external_snapshot_id`, `query`). Suppressed cells arrive as `null` with a flag and show as "suppressed (n<5)".

## 4. Flows

### 4.1 AMS to BI (definition)
- **Read evidence needs** (3.6) and **dataset definitions** (3.3) the service identity may see, filtered by scope.
- **Read evidence item metadata** (3.1) and, if permitted, the file of a version, so the BI can index and process it
  (DEC-019). Restricted items and items with student data are excluded unless the identity is granted them.
- **Change notices** (webhook, below) so the BI does not poll.

### 4.2 BI to AMS (supply)
- **Supply a dataset version:** rows for a dataset item, validated against `columns`, with `as_of` and `lineage`; creates
  an evidence version (or answers a need). A supply to a submitted snapshot's period does not change the snapshot.
- **Supply a document:** a file or URL as a new version of an existing item, or a new item answering a need.
- **Propose a link:** the BI may propose an evidence link with a rationale; it is `proposed` until a person approves it.
- **Mark a need supplied:** a status change on the need, never on a link's review.

### 4.3 Refresh
`governed_metric` datasets refresh `manual`, `on_open` or `scheduled`; each refresh is a new version. The AMS calls the
BI's governed API (pull) or the BI pushes a supply (4.2); both write the same kind of version.

## 5. Interfaces (proposed; versioned under `/api/bi/v0`)

All are new routes with `requires(...)` (the five-step chain); none exists yet.

| Direction | Method and path | Purpose |
|---|---|---|
| AMS → BI | `GET /api/bi/v0/needs?updatedSince=` | Evidence needs with scope, champion, due, spec |
| AMS → BI | `GET /api/bi/v0/datasets/{evidenceItemId}/definition` | Dataset definition |
| AMS → BI | `GET /api/bi/v0/evidence?updatedSince=` | Item metadata (3.1), latest version summary |
| AMS → BI | `GET /api/bi/v0/evidence-versions/{id}/file` | File of a version (DEC-019) |
| BI → AMS | `POST /api/bi/v0/datasets/{evidenceItemId}/versions` | Supply rows with `asOf` and `lineage` |
| BI → AMS | `POST /api/bi/v0/evidence/{id}/versions` | Supply a file or URL |
| BI → AMS | `POST /api/bi/v0/needs/{id}/supplied` | Mark a need supplied by a version |
| BI → AMS | `POST /api/bi/v0/links` | Propose a link (with rationale) |
| AMS → BI | webhook `POST {bi}/hooks/ams` | `need.created|updated`, `evidence.version.created`, `link.reviewed`, `dataset.definition.updated` |

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
3. A **producer** for needs: given a need (3.6), find or compute the evidence, then supply it (4.2) as a new version.
4. A mock of 4.1 and 4.2 against fixtures until the AMS routes exist (the shapes above are what to mock).

## 8. Freeze

v0 is promoted to **v1** when these are done in the AMS:

| Needed | Why it changes the contract |
|---|---|
| TASK-059, TASK-056 | Real documents and production may reshape what a definition holds |
| TASK-078 (cycles schema) | Where an evidence-collection stage and its due dates live |
| TASK-086 (IQF in operation) | Scope and champion on requirements, inherited through mappings |
| TASK-081 (recurrence and plans) | Due dates, periods and recurrence of needs |

After v1: only additive changes under `/api/bi/v1` (new fields, new routes, new webhook events). A breaking change is a v2
beside v1 with an overlap. M4 (reports) and M5/M6 do not change this boundary and are not required for the freeze.

## 9. Open questions

1. Pull or push for governed metrics: does the AMS call the BI's metric API (PRD §9.5, Cube-style), or does the BI push
   supplies? Proposed: both are allowed; the version written is identical.
2. Who owns the **evidence need** list when a requirement has no AMS-side evidence item yet: created by the AMS only
   (proposed), or may the BI suggest new needs (proposed as `proposed`, accepted by the champion)?
3. Student-level or small-cell data: confirm the AMS never receives it (proposed: aggregated and suppressed only).
4. Which files the BI may fetch by default (all `internal`, none `restricted`?) and who can widen it.
5. Webhook delivery guarantees the BI needs (at-least-once with retries is proposed).
6. Does the BI need a read of **org units, programs and courses** (for scope) from the AMS, or does it own that dimension
   and the AMS maps to it? Proposed: the AMS exposes its org chart read-only (`GET /api/bi/v0/org`), and a unit may carry
   an external id the BI uses.
