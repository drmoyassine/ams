# Project status and what is left (2026-10-18)

A snapshot of where the AMS stands against the PRD milestones (§18.4) and the features added along the way. Source of truth for each item is its roadmap item and tasks; this page is the reading view. Built and tested means the automated tests pass (1,588 tests, 175 database tests); "not yet used on real documents" means the owner has not run it on real accreditor files yet.

## Built

| Area | What works | Roadmap / tasks |
|---|---|---|
| **M0 Foundation** | Workspace, five-step request chain, RLS, audit, immutability triggers, auth, roles, Compose stack with `app`, `worker`, `parser` and `agent` services, Garage storage prepared by the app | ROADMAP-001, TASK-049, DEC-024 |
| **M1 Framework library** | External standards and the Internal Quality Framework: tree editor, notes with authority, versions, publish and freeze, import/export, report templates, lifecycle and vocabularies, glossary and terminology, accreditor logos, sources with page text | ROADMAP-002, ROADMAP-012 |
| **M2 Engagements** | Wizard, members, roadmap and milestones, due-rule engine, requirement workspace, ICS export | ROADMAP-003 |
| **M3 Evidence and datasets** | Evidence repository with versions and reasoned links, datasets with a sheet grid, forms with public links, requests with one-time links | ROADMAP-004 |
| **M7 Framework compiler (steps A–F and H)** | Create a standard from files; the parser reads PDF, Word, Excel, CSV, images (owned liteparse; PowerPoint and OpenDocument through a temporary fallback); the analysis finds the accreditor's structure, drafts requirements in exact wording with checked quotes, recovers gaps, proposes links to the IQF and new IQF items; also reads policy, report-template and guidance documents for the lifecycle, decision/finding/response vocabularies, rating method and report templates, as proposals (timing words copied, never converted to dates; a reviewer sets the rules; a person's edits are never overwritten); a report tab; a split-view source viewer; "Needs a look" filters; merge, split, move; publishing is the review gate | ROADMAP-009, TASK-043 to TASK-055, TASK-057 |
| **AI settings** | Saved accounts (Anthropic, OpenAI, Google, OpenRouter, OpenAI-compatible), models fetched from the provider, roles for analysis, reading (OCR) and embeddings and assistant, per-run caps | TASK-044, TASK-048, TASK-051 |
| **Working comfort** | 30-day Trash with restore, Undo and Redo, in-app confirmations, multi-select with bulk delete, drag-and-drop re-parenting and reordering, responsive layout on phones | TASK-062, TASK-063, TASK-065 |
| **In-app assistant, phase 1** | A bubble and panel on every screen, kept conversations, read-only answers about standards with links, scoped memory (personal and shared) that you confirm and manage in Settings | TASK-064, TASK-066, DEC-027 |
| **In-app assistant, phase 2: bulk edits** | The assistant proposes a change to a draft (rule recipes such as the PUC title fix, re-code, re-parent, delete by filter, bulk assessable; text rewrites the model writes), says in the chat what it will do with the count and examples, and the person presses Do it / Change it / Cancel. A one-time token tied to that exact change set is the only way to apply it; it runs as the person in one transaction, as ONE undoable group (Undo and Redo, deletes to the Trash); texts the assistant wrote are marked until kept or reverted; `pnpm assistant:eval` checks 40 sample instructions | TASK-067, DEC-027 |

## Built: Organization, institution logo, read-only Settings (TASK-069)

| Area | What works | Roadmap / tasks |
|---|---|---|
| **Organization** | One screen with two deep-linkable tabs, Institution (Details, Logo, Org chart) and Programs; Programs left the Settings menu and its old address redirects. The institution logo (PNG, JPEG or WebP, 512 KB, no SVG, same rules as an accreditor's) shows in the app header and on the sign-in page, which reads one public route that returns only the institution's display name, accent colour and logo | TASK-069, DEC-028 |
| **Settings for every role** | Settings is visible to everyone who can read the organization; Organization, Internal Quality Framework, Terms, External Standards and Assistant memory show their content read-only (with a one-line note) to people who cannot edit; Trash (editors) and AI (administrators) stay hidden | TASK-069 |

## Built: org chart builder (TASK-072)

| Area | What works | Roadmap / tasks |
|---|---|---|
| **Org chart** | Institution -> Org chart has two views of the same units: Tree (drag and drop, keyboard drag, multi-select, bulk delete to the Trash with Undo and Redo) and Chart (automatic top-down layout, zoom, pan, collapse, mirrored for right-to-left, export as PNG or SVG, print to one page). Each unit has names in both languages, a type, a head (a person or a name), a description, a lock, a source (manual, image or directory) and its programs; a unit with programs cannot be deleted. Unit types are configurable per institution (add, rename, reorder, remove when unused). Smooth with 300 units | TASK-072, DEC-028 |
| **Editing on the Chart (2026-10-18)** | Editors work on the chart itself: drag a box onto another to move it (drop target outlined; itself or its own sub-units refused with the reason; a locked unit is not moved from the chart; Space / arrows / Space from the keyboard), double-click or F2 to rename in place, ＋ on a box to add a sub-unit, Delete to send the focused box to the Trash; each with one Undo. Same services as the Tree; exports leave the edit chrome out; box drag at 16.7 ms frames with 300 units | TASK-072 |

## Built: external requirements and the IQF (2026-10-19)

| Area | What works | Roadmap / tasks |
|---|---|---|
| **Map to IQF and Link evidence from the ⋯ menu** | Any requirement or sub-requirement of an external standard (a published version too: both live outside the frozen version) has "Map to IQF…" (search the IQF by code or title, English or Arabic; pick several; per item a relation, default Covers, and "Commentary (optional)") and "Link evidence" (the existing dialog, several pieces, each with its reason). Mappings are proposed and reviewed as before; the Mappings tab can now edit a mapping's commentary in place (back to review). Evidence links may target a requirement of any standard by (framework, code) at the library level (migration 0058 relaxes the insert rule; the columns and CHECK were already generic) and carry across versions; described as "ABET 1.2 (external)" | owner request 2026-10-19 |
| **Hover card and one batched read** | `GET /api/framework-versions/{id}/requirement-context` answers for the whole version, per requirement code: mapped IQF items (relation, review state), evidence inherited through approved mappings ("Inherited from IQF 1.2") and evidence linked directly, short lists with counts; the card reads it with no request of its own ("Loading…" until it arrives) and also opens on keyboard focus. Effective evidence = direct links + inherited through approved mappings; the engagement workspace's suggestions are unchanged | same |
| **One layout** | The external standard and the IQF share `RequirementsLayout` (same grid, list and panel classes; panel beside the tree from 1280px, one column below): the external panel is the source viewer, the IQF's is the selected standard's description and evidence | same |

## Built: org chart from an image (TASK-073)

| Area | What works | Roadmap / tasks |
|---|---|---|
| **Org chart from an image** | Institution -> Org chart has a Docs tab (Chart | Docs). Upload a picture (PNG, JPEG, WebP) or a PDF of the org chart and press Import: the AI reading model writes the chart down as an outline and proposes one unit per box (names in English and Arabic, type, which box it hangs from, head when shown). The review shows the picture itself beside the proposals, editable cells, and flags for low confidence, no parent found and unclear boxes (there is no quote check against pixels). Apply adds the accepted units as you (source "image") in one undoable change; units already in the chart are matched by name (Arabic folded) and never duplicated, and a locked or person-edited unit is left alone with the reason. Undo puts the added units in the Trash and moves back any that were moved; Redo restores them. The image and the names on it go to the AI reading model (DEC-028). Not run against a real model yet | TASK-073, DEC-028 |

## Built: Languages (TASK-070)

| Area | What works | Roadmap / tasks |
|---|---|---|
| **Languages** | A registry of 31 languages (direction, script, native name). An administrator chooses one secondary language and the default interface language in Settings -> Organization -> Languages (English is always primary); each person switches between English and that language from the header, saved on them and applied at every sign-in (the page's language, direction and font follow). The English interface catalogue lives in the repository; the secondary language's is made by a background translate job (batches, spend limit, cancel, resume, placeholder checks, never over a person's edit) and reviewed in a table; Arabic and CJK pages checked at 375, 768 and 1280 px. About 11% of the app's text goes through the catalogue so far (the shell and shared chrome); the rest is listed in docs/i18n-coverage.md | TASK-070, DEC-028 |

## Built: IQF and standards in the secondary language (TASK-071)

| Area | What works | Roadmap / tasks |
|---|---|---|
| **Content translation** | On a version page (the IQF or an external standard) a content switcher shows English or the institution's secondary language; the translation is shown beside the English, English is the fallback. A Translate action runs a background job (batches, spend limit, progress, cancel, resume) that stores unreviewed AI translations of titles, statements and notes in their own table; people edit, mark reviewed and re-translate out-of-date ones in a review dialog; a changed English text marks its translation out of date. Translations of an external standard are labelled "Unofficial translation" and never replace or feed the official text; a published version can still be translated. Arabic shown right to left, checked at 375, 768 and 1280 px | TASK-071, DEC-028 |

## Built since 2026-10-15

| Area | What works | Roadmap / tasks |
|---|---|---|
| **Navigation** | Quality Management (placeholder page, design agreed) above Accreditations; Engagements is labelled Accreditations (routes and data keep the name `engagement`); the app name is gone from the top | TASK-077, DEC-029 |
| **Link evidence** | Several pieces of evidence linked to one standard in one dialog, each with its justification ("Same for all") | — |
| **AI calls that hold up on real models** | Extraction streams (must start within `AI_CALL_TIMEOUT_MS`, default 180 s, then may go on while it writes; stopped after 90 s of silence or 20 min); a model that returns nothing or times out ends the run at once with a plain reason instead of four silent retries; plain-JSON fallback checked against the schema when a model cannot give a structured answer; reading and extraction never ask the model to think (task level, no setting), with a plain retry for servers that refuse the fields and the answer taken from the reasoning when the reply is empty; "Test reading" sends a real picture | docs/ai-import.md |
| **Import review** | Fields with a fixed list are a choice (degree level, unit type); units are offered from the org chart while a new name can still be typed; "Set a field … on N selected"; degree level accepts the usual spellings (Bachelor's, BSc, MBA, PhD); the Programs prompt (v2) reads a heading's degree level for the programs under it; the org chart import's extract step uses the Analysis model | TASK-073, TASK-076 |

## Left to build

In the order I would do them.

1. **Check what exists on real documents (needs the owner).** Redeploy, then the real run on the WSCUC, PUC and ABET files and tuning from the report: TASK-059 (production check of the services and the parser image) and TASK-056 (the PRD §19.2 acceptance test, seed-data replacement, embeddings decision).
2. **liteparse (ROADMAP-008, TASK-058).** The Appendix D changes in your repository; then drop the temporary fallback and LibreOffice.
3. **Quality Management: cycles and reporting (designed, DEC-029, docs/quality-management-plan.md).** TASK-078 schema and services, TASK-079 cycle templates, TASK-080 screens, TASK-086 IQF in operation (Link evidence, Assign scope, Assign champion, Create cycle; inherited by mapped external standards), TASK-081 recurrence and plans, TASK-082 nesting and cycles in Accreditations, TASK-083 Start a cycle from the ⋯ menu, TASK-084 assistant, TASK-085 report outputs (needs M4). Organization, languages, org chart and document import are built; directory sync (TASK-074) is parked until IT says what QuickLaunch offers.
4. **M4 Reports and submissions (ROADMAP-005; not yet broken into tasks).** Template to report, the seven block types, approvals and attestation, snapshots that cannot be edited, DOCX/PDF/XLSX/ZIP export, compliance-style matrix and evidence index (worded as internal, never "compliant"). Needs the `export` background job, which has no handler yet. It also completes M3's last test (one dataset fills two reports; a re-upload leaves the submitted snapshot unchanged).
5. **M5 Accreditor responses (ROADMAP-006).** Log a response, reply milestones, items and triage, revise-and-resubmit rounds, carry-forward.
6. **M6 Decisions and maintenance (ROADMAP-007).** Decision as a response, official status record, follow-up and recurring milestones, start the next cycle.
7. **P1 features.** M8 assessment cycle, self-rating, notifications, external reviewer, version diff (ROADMAP-010); M9 governed-metric adapter (ROADMAP-011).
8. **Smaller follow-ups.** Assistant follow-ups (TASK-068); compiler gaps (TASK-060); backlog outside the compiler (TASK-061): reporting frequency, BI connector, emailing links over SMTP.

## Waiting on the owner

- Redeploy the latest code and run the checks in TASK-059.
- Run the real documents (TASK-056) and send the Report tab.
- Land the Appendix D changes in the liteparse repository (TASK-058).
- Test what was added since the last deploy: Trash, Undo/Redo, drag-and-drop, multi-select, the assistant (including a bulk edit with Do it, Undo and Redo), the PUC titles.
- Try the editable org chart, the Programs import again (degree level from headings, unit choices), and Link evidence with several pieces.

## Known limits today

Memory search is by words and codes only (meaning-based search needs an amendment to DEC-023); the assistant has been tried on the fixtures and a fake model, not yet by you on real standards (run `pnpm assistant:eval` with a model to see how well it picks recipes); Arabic-letter numbering is not read as a sequence by the gap finder; the source viewer shows page text, not the page image; the task, roadmap and decision ledgers are edited by hand because `vef` is not installed (`vef check` has never been run).
