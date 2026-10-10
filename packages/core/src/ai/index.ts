// The ONE import point for the AI SDK (DEC-012). Everything else calls aiExtract / aiOcr and never imports `ai`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { embedMany, generateText, Output } from 'ai';
import type { z } from 'zod';
import { aiEnvKey, aiKeyOptional, loadAiEnv } from '@ams/shared';
import { AiBudget, estimateTokens } from './budget.js';
import { AiCallError, AiNotConfiguredError, AiScopeError, BudgetExceeded } from './errors.js';
import { createEmbeddingModel, createModel, getTestEmbedder, hasTestModel, type AiConfig, type EmbedConfig } from './model.js';
import { getPrompt } from './prompts/index.js';

export * from './budget.js';
export * from './errors.js';
export { setAiModelForTests, setEmbedderForTests, type AiConfig, type EmbedConfig } from './model.js';
export { createFakeEmbedder } from './fake-embedder.js';
export { createFakeAiModel, type FakeAiModel, type FakeReply } from './fake-model.js';
export { getPrompt, PROMPTS } from './prompts/index.js';

/** One logged call. Callers write `runtime.calls` into `job.result` (PRD 15.3). */
export interface AiUsage {
  task: string;
  promptVersion: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  ok: boolean;
  error: string | null;
  /** Null when no prices are configured (and always for embeddings). */
  costUsd: number | null;
  /** Embedding calls: how many texts were embedded. */
  count?: number;
}

/** What a run needs to call the model: its connection, its budget, and the log of its calls. */
export interface AiRuntime {
  config: AiConfig;
  budget: AiBudget;
  calls: AiUsage[];
  /** The embedding endpoint, when Settings -> AI has embeddings switched on (DEC-023). */
  embedding?: EmbedConfig;
}

export const createAiRuntime = (config: AiConfig, budget: AiBudget = new AiBudget(), embedding?: EmbedConfig): AiRuntime =>
  ({ config, budget, calls: [], ...(embedding ? { embedding } : {}) });

// ---- Where AI may run -------------------------------------------------------------------------------------------
// Model calls happen in the worker (DEC-012). `runJob` opens the 'job' scope around every handler; the settings
// connection test opens 'connection-test'. Anywhere else (an API route, a plain service) aiExtract throws AiScopeError.
type Scope = 'job' | 'connection-test';
const scopes = new AsyncLocalStorage<Scope>();
export const runInAiScope = <T>(scope: Scope, fn: () => Promise<T>): Promise<T> => scopes.run(scope, fn);
export function assertAiScope(): void {
  if (!scopes.getStore()) throw new AiScopeError();
}

/** Connection from the environment, used when a run has no saved settings. */
export function envAiConfig(): AiConfig {
  const env = loadAiEnv();
  const apiKey = aiEnvKey(env, env.AI_PROVIDER) ?? '';
  if (!env.AI_MODEL || (!apiKey && !aiKeyOptional(env.AI_PROVIDER))) throw new AiNotConfiguredError();
  return { provider: env.AI_PROVIDER, model: env.AI_MODEL, apiKey, baseUrl: env.AI_BASE_URL ?? null };
}

const DEFAULT_MAX_OUTPUT = 16_000;
const redact = (message: string, key: string) => (key ? message.split(key).join('[key]') : message);

/** Checks the budget, calls, and logs the outcome (to `runtime.calls` and as one JSON line) whether or not it worked. */
async function tracked<T>(
  runtime: AiRuntime, meta: { task: string; promptVersion: string; provider?: string; model?: string; priced?: boolean; count?: number }, estimatedInput: number,
  call: (maxOutputTokens: number) => Promise<{ value: T; inputTokens: number; outputTokens: number }>,
  secrets: string[] = [runtime.config.apiKey],
): Promise<{ value: T; usage: AiUsage }> {
  assertAiScope();
  const { config, budget } = runtime;
  const { priced = true, ...named } = meta;
  const entry: AiUsage = {
    provider: config.provider, model: config.model, ...named, inputTokens: 0, outputTokens: 0, ms: 0, ok: false, error: null, costUsd: null,
  };
  const finish = () => {
    runtime.calls.push(entry);
    console.log(JSON.stringify({ level: 'info', msg: 'ai_call', ...entry }));
    return entry;
  };
  const started = Date.now();
  try {
    budget.assertCanSpend(estimatedInput);
    const remaining = budget.remainingTokens();
    const maxOutput = remaining === null ? DEFAULT_MAX_OUTPUT : Math.max(1, Math.min(DEFAULT_MAX_OUTPUT, remaining - estimatedInput));
    const r = await call(maxOutput);
    entry.inputTokens = r.inputTokens;
    entry.outputTokens = r.outputTokens;
    entry.costUsd = budget.record(r.inputTokens, r.outputTokens, priced);
    entry.ok = true;
    entry.ms = Date.now() - started;
    return { value: r.value, usage: finish() };
  } catch (e) {
    entry.ms = Date.now() - started;
    const raw = e instanceof Error ? e.message : String(e);
    entry.error = secrets.reduce((m, k) => redact(m, k), raw).slice(0, 500);
    finish();
    if (e instanceof BudgetExceeded) throw e;
    throw new AiCallError(entry.error);
  }
}

export interface AiExtractParams<T> {
  /** The prompt's task name (see prompts/index.ts). */
  task: string;
  promptVersion: string;
  /** The text to analyse. Never evidence files (DEC-013). */
  input: string;
  schema: z.ZodType<T>;
  runtime?: AiRuntime;
}

/** Structured extraction: the prompt for (task, promptVersion) plus `input`, answered as an object matching `schema`. Temperature 0. */
export async function aiExtract<T>(p: AiExtractParams<T>): Promise<{ data: T; usage: AiUsage }> {
  assertAiScope();
  const runtime = p.runtime ?? createAiRuntime(hasTestModel() ? { provider: 'test', model: 'test', apiKey: '' } : envAiConfig());
  const system = getPrompt(p.task, p.promptVersion);
  const { value, usage } = await tracked(runtime, { task: p.task, promptVersion: p.promptVersion }, estimateTokens(system + p.input), async (maxOutputTokens) => {
    const r = await generateText({
      model: createModel(runtime.config), system, prompt: p.input, temperature: 0, maxOutputTokens, maxRetries: 1,
      output: Output.object({ schema: p.schema }),
    });
    return { value: r.output as T, inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0 };
  });
  return { data: value, usage };
}

export interface AiOcrParams {
  image: Uint8Array;
  /** e.g. 'image/png'. */
  mime?: string;
  /** Language hint, e.g. 'ar' or 'en'. */
  lang: string;
  promptVersion?: string;
  runtime?: AiRuntime;
}

/** Reads the text off a page image (scanned or corrupted pages). liteparse's vision fallback is wired to this. */
export async function aiOcr(p: AiOcrParams): Promise<{ text: string; usage: AiUsage }> {
  assertAiScope();
  const runtime = p.runtime ?? createAiRuntime(hasTestModel() ? { provider: 'test', model: 'test', apiKey: '' } : envAiConfig());
  const version = p.promptVersion ?? 'v1';
  const system = `${getPrompt('ocr', version)} Language hint: ${p.lang}.`;
  // An image costs roughly its pixel area / 750 tokens; the byte size is the only thing known here.
  const { value, usage } = await tracked(runtime, { task: 'ocr', promptVersion: version }, estimateTokens(system) + Math.ceil(p.image.byteLength / 100), async (maxOutputTokens) => {
    const r = await generateText({
      model: createModel(runtime.config), temperature: 0, maxOutputTokens, maxRetries: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: system }, { type: 'file', data: p.image, mediaType: p.mime ?? 'image/png' }] }],
    });
    return { value: r.text, inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0 };
  });
  return { text: value, usage };
}

const EMBED_BATCH = 64;

/**
 * Embeds short framework texts (DEC-023) through the institution's embedding endpoint (OpenAI-compatible). Same guard,
 * log and per-run budget as aiExtract; the tokens count against the budget (not priced). The caller passes framework
 * text only: never evidence, datasets, responses, requests or letters. The vectors rank candidates; they are never a score
 * shown to people. Returns one vector per text, in order.
 */
export async function embed(texts: string[], opts: { runtime?: AiRuntime; budget?: AiBudget } = {}): Promise<{ vectors: number[][]; usage: AiUsage }> {
  assertAiScope();
  const base = opts.runtime;
  const cfg = base?.embedding;
  const test = getTestEmbedder();
  if (!cfg && !test) throw new AiNotConfiguredError('Embeddings are not set up: switch them on in Settings -> AI');
  const embedConfig: EmbedConfig = cfg ?? { baseUrl: 'test', model: 'test-embedder', apiKey: '', dimension: 32 };
  const runtime: AiRuntime = {
    config: { provider: 'openai-compatible', model: embedConfig.model, apiKey: embedConfig.apiKey },
    budget: opts.budget ?? base?.budget ?? new AiBudget(), calls: base?.calls ?? [],
  };
  const { value, usage } = await tracked(
    runtime, { task: 'embed', promptVersion: '-', priced: false, count: texts.length }, estimateTokens(texts.join(' ')),
    async () => {
      if (texts.length === 0) return { value: [] as number[][], inputTokens: 0, outputTokens: 0 };
      const vectors: number[][] = [];
      let tokens = 0;
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        if (test) {
          const r = await test(batch, embedConfig);
          vectors.push(...r.vectors); tokens += r.tokens ?? 0;
        } else {
          const r = await embedMany({ model: createEmbeddingModel(embedConfig), values: batch, maxRetries: 1 });
          vectors.push(...r.embeddings); tokens += r.usage.tokens;
        }
      }
      const bad = vectors.findIndex((v) => v.length !== embedConfig.dimension);
      if (vectors.length !== texts.length) throw new Error(`the embedding endpoint returned ${vectors.length} vectors for ${texts.length} texts`);
      if (bad >= 0) throw new Error(`the embedding endpoint returned ${vectors[bad]!.length} dimensions, but ${embedConfig.dimension} are set`);
      return { value: vectors, inputTokens: tokens, outputTokens: 0 };
    },
  );
  return { vectors: value, usage };
}
