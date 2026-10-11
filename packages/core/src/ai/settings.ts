// Settings -> AI (DEC-025): the global switch, which account and model does what (analysis, reading / vision, embeddings),
// the reading options and the cap on one run. The accounts themselves (provider, key) are accounts.ts. When no account is
// assigned to analysis the server environment (AI_PROVIDER, AI_MODEL, the provider's key variable, AI_BASE_URL) is used.
import { eq } from 'drizzle-orm';
import { aiSetting } from '@ams/db';
import {
  aiEnvKey, aiKeyOptional, DEFAULT_MAX_RECOVERY_ROUNDS, DEFAULT_OCR_MAX_PAGES, loadAiEnv, providerSupportsEmbeddings, AI_PROVIDER_LABELS,
  type AiProvider, type AiRole, type AiSetting, type AiTestResult, type UpdateAiSetting,
} from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';
import {
  aiExtract, aiOcr, AiBudget, AiDisabledError, AiNotConfiguredError, assertAiScope, createAiRuntime, embed, runInAiScope, type AiConfig, type AiRuntime, type EmbedConfig,
} from './index.js';
import { hasTestModel } from './model.js';
import { accountApiKey, accountConfig, accountUsable, getAccountRow, lookupModelPrice, type AccountRow } from './accounts.js';

const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
/** A 1x1 white PNG: the fixed picture "Test" on the reading model sends (no institution data). */
const TEST_PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+XJ/P2QAAAABJRU5ErkJggg==', 'base64'));

type SettingRow = typeof aiSetting.$inferSelect;

async function getRow(ctx: Ctx) {
  const [row] = await ctx.tx.select().from(aiSetting).where(eq(aiSetting.institutionId, ctx.caller.institutionId));
  return row;
}

/** The environment's fallback: provider, model, and whether its key (or none needed) is there. */
function envFallback() {
  const env = loadAiEnv();
  return { env, provider: env.AI_PROVIDER as AiProvider, model: env.AI_MODEL ?? null, keyPresent: !!aiEnvKey(env, env.AI_PROVIDER) || aiKeyOptional(env.AI_PROVIDER) };
}

function toDto(row: SettingRow | undefined): AiSetting {
  const e = envFallback();
  const hasPrice = row?.inputUsdPerMTok != null && row.outputUsdPerMTok != null;
  return {
    // With no saved settings the environment configuration is in force.
    enabled: row ? row.enabled : e.keyPresent && !!e.model,
    analysis: { accountId: row?.analysisAccountId ?? null, model: row?.model ?? (row?.analysisAccountId ? null : e.model) },
    reading: {
      accountId: row?.visionAccountId ?? null, model: row?.visionModel ?? null,
      ocrEnabled: row?.ocrEnabled ?? true, maxPages: row?.ocrMaxPages ?? DEFAULT_OCR_MAX_PAGES, language: row?.ocrLanguage ?? null,
    },
    embeddings: { enabled: row?.embedEnabled ?? false, accountId: row?.embedAccountId ?? null, model: row?.embedModel ?? null, dimension: row?.embedDimension ?? null },
    cap: { unit: (row?.capUnit as 'tokens' | 'usd' | undefined) ?? 'tokens', tokens: row?.maxTokensPerRun ?? null, usd: num(row?.maxCostUsdPerRun), usdAvailable: hasPrice },
    maxRecoveryRounds: row?.maxRecoveryRounds ?? DEFAULT_MAX_RECOVERY_ROUNDS,
    environment: { provider: e.provider, model: e.model, keyPresent: e.keyPresent },
  };
}

/** Settings -> AI: the assignments and the cap. Never a key (those are accounts). */
export async function getAiSettings(ctx: Ctx): Promise<AiSetting> {
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  return toDto(await getRow(ctx));
}

/** An account chosen in a patch must exist in this institution. */
async function chosenAccount(ctx: Ctx, id: string | null): Promise<AccountRow | null> {
  if (id === null) return null;
  try { return await getAccountRow(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) throw new ValidationError('the chosen AI account does not exist; pick one from the list');
    throw e;
  }
}

/** Embeddings probe: one short text through the account's embedding model, to find the vector size. Throws with a readable reason. */
async function probeEmbedding(account: AccountRow, model: string): Promise<number> {
  return runInAiScope('connection-test', async () => {
    const cfg: EmbedConfig = { provider: account.provider, baseUrl: account.baseUrl, model, apiKey: accountApiKey(account), dimension: 0 };
    const runtime = createAiRuntime({ provider: account.provider, model, apiKey: cfg.apiKey, baseUrl: account.baseUrl }, new AiBudget(), cfg);
    const { vectors } = await embed(['connection test'], { runtime });
    const size = vectors[0]?.length ?? 0;
    if (!size) throw new Error('the embedding model returned an empty vector');
    return size;
  });
}

/**
 * Saves the assignments, the reading options and the cap. Admin only. Choosing an embedding model probes it once to find
 * the vector size (stored, never typed). Choosing an analysis model on an account whose provider lists prices stores
 * that price, which is what makes a USD cap available; prices are never typed.
 */
export async function updateAiSettings(ctx: Ctx, patch: UpdateAiSetting): Promise<AiSetting> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  const existing = await getRow(ctx);
  const e = envFallback();

  // ---- analysis
  const analysisAccountId = patch.analysis?.accountId !== undefined ? patch.analysis.accountId : (existing?.analysisAccountId ?? null);
  const analysisAccountChanged = analysisAccountId !== (existing?.analysisAccountId ?? null);
  // A model belongs to the provider it was chosen for: a new account without a new model clears it.
  const model = patch.analysis?.model !== undefined ? patch.analysis.model : (analysisAccountChanged ? null : (existing?.model ?? null));
  const analysisAccount = await chosenAccount(ctx, analysisAccountId);

  // ---- reading (null account and model: the same as analysis)
  const visionAccountId = patch.reading?.accountId !== undefined ? patch.reading.accountId : (existing?.visionAccountId ?? null);
  const visionAccountChanged = visionAccountId !== (existing?.visionAccountId ?? null);
  const visionModel = patch.reading?.model !== undefined ? patch.reading.model : (visionAccountChanged ? null : (existing?.visionModel ?? null));
  await chosenAccount(ctx, visionAccountId);
  if (visionAccountId && !visionModel) throw new ValidationError('choose a model for reading, or choose "same as analysis"');

  // ---- embeddings
  const emb = patch.embeddings;
  const embedAccountId = emb?.accountId !== undefined ? emb.accountId : (existing?.embedAccountId ?? null);
  const embedAccountChanged = embedAccountId !== (existing?.embedAccountId ?? null);
  const embedModel = emb?.model !== undefined ? emb.model : (embedAccountChanged ? null : (existing?.embedModel ?? null));
  const embedEnabled = emb?.enabled ?? existing?.embedEnabled ?? false;
  const embedAccount = await chosenAccount(ctx, embedAccountId);
  if (embedAccount && !providerSupportsEmbeddings(embedAccount.provider as AiProvider)) {
    throw new ValidationError(`${AI_PROVIDER_LABELS[embedAccount.provider as AiProvider]} has no embedding models; choose an OpenAI, Google, OpenRouter or OpenAI-compatible account`);
  }
  if (embedEnabled && (!embedAccount || !embedModel)) throw new ValidationError('choose an account and an embedding model before switching embeddings on');

  // ---- the global switch
  const enabled = patch.enabled ?? existing?.enabled ?? false;
  if (enabled) {
    const effectiveModel = model ?? (analysisAccount ? null : e.model);
    if (!effectiveModel) throw new ValidationError('choose a model before switching AI on');
    if (analysisAccount ? !accountUsable(analysisAccount) : !e.keyPresent) throw new ValidationError('add an API key to the analysis account before switching AI on');
  }

  // ---- the cap: one unit; USD only when the model's price is known from the provider's own list
  const unit = patch.cap?.unit ?? (existing?.capUnit as 'tokens' | 'usd' | undefined) ?? 'tokens';
  let inputPrice = num(existing?.inputUsdPerMTok);
  let outputPrice = num(existing?.outputUsdPerMTok);
  if (analysisAccountChanged || (patch.analysis?.model !== undefined && patch.analysis.model !== (existing?.model ?? null)) || (unit === 'usd' && (inputPrice === null || outputPrice === null))) {
    const price = analysisAccount && model ? await lookupModelPrice(analysisAccount, model) : null;
    inputPrice = price?.input ?? null;
    outputPrice = price?.output ?? null;
  }
  if (unit === 'usd' && (inputPrice === null || outputPrice === null)) {
    throw new ValidationError('A USD cap needs the model\'s price, and this provider\'s model list does not give one. Use a tokens cap instead.');
  }

  // ---- embeddings: find the vector size
  let embedDimension = existing?.embedDimension ?? null;
  const embedChanged = embedAccountChanged || embedModel !== (existing?.embedModel ?? null);
  if (embedChanged) embedDimension = null;
  if (embedEnabled && embedAccount && embedModel && (embedDimension === null || embedChanged || (emb?.enabled === true && !existing?.embedEnabled))) {
    if (!accountUsable(embedAccount)) throw new ValidationError('add an API key to the embeddings account before switching embeddings on');
    try {
      embedDimension = await probeEmbedding(embedAccount, embedModel);
    } catch (err) {
      throw new ValidationError(`the embedding model did not answer, so it was not saved: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400));
    }
  }

  const ocrLanguage = patch.reading?.language !== undefined ? (patch.reading.language && patch.reading.language.toLowerCase() !== 'auto' ? patch.reading.language : null) : undefined;
  const set: Partial<typeof aiSetting.$inferInsert> = {
    analysisAccountId, model, visionAccountId, visionModel, embedAccountId, embedModel, embedEnabled, embedDimension, enabled, capUnit: unit,
    inputUsdPerMTok: inputPrice === null ? null : String(inputPrice), outputUsdPerMTok: outputPrice === null ? null : String(outputPrice),
  };
  if (patch.cap?.tokens !== undefined) set.maxTokensPerRun = patch.cap.tokens;
  if (patch.cap?.usd !== undefined) set.maxCostUsdPerRun = patch.cap.usd === null ? null : String(patch.cap.usd);
  if (patch.maxRecoveryRounds !== undefined) set.maxRecoveryRounds = patch.maxRecoveryRounds;
  if (patch.reading?.ocrEnabled !== undefined) set.ocrEnabled = patch.reading.ocrEnabled;
  if (patch.reading?.maxPages !== undefined) set.ocrMaxPages = patch.reading.maxPages;
  if (ocrLanguage !== undefined) set.ocrLanguage = ocrLanguage;

  if (existing) {
    const [row] = await ctx.tx.update(aiSetting).set(set).where(eq(aiSetting.id, existing.id)).returning();
    return toDto(row);
  }
  const [row] = await ctx.tx.insert(aiSetting).values({ ...set, institutionId: ctx.caller.institutionId }).returning();
  return toDto(row);
}

/** How many check-and-recover rounds a framework analysis may run (step D); the default when nothing is saved. */
export async function maxRecoveryRounds(ctx: Ctx): Promise<number> {
  return (await getRow(ctx))?.maxRecoveryRounds ?? DEFAULT_MAX_RECOVERY_ROUNDS;
}

// ---- The worker's view -------------------------------------------------------------------------------------------------
type Connection = { config: AiConfig } | { problem: string };

/** One model on one account (or, with no account, on the server environment's provider). `problem` says what is missing. */
function connect(account: AccountRow | null, model: string | null): Connection {
  const e = envFallback();
  const provider = (account?.provider ?? e.provider) as AiProvider;
  const apiKey = account ? accountApiKey(account) : (aiEnvKey(e.env, e.provider) ?? '');
  const baseUrl = provider === 'openai_compatible' ? (account ? account.baseUrl : (e.env.AI_BASE_URL ?? null)) : null;
  if (!model) return { problem: 'AI has no model: choose one in Settings -> AI' };
  if (provider === 'openai_compatible' && !baseUrl) return { problem: 'AI has no Base URL: add one in Settings -> AI' };
  if (!apiKey && !aiKeyOptional(provider)) return { problem: 'AI has no API key: add one in Settings -> AI' };
  return { config: account ? accountConfig(account, model) : { provider, model, apiKey, baseUrl } };
}

/**
 * Opens the AI connection for one run: the accounts and models assigned in Settings -> AI, else the environment
 * (AI_PROVIDER, AI_MODEL, the provider's API key variable), with the cap as the budget and the reading options. Job
 * handlers call this once and pass the runtime to every aiExtract / aiOcr, then store `runtime.calls` in the job result.
 * Worker/job path only.
 */
export async function loadAiRuntime(ctx: Ctx, opts: { requireEnabled?: boolean } = {}): Promise<AiRuntime> {
  assertAiScope();
  const row = await getRow(ctx);
  if (row && !row.enabled && opts.requireEnabled !== false) throw new AiDisabledError();
  const analysisAccount = row?.analysisAccountId ? await getAccountRow(ctx, row.analysisAccountId) : null;
  const model = row?.model ?? (analysisAccount ? null : envFallback().model);
  const main = connect(analysisAccount, model);
  if ('problem' in main && !hasTestModel()) throw new AiNotConfiguredError(main.problem);
  const config: AiConfig = 'config' in main ? main.config : { provider: analysisAccount?.provider ?? envFallback().provider, model: model ?? 'test', apiKey: '', baseUrl: null };

  // The cap: one unit. Tokens always work; USD needs the model's price from the provider's own list.
  const inputUsdPerMTok = num(row?.inputUsdPerMTok);
  const outputUsdPerMTok = num(row?.outputUsdPerMTok);
  const usd = row?.capUnit === 'usd';
  if (usd && (inputUsdPerMTok === null || outputUsdPerMTok === null) && !hasTestModel()) {
    throw new AiNotConfiguredError('the USD cap needs the model\'s price, which is not known; choose a tokens cap in Settings -> AI');
  }
  const budget = new AiBudget({
    maxTokens: usd ? null : (row?.maxTokensPerRun ?? null), maxCostUsd: usd ? num(row?.maxCostUsdPerRun) : null, inputUsdPerMTok, outputUsdPerMTok,
  });

  // Reading / vision: its own account and model when assigned, else the analysis ones.
  let vision: AiConfig | undefined;
  let visionError: string | undefined;
  if (row?.visionAccountId || row?.visionModel) {
    const account = row.visionAccountId ? await getAccountRow(ctx, row.visionAccountId) : analysisAccount;
    const v = connect(account, row.visionModel ?? model);
    if ('config' in v) vision = v.config; else visionError = v.problem;
  }
  const ocr = { enabled: row?.ocrEnabled ?? true, maxPages: row?.ocrMaxPages ?? DEFAULT_OCR_MAX_PAGES, language: row?.ocrLanguage ?? null };

  let embedding: EmbedConfig | undefined;
  if (row?.embedEnabled && row.embedAccountId && row.embedModel && row.embedDimension) {
    const account = await getAccountRow(ctx, row.embedAccountId);
    if (accountUsable(account) && providerSupportsEmbeddings(account.provider as AiProvider)) {
      embedding = { provider: account.provider, baseUrl: account.baseUrl, model: row.embedModel, apiKey: accountApiKey(account), dimension: row.embedDimension };
    }
  }
  return createAiRuntime(config, budget, embedding, { ...(vision ? { vision } : {}), ...(visionError ? { visionError } : {}), ocr });
}

/**
 * "Test" on one role: a tiny call through the saved assignment, whether or not AI is switched on. Analysis: one
 * structured call with a fixed prompt. Reading: a fixed 1x1 picture, to prove the model accepts images. Embeddings: one
 * short text, which also finds and stores the vector size. The only model calls that run outside a worker job; no
 * institution data. Never throws for a failed call; the reason comes back with the key removed.
 */
export async function testAiConnection(ctx: Ctx, role: AiRole = 'analysis'): Promise<AiTestResult> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  const row = await getRow(ctx);
  const started = Date.now();
  const result: AiTestResult = { ok: false, role, model: null, ms: 0, error: null, dimension: null };
  const secrets: string[] = [];
  try {
    if (role === 'embeddings') {
      if (!row?.embedAccountId || !row.embedModel) throw new Error('Choose an embeddings account and model first.');
      result.model = row.embedModel;
      const account = await getAccountRow(ctx, row.embedAccountId);
      secrets.push(accountApiKey(account));
      if (!providerSupportsEmbeddings(account.provider as AiProvider)) throw new Error(`${AI_PROVIDER_LABELS[account.provider as AiProvider]} has no embedding models.`);
      const size = await probeEmbedding(account, row.embedModel);
      result.dimension = size;
      result.ok = true;
      if (size !== row.embedDimension) await ctx.tx.update(aiSetting).set({ embedDimension: size }).where(eq(aiSetting.id, row.id));
    } else {
      await runInAiScope('connection-test', async () => {
        const runtime = await loadAiRuntime(ctx, { requireEnabled: false });
        const config = role === 'reading' ? (runtime.vision ?? runtime.config) : runtime.config;
        secrets.push(config.apiKey);
        if (role === 'reading' && runtime.visionError) throw new AiNotConfiguredError(runtime.visionError);
        result.model = config.model;
        if (role === 'reading') {
          await aiOcr({ image: TEST_PNG, lang: 'en', runtime });
          result.ok = true;
        } else {
          const { data } = await aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'Reply with ok set to true.', schema: z.object({ ok: z.boolean() }), runtime });
          result.ok = data.ok === true;
          if (!result.ok) result.error = 'The model answered, but not as asked';
        }
      });
    }
  } catch (err) {
    result.ok = false;
    const message = err instanceof Error ? err.message : String(err);
    result.error = secrets.filter(Boolean).reduce((m, k) => m.split(k).join('[key]'), message).slice(0, 500);
  }
  result.ms = Date.now() - started;
  return result;
}

/**
 * Can a run that needs the model start now? Assignments first, then the environment, like loadAiRuntime, but without
 * opening a connection, so a service can refuse a run up front. Never calls the model.
 */
export async function aiReadiness(ctx: Ctx): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await getRow(ctx);
  if (row && !row.enabled) return { ok: false, reason: new AiDisabledError().message };
  if (hasTestModel()) return { ok: true };
  const e = envFallback();
  if (!row && !(e.keyPresent && e.model)) return { ok: false, reason: new AiNotConfiguredError().message };
  const account = row?.analysisAccountId ? await getAccountRow(ctx, row.analysisAccountId) : null;
  const c = connect(account, row?.model ?? (account ? null : e.model));
  if ('problem' in c) return { ok: false, reason: c.problem };
  if (row?.capUnit === 'usd' && (row.inputUsdPerMTok == null || row.outputUsdPerMTok == null)) {
    return { ok: false, reason: 'the USD cap needs the model\'s price, which is not known; choose a tokens cap in Settings -> AI' };
  }
  return { ok: true };
}
