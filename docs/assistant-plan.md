# In-app assistant — plan (planning only; nothing built)

Asked 2026-10-12: an AI agent inside the app (a bubble that opens a panel) that can run bulk edits, for example "put every indicator's statement in its title in this PUC version". This is the plan; the build has not started.

## What it is

A side panel, opened from a bubble at the bottom corner of every screen, where a person describes a change or asks a question in plain words (Arabic or English). The assistant looks at the standards, works out what to change and shows exactly what it will change. The person applies it with one click, and can undo it with one click.

It acts as the signed-in person, with their permissions and nothing more. It never publishes, approves or sets official status (DEC-006, DEC-005).

## How one request goes

1. **Context.** The panel sends where the person is: the version, the tab, the selected items, the open filter. Shown as small chips ("Working on PUC 2019-V2 · Requirements · 3 selected") that the person can remove.
2. **Understand.** The model reads what it needs through read-only tools (search requirements, read one with its notes, count by level, read a source page, list versions and mappings) and decides what to do.
3. **Propose.** It builds a change set from the write tools below. Nothing is written yet. The change set is checked by a dry run through the same core services the screens use, so an invalid change (a cycle, a frozen version, a missing parent) is refused before the person sees it.
4. **Preview.** The panel shows a table: item, field, before → after, one checkbox per row, counts on top ("148 changes in 148 items; 3 skipped: published version"), and a plain-words summary.
5. **Apply.** One click applies the ticked rows in one transaction through the existing services. It is one group in the undo system, so the normal toast and Ctrl/Cmd+Z reverse all of it, and the deletes it makes go to the Trash.
6. **Report.** The panel says what changed and what was skipped and why.

For anything that touches a published version, it proposes starting a new version first (the person decides).

## Tools it gets

Read: find requirements (by text, code, level, parent, flags), get a requirement with notes and source, count/group, read a source page, list versions/sources/mappings/proposals, read the latest analysis report.

Write, each as a proposed operation, never executed directly:
- edit fields (title, description, level label, assessable, language), notes (text, type, authority),
- move / re-parent / reorder (the existing `moveMany`), create, delete (to Trash), merge, split,
- rename or re-code with a mapping table,
- accept or dismiss suggested links and IQF proposals.

Two kinds of edit, handled differently:
- **Rule edits** ("swap title and description for items whose title is only the code", "delete every empty heading", "move all Measure items under Standard 3"). Deterministic: the model chooses a recipe and its filters and parameters, and ordinary code does the exact transformation on every row. No per-row model call, no per-row cost, fully reproducible and the preview is exact. Most bulk edits are this kind (the PUC title fix is: it is a rule, and was done as a migration).
- **Text edits** ("translate the descriptions to English", "tidy the OCR errors in these 40 items", "write short titles for these long statements"). The model writes the new text per item, in batches, within the cost cap. The preview shows each before/after and the source quote, and edited wording is marked as AI-written until the person accepts it. Verbatim fields (the official wording) are only changed by rule edits or by explicit per-row acceptance, never silently by the model.

## Where it runs

- AI only in the worker (CLAUDE.md constraint 7): the conversation turn is a job in the `agent` service (`assistant` job type added to QUEUE_GROUPS). The panel starts a turn through the API and follows its progress (polling first, server-sent events later). Applying a change set is an ordinary API call by the person's session, not a job: a person clicks, the five-step chain runs as that person.
- All new logic in `packages/core` (tool registry, dry-run, change-set format, recipes); the API and the panel are thin.
- A new AI role "Assistant" in Settings → AI → Models (account + model, defaulting to the analysis model), under the same per-run cap and call log; a cap per conversation turn.

## Data and privacy

- It sees framework content only: standards, notes, source pages, mappings, analysis reports, glossary. Never evidence files, datasets, responses, or accreditor letters unless a later decision allows it (DEC-013, DEC-019, DEC-021 cover framework text).
- Source text and standards text are untrusted data: instructions found inside a document are ignored (prompt injection). The model cannot apply anything; only the person's click does, after seeing the preview.
- Conversations are stored per person (new tables `assistant_conversation` and `assistant_message`, tenant RLS), visible to that person and to administrators for audit; the change sets and what was applied are in the audit trail with "proposed by the assistant, applied by <person>".

## Limits and safety

- A change set holds at most 500 item changes; more is split in steps.
- Deletes are always to the Trash and always shown in the preview, never mixed silently into another edit.
- Frozen (published) versions are read-only for it; it says so.
- A per-person rate and cost cap; a visible cost line per turn.
- Everything it does is also possible by hand; it adds speed, not powers.

## Build phases

1. **Plumbing (about 1 week).** Panel and bubble, conversation tables, the `assistant` job in the agent service, streaming of progress, the read-only tool registry, per-conversation caps, the Settings role. It can answer questions about the standards with links.
2. **Rule-based bulk edits (about 1–2 weeks).** The change-set format, dry-run through the core services, the preview table with row checkboxes, apply as one undoable group, recipes for the common cases (swap or fill fields, rename/re-code, re-parent by rule, delete by filter, bulk set assessable/level/language). Tests per recipe; an eval set of 30–40 sample instructions and the change sets they should produce.
3. **Text edits (about 1 week).** Batched per-item proposals within the cap, before/after with the source quote, accept per row, AI-written marking.
4. **Reach (later).** Create standards from instructions, act on the analysis report ("fix every unresolved gap I can see"), cross-standard questions, explain a mapping, scheduled helpers. Evidence and datasets only if a decision allows it.

## Decisions needed before building

1. Who can use it: framework editors only (recommended), or anyone with read access for questions?
2. Which model: the analysis model by default (recommended) or a separate cheaper one for chat.
3. Is the preview-then-apply step always required (recommended), or may a person turn on "apply without preview" for small changes?
4. Should the conversation be kept after the person closes the panel (recommended: kept, with delete)?
5. Should the assistant ever see evidence content? Not in this plan; needs its own decision.

## Why not now

The PUC title fix does not need it (a rule, done as migration 0047). The first real analysis run (TASK-056) will show which bulk edits people actually need, and that decides the recipes of phase 2. Phase 1 can start whenever you say.
