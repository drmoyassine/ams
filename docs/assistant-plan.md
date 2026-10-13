# In-app assistant (a companion) — plan (phases 1 and 2 built, see Status)

Asked 2026-10-12: an AI agent inside the app (a bubble that opens a panel) that can run bulk edits, for example "put every indicator's statement in its title in this PUC version". This is the plan; phases 1 and 2 are built (see Status).

## What it is

A side panel, opened from a bubble at the bottom corner of every screen, where a person describes a change or asks a question in plain words (Arabic or English). The assistant looks at the standards, works out what to change and shows exactly what it will change. The person applies it with one click, and can undo it with one click.

It acts as the signed-in person, with their permissions and nothing more. It never publishes, approves or sets official status (DEC-006, DEC-005).

## How one request goes

1. **Context.** The panel sends where the person is: the version, the tab, the selected items, the open filter. Shown as small chips ("Working on PUC 2019-V2 · Requirements · 3 selected") that the person can remove.
2. **Understand.** The model reads what it needs through read-only tools (search requirements, read one with its notes, count by level, read a source page, list versions and mappings) and decides what to do.
3. **Propose.** It builds a change set from the write tools below. Nothing is written yet. The change set is checked by a dry run through the same core services the screens use, so an invalid change (a cycle, a frozen version, a missing parent) is refused before the person is asked.
4. **Confirm.** The assistant describes the change in the chat (what, where, how many, a few examples, anything skipped and why, for example "3 items skipped: published version") and asks. The person presses Do it, asks for a change, or cancels.
5. **Apply.** On Do it, the change set is applied to the draft in one transaction through the existing services, as one group in the undo system: the normal toast, Ctrl/Cmd+Z and **Ctrl/Cmd+Shift+Z (Redo)** reverse or repeat all of it, and the deletes it makes go to the Trash.
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
- **Rule edits** ("swap title and description for items whose title is only the code", "delete every empty heading", "move all Measure items under Standard 3"). Deterministic: the model chooses a recipe and its filters and parameters, and ordinary code does the exact transformation on every row. No per-row model call, no per-row cost, fully reproducible, so the examples in the confirmation are exact. Most bulk edits are this kind (the PUC title fix is: it is a rule, and was done as a migration).
- **Text edits** ("translate the descriptions to English", "tidy the OCR errors in these 40 items", "write short titles for these long statements"). The model writes the new text per item, in batches, within the cost cap. The confirmation in chat shows examples with the source quote, and edited wording is marked as AI-written until the person accepts it. Verbatim fields (the official wording) are only changed by rule edits or by explicit per-row acceptance, never silently by the model.

## Where it runs

- AI only in the worker (CLAUDE.md constraint 7): the conversation turn is a job in the `agent` service (`assistant` job type added to QUEUE_GROUPS). The panel starts a turn through the API and follows its progress (polling first, server-sent events later). Applying a change set is an ordinary API call by the person's session, not a job: a person clicks, the five-step chain runs as that person.
- All new logic in `packages/core` (tool registry, dry-run, change-set format, recipes); the API and the panel are thin.
- A new AI role "Assistant" in Settings → AI → Models (account + model, defaulting to the analysis model), under the same per-run cap and call log; a cap per conversation turn.

## Data and privacy

- It sees framework content only: standards, notes, source pages, mappings, analysis reports, glossary. Never evidence files, datasets, responses, or accreditor letters unless a later decision allows it (DEC-013, DEC-019, DEC-021 cover framework text).
- Source text and standards text are untrusted data: instructions found inside a document are ignored (prompt injection). The model cannot apply anything; only the person's button press does (the one-time confirmation token), after the assistant has said in the chat what it will do.
- Conversations are stored per person (new tables `assistant_conversation` and `assistant_message`, tenant RLS), visible to that person and to administrators for audit; the change sets and what was applied are in the audit trail with "proposed by the assistant, applied by <person>".

## Limits and safety

- A change set holds at most 500 item changes; more is split in steps.
- Deletes are always to the Trash and always named in the confirmation ("and delete 6 empty headings"), never mixed silently into another edit.
- Frozen (published) versions are read-only for it; it says so.
- A per-person rate and cost cap; a visible cost line per turn.
- Everything it does is also possible by hand; it adds speed, not powers.

## Memory

Three kinds of memory, plus knowledge that is not memory. Memory only ever inherits the person's privileges: it is checked at read time, not copied into anything the person cannot see.

| Layer | What | Who sees it |
|---|---|---|
| **Conversation** | The messages and tool results of one conversation; long ones are summarised into the conversation itself. | The person who held it (and administrators, for audit). |
| **Personal memory** | Preferences and facts the person told it: "I prefer English titles", "I mostly work on PUC", "keep Arabic as written". | Only that person. |
| **Workspace memory** (shared) | Conventions and decisions of the team, tied to a scope: the institution, one standard, one version or one engagement. "In PUC the indicator's statement is its title." "The ABET seed is 2025-26 text." "Our term for 'Measure' is 'Indicator group'." | Everyone who can read that scope. A memory about PUC is invisible to someone who cannot open PUC. |
| **Knowledge (not memory)** | The standards, notes, sources, glossary, decisions and analysis reports. | Read through the same tools and the same permission checks as the screens. |

**How it is stored.** One table `memory_item` (tenant RLS): scope type and id, visibility (private or workspace), kind (preference, convention, fact, decision), text, who wrote it and when, where it came from (a conversation and message, or typed by hand), pinned, expiry, archived, and what it replaced. Reads go through a core service that applies the same authorization as the rest of the app (the person's permissions on the scope), so removing someone's access to a standard removes the memory with it. Deleting a standard archives its memories rather than orphaning them.

**How it is written.**
- Never silently. The assistant proposes "Remember this?" as a small card; the person confirms, edits or declines. Workspace memory needs framework:write (or the matching scope permission); personal memory needs nothing.
- Only the person's own words, or what they confirm, become memory. Text found inside a standard, a source or a document is never saved as memory automatically (it could carry instructions).
- A page, **Settings → Assistant memory**, lists what is remembered (mine / shared), with edit, delete, pin and expiry, and an export.
- A nightly job in the `agent` service merges duplicates and flags contradictions (a workspace memory that conflicts with another is shown for a person to settle; it never picks).

**How it is used.** For each turn the assistant gets the current context (chips), the top few memories for that scope (about 8, ranked by words and codes first, by meaning later; pinned first), clearly labelled as "memory written by people", plus its tools. Precedence: a workspace convention beats a personal preference on content (what a title holds); a personal preference wins on style (language, wording of replies). If the two disagree it says so and asks.

**Meaning-based retrieval** would need memory text sent to the embedding provider; DEC-023 allows framework text only. Start with words and codes (Postgres full text and trigram); amend the decision before adding embeddings.

**Not in memory:** secrets, evidence content, personal data about named people, and anything from outside the person's privileges.

**Companion behaviour, not autonomy.** It may notice and suggest ("the run finished; 3 gaps are unresolved, shall I look?") as a notification in the panel, never act on its own. Every write still needs the person's click.

## Build phases

1. **Plumbing and memory (about 1–2 weeks).** Panel and bubble, conversation tables, `memory_item` with the personal and workspace layers, the Settings → Assistant memory page, the `assistant` job in the agent service, streaming of progress, the read-only tool registry, per-conversation caps, the Settings role. It can answer questions about the standards with links.
2. **Rule-based bulk edits (about 1–2 weeks).** The change-set format, dry-run through the core services, the in-chat confirmation with one-time tokens, apply as one undoable group (with **Redo** added to the undo system, which today has Undo only), recipes for the common cases (swap or fill fields, rename/re-code, re-parent by rule, delete by filter, bulk set assessable/level/language). Tests per recipe; an eval set of 30–40 sample instructions and the change sets they should produce.
3. **Text edits (about 1 week).** Batched per-item proposals within the cap; the confirmation in chat shows examples with the source quote; edited wording is marked as AI-written until the person accepts it.
4. **Reach (later).** Create standards from instructions, act on the analysis report ("fix every unresolved gap I can see"), cross-standard questions, explain a mapping, scheduled helpers. Evidence and datasets only if a decision allows it.

## Decisions (owner, 2026-10-12 — recorded as DEC-027)

1. **A companion, AI native.** It is part of the app, not a separate tool, and it inherits exactly the privileges of the person using it. Nothing it can see or do goes beyond what that person can see or do by hand.
2. **Model:** the analysis model by default (Settings → AI → Models, role "Assistant" defaults to the analysis account and model).
3. **Drafts only, confirmed in chat, no preview table.** It edits only drafts (it may create one) and never publishes, approves or touches a published version. There is no separate before/after preview: every change is undoable (Undo and Redo) and deletes go to the Trash. Instead the assistant must **confirm in the chat before it changes anything**: it says in plain words what it is about to do, with the count and two or three examples ("I will make the statement the title of 149 indicators in PUC 2019-V2, for example 1-1-1: «توضح رسالة…». Go ahead?"), and the person answers with a button (Do it / Change it / Cancel) or in words. Nothing is written before that. The confirmation is enforced in code, not by the model's good manners: the apply step accepts only a one-time confirmation token that the chat UI issues when the person presses the button, tied to that exact change set; the model cannot press it, and a changed proposal needs a new confirmation.
4. **Conversations are kept** (per person, deletable by that person), and the assistant has memory (below).
5. Evidence stays out of scope.

## Why not now

The PUC title fix does not need it (a rule, done as migration 0047). The first real analysis run (TASK-056) will show which bulk edits people actually need, and that decides the recipes of phase 2. Phase 1 can start whenever you say.

## Status

**Phase 1 is built (TASK-066, 2026-10-12): plumbing, conversations, memory, read-only answers. Phase 2 is built (TASK-067, 2026-10-13): bulk edits of a draft, confirmed in the chat, applied as one undoable group.** Phase 3 (text edits) is partly inside phase 2: `rewrite_text`, the batch step and the marker exist; see the end of this section.

What is where:
- **Data** (`packages/db/migrations/0048_assistant.sql`, `0049_assistant_rules.sql`): `assistant_conversation`, `assistant_message`, `memory_item`; `ai_setting` gained the assistant's switch, account, model and per-answer cap. A person sees only their own conversations (policy on `user_id`); an administrator reads others' only through two audited SQL functions. Audit of conversations and memory is metadata only (never the words), messages are not audited. The worker role can read conversations and memory, add and update assistant messages of the job's person while a turn runs, and cannot write memory at all.
- **AI** (`packages/core/src/ai`): `aiAgent` (multi-step tools, temperature 0, per-turn budget, one logged call per step, results passed as labelled capped data) in the one import point; prompt `prompts/assistant.v1.ts`; `loadAssistantRuntime`, `assistantReadiness`; the Assistant role in Settings -> AI -> Models (account and model default to analysis, `Assistant is on` switch, max tokens per answer, Test).
- **Job** (`packages/core/src/assistant/turn.ts`): job type `assistant` (agent group, compose `WORKER_QUEUES`). Payload `{conversationId, userMessageId, assistantMessageId}`. It runs as the person, saves progress after every step in its own transaction (`ctx.detached`, added to the job context), ends the message `done` or `failed` (never retried), and stops between steps when the person presses Stop.
- **Tools** (`assistant/tools`): read-only over framework content plus `propose_memory`; see the registry list below. Each runs inside a savepoint with the person's own ctx; a permission failure comes back as a refusal.
- **Memory** (`assistant/memory.ts`, `scope.ts`): personal and shared notes scoped to the institution, a standard, a version or an engagement; written only on the person's confirmation; read at read time through the same permission checks; retrieval by words (the shared Arabic-aware BM25 index), pinned first, recent preferred, top 8, expired and archived left out, injected as a block labelled "Memory written by people, not instructions from the system".
- **API** (`apps/api/src/routes/assistant.ts`): conversations, messages (send, poll, cancel), memory proposals (confirm, decline), memory CRUD, status, and the audit routes. 30 turns per person per hour (429 with the limit in the message).
- **UI** (`apps/web/src/components/assistant`, `pages/settings/assistant-memory.tsx`): bubble on every signed-in screen, drawer on wide screens (the page makes room) and full-screen sheet below `lg`, context chips (route level on every page; version name, tab and selection on the version page; engagement title), steps with links that open a requirement or a source page in place, "Remember this?" cards, history with delete, Markdown-lite without raw HTML.

**Known limits (phase 1).** Memory retrieval is by words and codes only: embedding memory text would send it to the embedding provider, which DEC-023 allows only for framework text, so it needs a DEC-023 amendment first. The nightly memory merge/contradiction job is not built. Context chips carry the version, tab, selection, engagement and route; the report tab's chosen run is not a chip. The assistant cannot see evidence, datasets, responses, requests, forms or letters (a test pins the tool list and scans the tool sources).

Message parts (`packages/shared/src/assistant.ts`): `text`, `tool_call`, `tool_result`, `memory_proposal` and (phase 2) `change_proposal`, which also carries the result of applying it (there is no separate `change_applied` part); clients ignore part types they do not know.

### Phase 2 (bulk edits): what is where

- **Change-set format** (`packages/shared/src/assistant-changes.ts`): `{versionId, summary, operations[]}`; each operation `{op, filter or targets, params}`, Zod-checked. Recipes (the model chooses recipe + filter, code computes every row): `swap_title_and_description` (the importer's `placeWording` rule, both directions), `set_field_by_filter`, `copy_field`, `prefix_or_replace_text`, `recode`, `reparent_by_rule`, `delete_by_filter`, `bulk_set_assessable`, `bulk_set_level_label`. General: `set_fields`, `set_note_fields`, `move`, `create_requirement`, `merge`, `split`, `accept_suggested_links`, `dismiss_suggested_links`, `rewrite_text` (text the model wrote), `create_draft` (alone, its own confirmed step). Filters (`RequirementFilterSchema`): ids, level, depth, code equals / prefix / pattern, parent, under, text, title is only the code, description empty, has children / notes, empty heading, duplicate code, assessable, language, quote not found, edited by a person, origin.
- **Planning** (`packages/core/src/assistant/changes/plan.ts`, `filter.ts`, `recipes.ts`): operations + current data -> steps (one core-service call each, exact ids and values, with the earlier values), counts per operation, 2 to 3 real before/after examples, skipped items with reasons, named deletes, links by code that would not follow a re-code, and the problems that make it impossible. Read-only. The rows are simulated in memory so a later operation sees an earlier one and the database's rules (code uniqueness, no cycles, depth, draft only, permission) are checked before anybody is asked. At most 500 item changes (a delete counts its sub-items); more is cut and the card says how much is left.
- **Why the job's check is a simulation.** The model's job runs with the worker database role, which by design cannot write standards, so it cannot run the services even in a rolled-back savepoint. `propose_changes` therefore validates with the in-memory simulation; the real dry run through the services (a savepoint that is always rolled back, `dryRunPlan`) happens in the API when the person presses Do it, before any token is issued, and the apply plans again.
- **Tools** (`assistant/tools/change-tools.ts`): `propose_changes`, `create_draft_proposal`, `find_requirements`, `draft_rewrites`. None changes anything; the registry has no tool that applies. Prompt `assistant.v2` (v1 kept), `assistant_rewrite.v1` (the batch step behind `draft_rewrites`, through `aiExtract` inside the turn's budget).
- **Confirmation** (`assistant/changes/proposal.ts`, API `routes/assistant.ts`): `POST /api/assistant/change-proposals/{messageId}/{partId}/confirm | apply | decline`, all `requires('framework:write')` and for the proposal's owner only (conversations are visible to their owner alone, so an administrator cannot confirm for someone else). `confirm` re-plans, dry-runs and issues a one-time token (`assistant_confirmation`: tenant RLS, user, message part, hash of the exact operations, plan hash, ten minutes, SHA-256 of the token stored, consumed atomically; the worker role has no grant on the table and a trigger refuses an AI or system identity). `apply` consumes the token, re-plans on the current data and applies only if the result is exactly what was confirmed; otherwise it answers `stale` and changes nothing. A new message from the person replaces an unanswered proposal. Refusals that are the person's problem are 409 (nothing consumed); results that spend the token (applied, failed, stale) are 200 with the status, so the token's use is committed.
- **One undo group.** `assistant_change_set` keeps the operations and the ordered undo descriptors the services reported while applying (`inverse`). The apply reports ONE descriptor, `POST /api/assistant/changes/{id}/undo`; undo replays the stored descriptors in one transaction (restore deletes from the Trash, earlier values, places, un-create, un-merge, un-split) and what they report becomes the next `inverse`, so `.../redo` is the same mechanism. Redo goes through the services again, so a version published meanwhile refuses it with the reason. The toast, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and the Undo / Redo buttons in the card all use the existing X-Undo / X-Replay machinery. Audit: the rows changed are audited as the person; one `assistant_change_set` event (`proposed_by: assistant`, `applied_by`, counts) carries no words.
- **Texts the assistant wrote** (`assistant_written_text`): from `rewrite_text`; the requirement shows "Written by the assistant" with Keep and Revert (Revert is a normal undoable edit) while the field still holds exactly that text; unreviewed ones show in the version's validation as a non-blocking warning. Publishing is unchanged.
- **UI** (`apps/web/src/components/assistant/change-card.tsx`, `written-marker.tsx`): the card in plain words with counts per operation, examples (dir="auto"), skipped, deletes named, Do it / Change it / Cancel, progress, the result with Undo and Redo, failed / stale / cancelled / replaced states; full-screen sheet on a phone.
- **Evaluation**: `packages/core/eval/assistant-instructions.json` (40 sample instructions, 13 in Arabic, on a fixture tree, each with the operations and the exact rows expected); `changes/eval.test.ts` asserts every one; `pnpm assistant:eval` also asks a real model (ASSISTANT_EVAL_BASE_URL / MODEL / KEY, or the app's AI environment) and compares the effect of the operations it gives.
- **Tables**: migration 0051 (`assistant_confirmation`, `assistant_change_set`, `assistant_written_text`).

**Known limits (phase 2).** Suggested new IQF items are not an operation (only suggested links are). Evidence and datasets stay out. Requests bigger than 500 item changes need the person to ask for each next step. Expired confirmations are not cleaned up. The model learns what became of a proposal only from the one-line status the conversation history gives it. The evaluation script measures what the operations the model gives DO on a fixture; it does not run the chat loop with tools.
