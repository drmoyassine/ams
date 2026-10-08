import { eq } from 'drizzle-orm';
import { aiSetting } from '@ams/db';
import { loadAiEnv, type AiSetting, type AiTestResult, type UpdateAiSetting } from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';
import {
  aiExtract, AiBudget, AiDisabledError, AiNotConfiguredError, assertAiScope, createAiRuntime, embed, runInAiScope, type AiRuntime, type EmbedConfig,
} from './index.js';
import { hasTestModel } from './model.js';
import { decryptSecret, encryptSecret } from './crypto.js';

const num = (v: string | null) => (v === null ? null : Number(v));
const envKeyPresent = () => !!loadAiEnv().ANTHROPIC_API_KEY;

async function getRow(ctx: Ctx) {
  const [row] = await ctx.tx.select().from(aiSetting).where(eq(aiSetting.institutionId, ctx.caller.institutionId));
  return row;
}

function toDto(row: typeof aiSetting.$inferSelect | undefined): AiSetting {
  const env = loadAiEnv();
  const keyConfigured = !!row?.apiKeyEnc;
  return {
    provider: 'anthropic', // the only provider that ships; the column check keeps it so
    model: row?.model ?? env.AI_MODEL ?? null,
    keyConfigured: keyConfigured || envKeyPresent(),
    keyLast4: keyConfigured ? row!.apiKeyLast4 : null,
    keySource: keyConfigured ? 'settings' : envKeyPresent() ? 'environment' : 'none',
    maxTokensPerRun: row?.maxTokensPerRun ?? null,
    maxCostUsdPerRun: num(row?.maxCostUsdPerRun ?? null),
    inputUsdPerMTok: num(row?.inputUsdPerMTok ?? null),
    outputUsdPerMTok: num(row?.outputUsdPerMTok ?? null),
    // With no saved settings the environment configuration is in force.
    enabled: row ? row.enabled : envKeyPresent() && !!env.AI_MODEL,
    embeddings: {
      enabled: row?.embedEnabled ?? false,
      baseUrl: row?.embedBaseUrl ?? null,
      model: row?.embedModel ?? null,
      dimension: row?.embedDimension ?? null,
      keyConfigured: !!row?.embedApiKeyEnc,
      keyLast4: row?.embedApiKeyEnc ? row.embedApiKeyLast4 : null,
    },
  };
}

/** Settings -> AI, without the key: whether one is set and its last 4 characters. */
export async function getAiSettings(ctx: Ctx): Promise<AiSetting> {
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  return toDto(await getRow(ctx));
}

/** Saves the connection. The key is encrypted before it is stored; absent keeps it, null removes it. Admin only. */
export async function updateAiSettings(ctx: Ctx, patch: UpdateAiSetting): Promise<AiSetting> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  const existing = await getRow(ctx);
  const merged = {
    model: patch.model !== undefined ? patch.model : (existing?.model ?? null),
    maxCostUsdPerRun: patch.maxCostUsdPerRun !== undefined ? patch.maxCostUsdPerRun : num(existing?.maxCostUsdPerRun ?? null),
    inputUsdPerMTok: patch.inputUsdPerMTok !== undefined ? patch.inputUsdPerMTok : num(existing?.inputUsdPerMTok ?? null),
    outputUsdPerMTok: patch.outputUsdPerMTok !== undefined ? patch.outputUsdPerMTok : num(existing?.outputUsdPerMTok ?? null),
    enabled: patch.enabled ?? existing?.enabled ?? false,
    hasKey: patch.apiKey !== undefined ? patch.apiKey !== null : !!existing?.apiKeyEnc,
  };
  if (merged.maxCostUsdPerRun != null && (merged.inputUsdPerMTok == null || merged.outputUsdPerMTok == null)) {
    throw new ValidationError('a cost limit needs the price per million input and output tokens, to count the cost');
  }
  if (merged.enabled && (!merged.model && !loadAiEnv().AI_MODEL)) throw new ValidationError('choose a model before switching AI on');
  if (merged.enabled && !merged.hasKey && !envKeyPresent()) throw new ValidationError('add an API key before switching AI on');
  const emb = patch.embeddings;
  if (emb) {
    const next = {
      enabled: emb.enabled ?? existing?.embedEnabled ?? false,
      baseUrl: emb.baseUrl !== undefined ? emb.baseUrl : (existing?.embedBaseUrl ?? null),
      model: emb.model !== undefined ? emb.model : (existing?.embedModel ?? null),
      dimension: emb.dimension !== undefined ? emb.dimension : (existing?.embedDimension ?? null),
    };
    if (next.enabled && (!next.baseUrl || !next.model || !next.dimension)) {
      throw new ValidationError('embeddings need a base URL, a model and the vector dimension before they are switched on');
    }
  }

  const set: Partial<typeof aiSetting.$inferInsert> = {};
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.model !== undefined) set.model = patch.model;
  if (patch.apiKey !== undefined) {
    set.apiKeyEnc = patch.apiKey === null ? null : encryptSecret(patch.apiKey);
    set.apiKeyLast4 = patch.apiKey === null ? null : patch.apiKey.slice(-4);
  }
  if (patch.maxTokensPerRun !== undefined) set.maxTokensPerRun = patch.maxTokensPerRun;
  if (patch.maxCostUsdPerRun !== undefined) set.maxCostUsdPerRun = patch.maxCostUsdPerRun === null ? null : String(patch.maxCostUsdPerRun);
  if (patch.inputUsdPerMTok !== undefined) set.inputUsdPerMTok = patch.inputUsdPerMTok === null ? null : String(patch.inputUsdPerMTok);
  if (patch.outputUsdPerMTok !== undefined) set.outputUsdPerMTok = patch.outputUsdPerMTok === null ? null : String(patch.outputUsdPerMTok);
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (emb) {
    if (emb.enabled !== undefined) set.embedEnabled = emb.enabled;
    if (emb.baseUrl !== undefined) set.embedBaseUrl = emb.baseUrl;
    if (emb.model !== undefined) set.embedModel = emb.model;
    if (emb.dimension !== undefined) set.embedDimension = emb.dimension;
    if (emb.apiKey !== undefined) {
      set.embedApiKeyEnc = emb.apiKey === null ? null : encryptSecret(emb.apiKey);
      set.embedApiKeyLast4 = emb.apiKey === null ? null : emb.apiKey.slice(-4);
    }
  }

  if (existing) {
    if (Object.keys(set).length === 0) return toDto(existing);
    const [row] = await ctx.tx.update(aiSetting).set(set).where(eq(aiSetting.id, existing.id)).returning();
    return toDto(row);
  }
  const [row] = await ctx.tx.insert(aiSetting).values({ ...set, institutionId: ctx.caller.institutionId }).returning();
  return toDto(row);
}

/**
 * Opens the AI connection for one run: saved settings first, then the environment (AI_PROVIDER, AI_MODEL,
 * ANTHROPIC_API_KEY), with the institution's per-run limits as the budget. Job handlers call this once and pass the
 * runtime to every aiExtract / aiOcr, then store `runtime.calls` in the job result. Worker/job path only.
 */
export async function loadAiRuntime(ctx: Ctx, opts: { requireEnabled?: boolean } = {}): Promise<AiRuntime> {
  assertAiScope();
  const env = loadAiEnv();
  const row = await getRow(ctx);
  if (row && !row.enabled && opts.requireEnabled !== false) throw new AiDisabledError();
  const model = row?.model ?? env.AI_MODEL;
  const apiKey = row?.apiKeyEnc ? decryptSecret(row.apiKeyEnc) : env.ANTHROPIC_API_KEY;
  const provider = row?.provider ?? env.AI_PROVIDER;
  if (!hasTestModel()) {
    if (!model) throw new AiNotConfiguredError('AI has no model: choose one in Settings -> AI');
    if (!apiKey) throw new AiNotConfiguredError('AI has no API key: add one in Settings -> AI');
  }
  const budget = new AiBudget({
    maxTokens: row?.maxTokensPerRun ?? null, maxCostUsd: num(row?.maxCostUsdPerRun ?? null),
    inputUsdPerMTok: num(row?.inputUsdPerMTok ?? null), outputUsdPerMTok: num(row?.outputUsdPerMTok ?? null),
  });
  const embedding: EmbedConfig | undefined = row?.embedEnabled && row.embedBaseUrl && row.embedModel && row.embedDimension
    ? { baseUrl: row.embedBaseUrl, model: row.embedModel, dimension: row.embedDimension, apiKey: row.embedApiKeyEnc ? decryptSecret(row.embedApiKeyEnc) : '' }
    : undefined;
  return createAiRuntime({ provider, model: model ?? 'test', apiKey: apiKey ?? '' }, budget, embedding);
}

/**
 * "Test connection": one tiny structured call through the saved settings, whether or not AI is switched on. The only
 * model call that runs outside a worker job, with a fixed prompt and no institution data. Never throws for a failed
 * call; the reason comes back with the key removed.
 */
export async function testAiConnection(ctx: Ctx): Promise<AiTestResult> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  const row = await getRow(ctx);
  return runInAiScope('connection-test', async () => {
    const started = Date.now();
    let result: AiTestResult = { ok: false, model: null, ms: 0, error: null, embeddings: null };
    let runtime: AiRuntime | undefined;
    try {
      runtime = await loadAiRuntime(ctx, { requireEnabled: false });
      result.model = runtime.config.model;
      const { data } = await aiExtract({
        task: 'connection_test', promptVersion: 'v1', input: 'Reply with ok set to true.', schema: z.object({ ok: z.boolean() }), runtime,
      });
      result = { ...result, ok: data.ok === true, error: data.ok === true ? null : 'The model answered, but not as asked' };
    } catch (e) {
      result = { ...result, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    result.ms = Date.now() - started;
    // The embedding endpoint is checked too when it is switched on: one short text, and the vector size must match.
    if (row?.embedEnabled) {
      const t0 = Date.now();
      const emb: NonNullable<AiTestResult['embeddings']> = { ok: false, model: row.embedModel, dimension: row.embedDimension, ms: 0, error: null };
      try {
        if (!runtime?.embedding) runtime = await loadAiRuntime(ctx, { requireEnabled: false });
        if (!runtime.embedding) throw new AiNotConfiguredError('Embeddings need a base URL, a model and the vector dimension');
        const { vectors } = await embed(['connection test'], { runtime });
        emb.ok = vectors.length === 1; emb.dimension = vectors[0]?.length ?? emb.dimension;
      } catch (e) {
        emb.error = e instanceof Error ? e.message : String(e);
      }
      emb.ms = Date.now() - t0;
      result.embeddings = emb;
    }
    return result;
  });
}
