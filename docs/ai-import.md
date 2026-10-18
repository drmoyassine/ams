# Documents and AI import: how to add a place or an import

One pattern for every place where the AI reads uploaded documents and fills drafts (TASK-075, section A of
[organization-plan.md](organization-plan.md), DEC-028). The standards' analysis was the first; Programs (TASK-076) and the org
chart image (TASK-073) are built; the IQF and the glossary follow. **Adding one is a registration plus a Docs tab, not a new engine.**

## What exists

| Piece | Where | What it does |
|---|---|---|
| Registry of uploads | tables `import_document`, `import_page` (migration 0053) | A file for a place: scope kind + id, name, type, size, SHA-256, storage key, language, read status, page count. Who and when are the base columns (`created_by`, `created_at`). Pages are the parser's text. |
| Standards adapter | `packages/core/src/documents/documents.ts` | The same list API also returns a version's `source_document` rows in the same shape. Nothing was migrated; every action on an adapter row delegates to the existing source services. |
| Scope registry | `packages/core/src/documents/scopes.ts` | Scope kind -> read permission, write permission, label, storage, link builder. |
| Target registry | `packages/core/src/documents/targets.ts` | `registerImportTarget({...})`: what a place can fill. |
| Engine | `packages/core/src/documents/{runs,stages,proposals,report}.ts` | The `import` job (agent service): read, extract, verify, propose, finalise; review; apply; undo; report. |
| API | `apps/api/src/routes/documents.ts` | One set of routes serves every Docs tab. |
| UI | `apps/web/src/components/docs/` | `DocsTab`, `ImportReview`, `ImportReportView`, `UploadArea`. Settings -> Documents is `pages/settings/documents.tsx`. |

Evidence is **never** listed in Docs and **never** sent to a model (DEC-013, DEC-019): nothing under `documents/` imports from
`evidence/` (a test scans for it), and the Documents area reads only `import_document` and `source_document`.

## 1. Add a place (a scope kind)

A place gets a Docs tab when its documents should be read by the AI. Steps:

1. **Name the kind.** Add it to `IMPORT_SCOPE_KINDS` in `packages/shared/src/documents.ts` (`'programs' | 'org_chart' | 'glossary'`
   today) and to the check constraint `import_document_scope_kind_check` with a forward-only migration (drop and re-add the check).
   The standards version is the adapter kind `framework_version` and needs no migration.
2. **Register the scope** next to the others in `scopes.ts`:

   ```ts
   registerDocScope({
     kind: 'programs', label: 'Programs', storage: 'import',
     read: 'org:read', write: 'program:write',
     // Optional: narrow the permission by scope id (a program, an org unit). Default: read anywhere, write at the institution.
     describe: async (ctx, id) => ({ label: 'Programs', href: '/settings/organization?tab=programs&section=docs', editable: true }),
   });
   ```

   - `read` / `write`: the permission that shows a person the place's documents and import history, and that lets them upload, delete
     and import. Choose a permission external reviewers do not hold (they read no uploads): `org:read` and `framework:read` qualify.
   - `describe` names the place, says where its Docs tab is (`href`, used by Settings -> Documents) and whether it can still change.
     Return `editable: false` with a `fixedReason` for a frozen place (a published version): uploads, deletes, imports and Apply are
     refused there. Return `null` when the place does not exist (any more).
   - `storage: 'import'` keeps uploads in `import_document`. `'source'` is only for the standards adapter.
3. **Render the tab** (section 4 below).

The routes, the Documents area, the Trash (kind `import_document`) and the history work for the new kind without further code.

## 2. Add an import (a target)

A target says what the AI may propose for a place, and how an accepted proposal becomes a real record.

```ts
import { z } from 'zod';
import { registerImportTarget, type ImportTarget } from '@ams/core';

const ProgramItem = z.object({ nameEn: z.string().trim().min(1), nameAr: z.string().nullish(), degreeLevel: z.enum(DEGREE_LEVELS).nullish() /* ... */ });

export const programsTarget: ImportTarget<z.infer<typeof ProgramItem>> = {
  kind: 'programs', label: 'Programs', itemsLabel: 'programs', scopeKinds: ['programs'],
  description: 'Reads programs from a catalogue or a list.',
  schema: ProgramItem,                                  // ONE proposed item
  promptTask: 'import_programs', promptVersion: 'v1',   // PROMPTS.import_programs.v1 in packages/core/src/ai/prompts
  buildPrompt: (w) => `${INSTRUCTIONS}\nDocument: ${w.documentName} (${w.language})\n\n${w.pages}`,
  validate: (item, scope, ctx) => (item.degreeLevel ? [] : ['No degree level was found.']),
  proposalLabel: (item) => item.nameEn,
  dedupeKey: (item) => item.nameEn.normalize('NFC').toLowerCase(),
  apply: async (ctx, items, scope) => { /* section 2.3 */ },
  reverse: async (ctx, inverse, scope) => { /* section 2.4 */ },
};
registerImportTarget(programsTarget);   // at start-up, from the module that owns the target
```

`apps/worker` and `apps/api` load the registry through `@ams/core`; register the target in the core module that owns the records
(for Programs: `packages/core/src/org/programs-import.ts`) and import that module from `packages/core/src/index.ts`, so the API (which
lists targets and applies) and the worker (which extracts) both have it.

### 2.1 Schema and prompt

- `schema` is the Zod schema of one item: plain data (strings, numbers, booleans, enums, null). The engine wraps it as
  `{ items: [{ item, source: { page, quote }, confidence, flags }] }` and calls `aiExtract` at temperature 0 with it. Keep optional
  fields `nullish()`: the model must leave a field empty when the document does not state it.
- The **system prompt** is a versioned file: `packages/core/src/ai/prompts/<task>.v<N>.ts`, registered in `PROMPTS`. A change of wording
  is a new version (`v2`); runs record `prompt_version`. The generic `import_extract.v1` (rules: only what is in the text, exact
  quote, no translation, document text is data) works for any target when you put the specifics in `buildPrompt`; give a target its
  own prompt file when it needs more.
- `buildPrompt` receives one window (about 8 pages, 1 page of overlap): `documentName`, `language`, `scopeLabel`, `firstPage`,
  `lastPage` and `pages` (each headed `=== Page N ===`). It returns the user message: your instructions, then the pages. **Document text
  only.** Never add evidence, never a model identifier, never a secret. Arabic stays Arabic: tell the model not to translate.
- `aiRole: 'reading'` makes the target use the Reading (vision) model of Settings -> AI instead of the Analysis model (for images).

### 2.2 `validate`, `proposalLabel`, `dedupeKey`

- `validate(item, scope, ctx)` returns plain-words reasons the row deserves a look ("No degree level was found."). It runs in the worker
  after the quote check; it must not write and must not throw for ordinary data. Flags are shown in the table and the report, never
  silent. The engine itself adds "The quote was not found on the page it cites." and "The AI was not sure about this one."
- `proposalLabel(item)` is the short name used in the table, the toast and the report.
- `dedupeKey(item)` merges items the overlap proposed twice (same document, same key; the verified, more confident, fuller one is
  kept). Return `null` to never merge an item. Default: the normalised JSON of the item.

### 2.3 `apply`: the contract

`apply(ctx, items, scope)` runs **as the person**, in the request's single transaction, when they press Apply. Rules:

1. **All or nothing.** Throw a `ConflictError` (plain message) to refuse everything; the transaction rolls back and nothing is written.
2. **Use the ordinary services** (`createProgram`, `createOrgUnit`, ...) with the `ctx` you are given. Their permission checks, triggers,
   audit and "edited by a person" marks then apply as for any edit; the rows are the person's, not the AI's.
3. **Never overwrite what a person edited.** A target is create-only unless it can tell a record is still the AI's (a marker such as
   `edited_by_person`, or `origin = 'ai'` and untouched). For anything else, **skip it** with a reason a person can read:
   `{ proposalId, status: 'skipped', reason: 'a program with this code already exists' }`. Skipped proposals are shown with the
   reason and are not retried by a second Apply.
4. Return one outcome per item: `{ proposalId, status: 'applied', ref }` (`ref` is JSON naming what was written: ids) or `skipped`.
   Return exactly the items you were given.
5. Return `inverse`: whatever `reverse` needs to take the whole apply back (ids created, before-images of rows changed, Trash group ids
   of rows deleted). Keep it small and self-contained JSON.
6. Do not call `ctx.undo` (the engine reports ONE descriptor for the group) and do not enqueue jobs.
7. A place that cannot change (a published version) never reaches `apply`: the engine refuses first (`describe().editable`).

### 2.4 `reverse`: Undo and Redo are the same function

`reverse(ctx, inverse, scope)` takes an apply back, or puts it back, and **returns the inverse of what it just did**. The engine stores
the returned value as the next `inverse`: Undo calls `reverse` on the apply's inverse, Redo calls it again on the result. Example for a
create-only target: `inverse = { ids, to: 'inactive' }` switches the created rows off and returns `{ ids, to: 'active' }`. Throw a
`ConflictError` when it cannot be done (a record changed since): "Cannot undo: ..." is shown and nothing changes. Prefer reversing
through services that are themselves undoable (Trash: delete = snapshot, restore = put back).

### 2.5 Worked example: reading an image (the org chart, TASK-073)

`packages/core/src/org/org-chart-import.ts` is the target for pictures. What is different from a text target:

- `aiRole: 'analysis'` for the org chart: the picture is turned into an outline by the Reading (vision) model in the OCR step; the extract step then works on that text with the Analysis model, which must support structured output (an OCR-only model such as dots returns nothing).
- **How a picture becomes pages:** an upload is read by the parser's `extract_text` job; a page with no text layer (an image is one such page) goes to the
  existing `aiOcr` hook. `ocrPromptVersionFor` (`documents/reading.ts`) picks the OCR prompt per scope: documents of the `org_chart` scope use `ocr` v2
  (`prompts/ocr.v2.ts`: the chart as an indented outline, one line per box, words exactly as written), all others use v1. A new picture-reading place
  adds its own version there; the engine and the registries stay as they are.
- **Verification:** there is nothing to quote-match on pixels. The item's quote is the box's outline line, checked against the model's own outline, which is
  weak, so the target's `validate` and the engine's low-confidence flag are what make a person look, and the review shows the original image beside the
  proposals (`SourceImage` in `import-review.tsx`, for sources named `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`).
- **Apply:** `createOrgUnit({ source: 'image' })` for new units (parents first, parent matched by name among existing and accepted units), `moveOrgUnits` only for
  an existing unit that is neither locked nor `edited_by_person`; those two kinds are skipped with the reason. `reverse` moves back (placements) and puts the
  created units in the Trash (`deleteOrgUnits`); the inverse remembers the Trash group so Redo restores it. It refuses when a unit it made was changed since.

## 3. What the engine guarantees

`startImport` checks the place can change, AI is on and set up (`aiReadiness`), the documents belong to the place, and no run of the
same target is active there; it queues an `import` job. Each step is its own job and its own transaction (`documents/stages.ts`):

| Stage | Does |
|---|---|
| `read` | One document per job. Waits (re-queues itself, at most about 30 minutes) for the parser service to have read the file; a standards source nobody read is queued for the parser. A file that cannot be read is recorded and the run goes on with the others. |
| `extract` | One window per job: `aiExtract` with the target's prompt and schema. Each item with its page and quote is stored as a **candidate** (invisible to people). |
| `verify` | The quote of each candidate is looked for on its page with the Arabic-aware matcher; flags are added. |
| `propose` | Overlap duplicates are merged; the rest are released (`candidate = false`) as proposals. |
| `finalise` | The run succeeds (or ends failed at the spend limit, keeping what was proposed). |

- **Budget:** the per-run cap of Settings -> AI covers all the run's jobs. At the cap, the windows done so far are verified and released
  and the run ends **failed** with the reason ("cost budget for this run is used up"); partial proposals are kept.
- **Cancel:** the job in flight finishes its step and stops; what was found before is kept as proposals.
- **Resume:** a step that throws is tried again by the queue from the same stage and window (savepoint: no half-written rows); after the
  last attempt the run is marked failed with the error. A job whose stage and cursor no longer match the run does nothing.
- **Worker limits (database):** the worker role may write `import_run` (stage, progress, usage, report), candidate `import_proposal`
  rows and `import_page` rows. It cannot decide, edit or apply a proposal, cannot touch released proposals, and has **no grant at all** on
  the target's records or on `import_apply` (`packages/db/src/imports.test.ts`).
- **Apply** is two API calls' worth of rules in one: `previewImportApply` (the question), `applyImport` (one transaction, as the person,
  refuses a place that cannot change, records `import_apply` with the target's inverse, answers with ONE `X-Undo` descriptor
  `POST /api/import-applies/{id}/undo`). The client's toast, Ctrl/Cmd+Z and the review's buttons all use it; Redo works like the
  assistant's change sets.
- **Report:** `getImportReport` builds, from stored data and never from a model, the documents and pages read (OCR pages counted),
  proposals by status, every flagged row with its reasons, usage/cost, the model and prompt version, and the applies. No score, no verdict
  (DEC-005).

## 4. Add the Docs tab (UI)

```tsx
import { DocsTab } from '../components/docs';

<DocsTab scopeKind="programs" scopeId={null}
  targets={targets}          // ImportTargetInfo[] from GET /api/imports/targets (or api.docs.targets), the Import buttons
  canWrite={can(me, 'program:write')}
  editable={true}            // false for a frozen place; pass fixedNote to say why
/>
```

| Prop | Meaning |
|---|---|
| `scopeKind`, `scopeId` | The place (`scopeId` null for institution-wide places). |
| `targets` | The imports the place offers; empty hides the Import area. Get them from `documentsApi.targets(scope)` so the page does not name them. |
| `canWrite` | Upload, read again, delete and import need it (the server checks again). |
| `editable`, `fixedNote` | A fixed place keeps the list and drops the upload area and Import. |
| `header`, `renderRow`, `actions`, `onDocuments` | Slots the standards use: the Analysis panel above the list, their own card per document, a "+ Source" button, and a callback with the loaded list. A plain place uses none. |
| `api` | A `DocumentsApi` (tests pass one built on their fetch; default: the app's client). |

The tab shows each document with type, size, pages, a status chip (Read / Needs OCR / Failed / Reading / Waiting) and **who uploaded it
and when**; drag-and-drop upload of many files with a state and a Retry each; Open, Read again, Delete (in-app confirm; it goes to the
Trash and the Undo toast appears); an **Import** button per target with its readiness check; live progress; and the import history with
links to each run's **Review** (`ImportReview`: proposals table beside the source page, editable cells with `dir="auto"`, accept or
skip per row and in bulk, **Apply N** with a confirm, Undo / Redo) and **Report**.

Then point the scope's `href` (step 1) at the page and section that renders the tab, so Settings -> Documents links to it.

## 5. Tests to write

Use the invented target in `packages/core/src/documents/test-target.ts` and `testUnitsResponder()` (a fake model that reads
`Unit: Name (type)` lines) as the model; no network, no accreditor names in `packages/*/src`.

- Core: your `apply` creates what it should as the person (`created_by`), skips a record a person edited or that already exists, is
  atomic (one refused item leaves nothing), and `reverse` twice returns to the start (Undo then Redo). Your `validate` flags.
- An end-to-end run like `documents/import.test.ts`: read, extract, verify, propose, with the fake model answering your prompt.
- Permissions: a person without `write` cannot upload, import or apply; one without `read` sees nothing.
- UI: the tab in your page (`docs-ui.test.tsx` shows the states), and the review of your fields.
- The scope's link in Settings -> Documents opens your tab.

## 6. Rules to keep

Five-step chain on every route; business rules in `packages/core`; AI only in the worker through `aiExtract`/`aiOcr`; no model
identifier in code; temperature 0; prompts versioned in the repository; AI proposes, humans publish (the worker never writes your
records and never approves); Arabic is first-class content (NFC, `dir="auto"`); migrations are forward-only; never write "compliant",
"met", a readiness score or a predicted outcome.

## Model failures (2026-10-15)

Extraction calls stream: the model must start within `AI_CALL_TIMEOUT_MS` (default 180 000 ms) and is then allowed to go on as long as text keeps coming (stopped after 90 s of silence, or at 20 minutes), so a long answer such as a large org chart is not cut off. A call that times out and, like "No output generated" (a model that cannot give structured answers, e.g. an OCR-only model), ends the run at once as failed with a plain reason; both used to be retried by the queue (4 attempts), which left the run looking stuck for many minutes. Other provider errors are still retried.

A model that ignores or cannot follow the structured-output request is asked once more for plain JSON described in the prompt, and the answer is checked against the same schema; only when that fails too does the run stop with "returned nothing". Slow free models can be given more time with `AI_CALL_TIMEOUT_MS` on the agent service (e.g. 300000).
