---
id: TASK-044
title: AI connection, embeddings and Settings → AI
description: >-
  The single import point for the AI SDK (aiExtract, aiOcr, embed), worker-only, logged and budgeted per run, with an
  admin Settings page for provider, model, keys, spend limits and embeddings
status: completed
priority: P0
last_updated: '2026-10-08'
generated:
  by: agent/claude-code
  at: '2026-10-08T12:30:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
related_decisions:
  - id: DEC-012
    name: Vercel AI SDK with the Anthropic provider behind aiExtract/aiOcr
    url: /DECISIONS.md#DEC-012
  - id: DEC-021
    name: Framework analysis may send the institution's IQF text to the AI
    url: /DECISIONS.md#DEC-021
  - id: DEC-023
    name: Embeddings rank IQF mapping candidates; vectors are stored in plain PostgreSQL arrays
    url: /DECISIONS.md#DEC-023
modified:
  by: agent/claude-code
  at: '2026-10-08T12:30:00.000Z'
---
# TASK-044 — AI connection, embeddings and Settings → AI

Built: `packages/core/src/ai/index.ts` is the only file that imports `ai`; it exposes `aiExtract({task, promptVersion, input, schema, runtime})` (structured output, temperature 0), `aiOcr({image, lang, runtime})` and `embed(texts, {runtime|budget})`. Calls run only inside an AI scope that `runJob` opens around every handler (and the settings connection test opens for itself); anywhere else they throw `AiScopeError`, and a test checks the API and SPA never reference them. Prompts are versioned files in `ai/prompts/` behind a registry (`getPrompt(task, version)`). Every call is appended to `runtime.calls` (task, prompt version, provider, model, tokens, ms, ok/error, cost) and logged as one JSON line, for handlers to write into `job.result`. `AiBudget` enforces the per-run token and cost limits before each call and throws `BudgetExceeded`; the output of a call is capped to what is left. Tests use `setAiModelForTests(createFakeAiModel([...]))` and `setEmbedderForTests(createFakeEmbedder())`; nothing reaches the network.

Settings: `ai_setting` (migrations 0036-0037; tenant RLS, audit, the worker can only read it). The provider keys are encrypted with AES-256-GCM, key derived from `APP_SECRET` (falls back to `AUTH_SECRET`); only "configured" and the last 4 characters are ever returned. Permission `ai:manage` (admin only). `GET/PUT /api/settings/ai`, `POST /api/settings/ai/test`. Handlers open the connection with `loadAiRuntime(ctx)` (saved settings first, then `AI_PROVIDER`/`AI_MODEL`/`ANTHROPIC_API_KEY`). Settings → AI page: model, write-only key, on/off, spend limits and prices, embeddings section, Test connection.

Embeddings (DEC-023): `embedding` table (migrations 0036-0037), owner type limited to `requirement` by a CHECK, no frozen-version trigger, plain `real[]`. `requirementEmbeddingItems`, `upsertEmbeddings` (re-embeds only when text hash, model or dimension changes) and `rankBySimilarity` (exact cosine in TypeScript; the number is for ordering only and is never shown as a match, coverage or confidence).

The `extract_text` handler now passes `aiOcr` to `extractText` as `ocrPage` when AI is on (Settings → AI, or the environment); page images count against the run's budget and the calls are recorded in `job.result.ai`. With AI off or not set up, scanned pages stay flagged `needsOcr`.

Not done here: no handler calls `aiExtract`, `embed` or `upsertEmbeddings` yet (the analysis steps do); there is no environment fallback for embeddings.
