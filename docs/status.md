# Project status and what is left (2026-10-13)

A snapshot of where the AMS stands against the PRD milestones (§18.4) and the features added along the way. Source of truth for each item is its roadmap item and tasks; this page is the reading view. Built and tested means the automated tests pass (1,314 tests, 141 database tests); "not yet used on real documents" means the owner has not run it on real accreditor files yet.

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

## Left to build

In the order I would do them.

1. **Check what exists on real documents (needs the owner).** Redeploy, then the real run on the WSCUC, PUC and ABET files and tuning from the report: TASK-059 (production check of the services and the parser image) and TASK-056 (the PRD §19.2 acceptance test, seed-data replacement, embeddings decision).
2. **liteparse (ROADMAP-008, TASK-058).** The Appendix D changes in your repository; then drop the temporary fallback and LibreOffice.
3. **Organization, languages, org chart and document import (planned: docs/organization-plan.md, DEC-028).** the shared Docs tab, Documents area and import engine for every place the AI parses uploads into drafts (built, TASK-075; docs/ai-import.md); Programs from documents (TASK-076); a secondary language with UI and content switchers (TASK-070) and translation of the IQF and standards (TASK-071); an org chart builder (TASK-072), from an image (TASK-073) and from a directory (TASK-074, waiting on what QuickLaunch offers).
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

## Known limits today

Memory search is by words and codes only (meaning-based search needs an amendment to DEC-023); the assistant has been tried on the fixtures and a fake model, not yet by you on real standards (run `pnpm assistant:eval` with a model to see how well it picks recipes); Arabic-letter numbering is not read as a sequence by the gap finder; the source viewer shows page text, not the page image; the task, roadmap and decision ledgers are edited by hand because `vef` is not installed (`vef check` has never been run).
