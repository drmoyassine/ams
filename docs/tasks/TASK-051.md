---
id: TASK-051
title: Settings -> AI redesigned: saved accounts, one model per role, fetched model lists, a single cap, reading settings
description: >-
  Owner review of Settings -> AI: accounts saved once (keys encrypted at rest) and switched with a dropdown; OpenRouter
  as a standard provider; models fetched from the provider instead of typed; embeddings on any account that has them,
  with the vector size detected; one cap (tokens, or USD where the provider lists the price) instead of four inputs;
  and settings for reading scanned pages (OCR on/off, vision model, page cap, language hint)
status: completed
priority: P1
last_updated: '2026-10-11'
generated:
  by: agent/claude-code
  at: '2026-10-11T12:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-050
    name: Analysis proposes links to the IQF and new IQF items; a person accepts them (step E)
    url: /TASKS.md#TASK-050
related_decisions:
  - id: DEC-025
    name: 'AI accounts and role assignments: saved connections, one model per role, a single cap'
    url: /DECISIONS.md#DEC-025
  - id: DEC-012
    name: Vercel AI SDK with the Anthropic provider behind aiExtract/aiOcr
    url: /DECISIONS.md#DEC-012
  - id: DEC-023
    name: Embeddings rank IQF mapping candidates; vectors are stored in plain PostgreSQL arrays
    url: /DECISIONS.md#DEC-023
modified:
  by: agent/claude-code
  at: '2026-10-11T12:00:00.000Z'
---
# TASK-051 — Settings -> AI redesigned: saved accounts, one model per role, fetched model lists, a single cap, reading settings

Owner feedback on a screenshot review of Settings → AI: models should be fetched, accounts should be saved and switchable, OpenRouter should be a standard provider (and the OpenAI credentials should serve embeddings too), limits should be one cap with no prices, and reading (vision) had no settings. Redesigned as saved **accounts**, per-role **assignments** and one **cap** (DEC-025).

Built:
- Accounts (`packages/core/src/ai/accounts.ts`, table `ai_account`: tenant RLS, actor stamp, audit; the worker may only read): label, provider (`anthropic`, `openai`, `google`, `openrouter`, `openai_compatible`), Base URL only for `openai_compatible`, API key encrypted with the existing AES-256-GCM / `APP_SECRET` helper. The key is write-only (the DTO has `keyConfigured`, `keyLast4`, `keySource`). Changing an account's provider clears its key unless a new one comes in the same save; an account in use cannot change provider or be deleted (the message names the role). A key-less account uses the server environment's key for its own provider only. Routes (all `requires('ai:manage')`): `GET/POST /api/settings/ai/accounts`, `PATCH/DELETE .../accounts/{id}`, `POST .../accounts/{id}/test`, `GET .../accounts/{id}/models?kind=chat|embedding&refresh=true`.
- OpenRouter: provider `openrouter`, fixed address `OPENROUTER_BASE_URL` (shared), implemented in `model.ts` through the existing openai-compatible package (no official OpenRouter package is installed; one import point kept). `OPENROUTER_API_KEY` added to the environment fallback.
- Assignments (`settings.ts`; `ai_setting` stays one row per institution): Analysis (account + model), Reading / vision (account + model, null = same as analysis; OCR on/off; max AI-read pages per file, default 200; language hint, Auto by default), Embeddings (account + embedding model; Anthropic refused; the same account may serve analysis and embeddings). `loadAiRuntime` builds `config`, `vision`, `embedding` and the budget from them; with no account assigned to analysis the environment fallback (`AI_PROVIDER`, `AI_MODEL`, `<PROVIDER>_API_KEY`, `AI_BASE_URL`) works as before. The global "AI is on" switch stays.
- Embeddings per provider (`model.ts` `createEmbeddingModel`): OpenAI, OpenRouter and compatible servers use the OpenAI-style `/embeddings` API through the openai-compatible package; Google uses its own embedding model. The vector dimension is no longer typed: saving (or testing) an embeddings assignment makes one probe call (`dimension: 0` = detect) and stores the size; a model that does not answer is not saved; a new model re-embeds as already designed (rows are keyed by model).
- Model auto-fetch (`models.ts`): a metadata call per account on the server (no inference, no institution data, stated in the file header like the Test-connection exception). Anthropic `/v1/models`, OpenAI `/v1/models`, Google `/v1beta/models` (paged, kind from `supportedGenerationMethods`), OpenRouter `/api/v1/models` plus `/api/v1/embeddings/models` (prices per token become USD per million tokens; modalities give image support), compatible `{baseUrl}/models`. Normalised to `{id, name?, kind: chat|embedding|other, supportsImages?, inputUsdPerMTok?, outputUsdPerMTok?}`; `classifyModelId` guesses from the id only where the provider says nothing. In-memory cache, 10 minutes per account and per account version (editing the account starts a fresh list), Refresh skips it; a failure returns `error` with an empty list (the key never appears in it) and the UI falls back to a typed model id. No model names or prices in the repo.
- Cap (`cap.unit` tokens | usd): tokens always (provider independent, enforced by `AiBudget` as before); USD only when the analysis model's price is known from the provider's own list, stored in `input_usd_per_mtok` / `output_usd_per_mtok` when the model is chosen (OpenRouter, or a compatible gateway that lists pricing). Nobody types a price; the four old inputs are gone from the DTO and the screen. A USD cap whose price is gone is refused at run time rather than ignored. UI shows the token cap in millions with a clearly rough helper (`ROUGH_TOKENS_PER_SOURCE_PAGE`, 4000, in `packages/shared/src/ai.ts`). Recovery rounds moved under Advanced.
- Reading (`handlers.ts` / `reading.ts` / `parse-document.ts`): `extract_text` reads the settings through its job transaction. OCR off, an unusable reading account, or the page cap leave pages flagged `needsOcr` with a warning in the result; the cap stops the rendering of pages beyond it. `aiOcr` uses the reading connection but the run's budget and call log. A non-Auto language hint overrides the source's language (every source has one, default English, so a fallback-only hint would never apply).
- Migration `0045_ai_accounts.sql` (forward-only): new table, new columns on `ai_setting`, then a data step in the same transaction: the saved connection becomes an account (key ciphertext copied unchanged, so no re-encryption and nothing to retype), the embeddings endpoint becomes an OpenAI-compatible account of its own, assignments point at them, cap unit chosen (tokens if a token limit existed, else USD if a cost limit and both prices existed; both → tokens kept, cost limit cleared), legacy key columns cleared. Legacy columns (`provider`, `base_url`, `embed_base_url`, key columns) stay, unused and documented in `schema.ts`.
- UI (`apps/web/src/pages/settings/ai.tsx` + `ai-settings/`): prominent "AI is on" switch; tabs Accounts / Models / Limits (tabs scroll at 375 px, forms stack). Accounts: cards with provider, label, "Key ends in …1234", Test / Edit / Delete (inline confirmation), "Add account" opens the shared Dialog (provider select with OpenRouter, label, write-only key, Base URL only for compatible), one-sentence empty state. Models: Analysis, Reading and vision, Embeddings, each an account select plus a searchable model combobox (loading, Refresh, error and typed-id fallback, arrow keys / Enter / Escape), a Test per role held back while there are unsaved changes, the detected vector size read-only. Limits: unit select (US dollars disabled unless priced), one cap field, rough helper, Advanced. `e2e/responsive.mjs` seeds two accounts and adds Accounts, Add account and Limits states.

Tests (no network; fetch stubbed, fake model and embedder): account CRUD, encryption at rest, no key in DTO or audit, provider-change key clearing, delete-in-use refusal, per-institution isolation (core and db); migration 0045 against a database built to 0044 with seeded old-style rows (db); model lists per provider from inline fixtures, classification, caching, failures without the key (core); assignments → right account/provider including OpenRouter and one OpenAI account for both roles; dimension probe; tokens cap and USD cap (only when priced) enforced through `AiBudget`; OCR on/off, page cap, language hint and separate reading account in `extract_text`; env fallback incl. `OPENROUTER_API_KEY`; `createModel` / `createEmbeddingModel` request shapes per provider; API (`ai-settings.test.ts`), route permission coverage, UI (17 tests).

Not done here: no real provider was reachable, so every provider's list and embeddings call is verified against recorded-shape fixtures and stubbed requests only (first real use may need a tweak to a field name). The USD cap prices every call (including OCR with a different reading model) at the analysis model's price. The model list is fetched by the API process, not the worker. `ocr` and `ai_extract` job types still have no handlers. Pre-existing risk noticed, not changed: in `meta/_journal.json` migration 0044 has a `when` earlier than 0043's, and drizzle applies only migrations newer than the last applied one, so a database that already had 0043 but not 0044 would skip 0044; check that `iqf_item_proposal` exists on any existing deployment (0045 is newer than both and does not depend on it).
