---
id: TASK-048
title: Settings -> AI offers OpenAI, Google and any OpenAI-compatible server next to Anthropic
description: >-
  The AI connection is a real provider choice (Anthropic, OpenAI, Google, OpenAI-compatible with a Base URL for
  OpenRouter, Ollama, vLLM, LM Studio, Azure and similar); a saved key is tied to its provider and removed on a switch;
  the environment fallback has a key variable per provider
status: completed
priority: P1
last_updated: '2026-10-10'
generated:
  by: agent/claude-code
  at: '2026-10-10T15:00:00.000Z'
roadmap_item:
  id: ROADMAP-009
  name: M7 — Framework compiler
  url: /ROADMAP.md#ROADMAP-009
depends_on:
  - id: TASK-047
    name: Publishing is the review for external standards (DEC-022 publish gate)
    url: /TASKS.md#TASK-047
related_decisions:
  - id: DEC-012
    name: Vercel AI SDK with the Anthropic provider behind aiExtract/aiOcr
    url: /DECISIONS.md#DEC-012
modified:
  by: agent/claude-code
  at: '2026-10-10T15:00:00.000Z'
---
# TASK-048 — Settings -> AI offers OpenAI, Google and any OpenAI-compatible server next to Anthropic

The owner asked why Settings -> AI called Anthropic "the only provider available for now" when DEC-012 chose the Vercel AI SDK so that switching provider is configuration. The limit was ours: only `@ai-sdk/anthropic` was installed and the provider was fixed text.

Built:
- Providers: `anthropic`, `openai`, `google`, `openai_compatible` (`AI_PROVIDERS` in `packages/shared/src/ai.ts`). `@ai-sdk/openai` and `@ai-sdk/google` (v4 line, matching `ai` v7) are installed beside the existing `@ai-sdk/anthropic` and `@ai-sdk/openai-compatible`. All provider packages are imported only in `packages/core/src/ai/model.ts`, which stays the only place a provider is chosen. `openai_compatible` takes a Base URL and asks for `json_schema` output, so the schema reaches the model on OpenRouter, Ollama, vLLM, LM Studio and Azure.
- Data: migration 0043 (forward-only, snapshot and journal added like earlier ones) widens `ai_setting_provider_check`, adds nullable `base_url`, and a check that only `openai_compatible` may hold one. Existing rows stay `anthropic`.
- DTO: `AiSetting.baseUrl`; `UpdateAiSetting` accepts the new providers and `baseUrl`. A Base URL must be http(s) with no user name or password, is required for `openai_compatible` (checked in the service against the saved provider as well) and refused for the others, with a plain message.
- Keys: a saved key is tied to its provider. Switching provider removes it unless a new key is entered in the same save; if AI is on and the new provider has none, the save is refused ("enter the API key for the new provider"). The Base URL is cleared when moving away from `openai_compatible`. `openai_compatible` may run without a key (local Ollama).
- Environment fallback: `AI_PROVIDER` is one of the four; `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` beside `ANTHROPIC_API_KEY`, and `AI_BASE_URL`. Only the chosen provider's variable is read; a key saved in Settings still wins. Documented in `.env.example` and `config.ts`.
- UI (Connection tab): a native select (keyboard and touch work as on the other forms) lists the providers; the Base URL field appears only for OpenAI-compatible, with the hint "Ollama: http://host:11434/v1"; model hint adapts, no model names stored; a note says that changing provider removes the saved key. The "only provider available for now" text is gone. Limits, prices and embeddings are unchanged.
- OCR: `aiOcr` sends the page image as a `file` part; the model tests show all four providers put it in the request. A model that cannot read images fails with the typed `AiCallError`; `parseDocument` records it as an OCR warning and the page stays `needsOcr` (the `extract_text` run does not crash).
- Test connection works for every provider (same fixed prompt, through `createModel`).

Tests: `model.test.ts` (per provider: endpoint, key header, image part, Base URL and keyless use, bad URLs; fetch stubbed, no network); `settings.test.ts` (key removed on provider switch, kept when entered with it, Base URL rules, environment fallback per provider, saved key wins, no borrowed key); `packages/shared/src/ai.test.ts` (DTO and environment); `one-import-point.test.ts` (provider packages only in `model.ts`); `ai-settings-ui.test.tsx` (select opens and changes, Base URL only for OpenAI-compatible, credentials refused, key dropped on switch); `packages/db/src/ai.test.ts` (migration 0043 constraints).

Not done here: no live call to any provider (no keys in the sandbox); prices are still entered by hand for every provider; a row created only to hold limits has provider `anthropic` and takes precedence over `AI_PROVIDER` in the environment.
