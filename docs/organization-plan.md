# Organization, languages, org chart and document import — plan (2026-10-13; nothing built yet)

Owner's decisions are recorded as DEC-028. This page is the plan.

**Status (2026-10-14):** section A is built (TASK-075: registry, Docs tab, Documents area, import engine; how to add a place or an import is in [ai-import.md](ai-import.md)); section B is built (TASK-069). Programs from documents (TASK-076) and the rest follow.

**Status (2026-10-13): step 1 is built (TASK-069).** Organization has its two tabs and the institution logo (header and sign-in page), Programs moved under it, and Settings is readable by every role that can read the organization. Languages, the org chart builder and the Docs tab follow in the order below.

**Update (2026-10-14): E.1, the org chart visual builder, is built (TASK-072).** Institution -> Org chart has a Tree view (shared tree layer: drag and drop, keyboard drag, multi-select, bulk delete to the Trash with Undo/Redo) and a Chart view (auto layout, zoom, pan, collapse, right-to-left mirror, export as PNG or SVG, print to one page), a unit drawer (names in both languages, type, head, description, lock, programs) and a "Unit types" manager. Units record their source (manual, image, directory), a lock and an edited-by-person marker for the later image import and directory sync, which are not built.

## Decisions (owner, 2026-10-13)

1. **Organization has two tabs:** **Institution** (details and logo, **Languages** and **Org chart** as sections) and **Programs**.
2. **One secondary language** at a time; primary is always English.
3. **Translations of external standards** are shown beside the original, labelled "Translation, not the official wording".
4. **UI language is chosen per person** (default from the institution's setting).
5. **Org-chart images, and the names on them, may go to the AI vision model.**
6. **Directory:** sync is a connector with LDAP first; the institution's own identity provider is QuickLaunch, and an integration with the university's Active Directory will be requested from IT. We do not yet know which protocols QuickLaunch offers (see "Directory").
7. **Wherever the AI reads a document and fills drafts, that place gets a Docs tab** showing its uploads (who, when), and there is a general Documents area (see below).

## What exists today

- Organization page: institution name (English and Arabic), country, default language, accent colour, org units as a list; a separate Programs page. "Logo upload arrives later" (storage exists since M3).
- Standards: Settings → Sources on each version holds the uploaded files with their page text and the Analysis panel; uploads record who and when.
- The UI uses i18next. Content has an original `language` per requirement and one `translation_en` field.
- Better Auth handles sign-in (password, OIDC, SAML). Nothing reads a directory.

## A. Documents and AI import: one pattern, a Docs tab wherever it applies

The pattern already exists for standards (upload files, the AI reads them, drafts appear, a report, a person publishes). It will also apply to Programs, the org chart, the IQF and later the glossary. Make it one pattern.

- **Registry.** A shared `import_document` table (institution, scope kind and id, file in storage, name, type, size, hash, language, who uploaded and when, read status, page count, soft-deleted through the Trash). Standards keep their `source_document` (pages, quotes, citations); the shared Docs list reads both through one adapter, so nothing is migrated yet. Evidence stays in the Evidence library and is never sent to the AI (DEC-013, DEC-019); it is not listed in Docs.
- **Docs tab component.** One component, used in each place: the list of documents for that scope with type, size, pages, status (read, needs OCR, failed), who uploaded and when; upload (drag and drop, many files); open, re-read, delete (to the Trash); **Import** (run the AI import for this scope); and the history of imports with a link to each import's report. It shows only what the person may read; upload and import need write permission for that scope.
- **Where it appears.** External standards: the version's **Docs** tab (today's Sources section, renamed and moved up to a tab beside Requirements, Mappings and Report). IQF page: Docs. Programs: Docs. Institution → Org chart: Docs. Glossary later.
- **General Documents area.** One screen (Settings → Documents) listing every upload the person may see across the institution, filter by place, uploader, date, type and status, each row linking to where it is used.
- **Import engine.** A target registry: each place registers an extractor (a Zod schema of what it can fill, a versioned prompt, a validator, and a writer that creates proposals). A background `import` job in the `agent` service runs read (the parser), extract (aiExtract), verify (quote found on the page where it applies) and propose, with the same budget, cancel and resume rules and a report like the analysis report. The standards analysis stays as the richest extractor for its scope.
- **Drafts, not writes.** Whatever the AI extracts lands as proposals the person reviews: an editable table beside the source page, accept or skip per row (or all), applied as one undoable change; the AI never writes the real records, and never overwrites what a person edited (AI proposes, humans publish, DEC-006).

## B. Organization screen (first)

Tabs **Institution** and **Programs**. Institution holds the details and logo (reusing the accreditor-logo upload rules: PNG/JPEG/WebP, 512 KB, bytes checked, no SVG; shown in the header and sign-in page), then the Languages section, the Org chart section and its Docs. The Programs entry leaves the Settings sidebar (the old address redirects). Settings readable by every role (editing stays with those who can edit today).

## C. Programs from documents

On the Programs tab: a list, and a **Docs** tab. Upload a document (a catalogue, a program list, a spreadsheet, a program description); **Import** extracts programs (name in English and Arabic, degree level, owning unit, code, duration, mode and whatever the document states) and shows them as drafts beside the source page; you edit, accept or skip, and apply. Re-importing a newer document proposes only what changed. Unit matching uses the org chart; an unknown unit becomes a proposed unit.

## D. Languages

- **Registry** of languages (direction, font stack, native name); the institution has **one secondary language**, chosen by an administrator.
- **Content translation** stored beside the English in a `content_translation` table (entity, language, field, text, origin AI or person, reviewed, hash of the English it came from, so a later English edit flags it out of date). Covered first: the IQF; then external standards, glossary, report templates, lifecycle labels. A translate job in the `agent` service (framework text only, DEC-021; glossary-aware; spend cap; progress) marks each result "AI translation, not reviewed"; a side-by-side review screen (accept, edit, retranslate; filters needs review and out of date). The existing `translation_en` becomes the English row of this table. The assistant can offer to translate a selection.
- **External standards:** the accreditor's words stay the official text; the translation carries "Translation, not the official wording" and a toggle to the original.
- **Switchers:** the UI language is per person (header menu, default from the institution setting); a content toggle on the library screens (original, English, secondary) falls back to English and says so.
- **UI strings:** the English catalogue is in the repository; the secondary language's catalogue is produced by the same translation job into a `ui_translation` table, reviewable in the Languages section. Arabic and other right-to-left languages flip the layout (logical spacing is already used); CJK languages need a font stack. Reports and exports in the secondary language come with M4.

## E. Org chart

1. **Visual builder (first).** The tree editor reuses drag and drop, selection, Trash and Undo/Redo; a chart view draws the same units (auto layout, zoom, pan, collapse, right-to-left aware, export as image). Each unit has a name in both languages, a type, a head and its programs; levels and types are configurable.
2. **From an image or PDF.** It is a Docs-pattern import: the vision model reads the boxes and lines and proposes a tree beside the image; you edit and apply it as one undoable change. The image and the names on it go to the AI vision model (decided, DEC-028).
3. **Directory sync.** A connector interface with LDAP/LDAPS as the first implementation (Active Directory and OpenLDAP speak it); SCIM or others behind the same interface; no vendor SDKs (DEC-008). Settings: server, bind account (encrypted at rest), base DN, filters, attribute mapping to units, heads and members. A scheduled job in the general `worker` service reads the directory and shows a "what would change" list; the person applies it (or turns on automatic apply). Each unit records its source (manual, image, directory); sync never overwrites a unit a person edited or locked and never deletes (removed units go to the Trash). Where there is nothing to connect to, a CSV or spreadsheet import through the same Docs pattern fills the gap.
4. **Directory: what we need to ask.** The institution signs in through QuickLaunch. We do not yet know which protocols it exposes: ask IT whether it offers SAML or OIDC for sign-in (the app supports both today), and whether it exposes SCIM, LDAP or an export of users, units and managers. The request for Active Directory access goes to IT in parallel. The connector is built once we know what we can reach.

## Public exposure (the sign-in page)

The sign-in page shows the institution's name, accent colour and logo before anyone is authenticated. This is the **only** data served without signing in besides the health check, the authentication endpoints and one-time links:

- `GET /api/public/branding` returns exactly `{ name, accentColor, logoUrl }`: the display name (the Arabic name when Arabic is the default language and it is set, else the English one), the accent colour (only if white text is readable on it) and the address of the logo with a version query. All three are `null` when there is nothing to show.
- `GET /api/public/branding/logo` returns the logo image itself (404 when there is none).
- A deployment serves one institution. The API reads it through one SECURITY DEFINER function, `app_public_branding()` (migration 0052), that selects only those fields and returns nothing unless there is exactly one institution; it never guesses among several. The application role still cannot read the `institution` table without an identity.
- Nothing else about the institution is public: no id, country, languages, org chart, programs or people; no listing.
- Tests: `apps/api/src/institution-logo.test.ts` (exact keys, no id or country, 404 elsewhere, more than one institution shows nothing), `packages/db/src/public-branding.test.ts`.

## Build order

1. **TASK-069** Organization (two tabs), Programs under it, institution logo, read-only Settings.
2. **TASK-075** Documents and AI import foundation: registry, Docs tab component, Documents area, standards Sources become the Docs tab.
3. **TASK-076** Programs from documents.
4. **TASK-070, TASK-071** Languages, then translation of the IQF and standards.
5. **TASK-072** Org chart builder; **TASK-073** from an image; **TASK-074** directory sync.
