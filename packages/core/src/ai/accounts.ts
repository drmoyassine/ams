// AI accounts (DEC-025): saved connections. A name, a provider and a key encrypted at rest (AES-256-GCM, APP_SECRET).
// The key is write-only: the API returns whether one is set and its last 4 characters. Which account and model does what
// is settings.ts. Admin only (ai:manage); every function runs inside the request's transaction (five-step chain).
import { asc, eq } from 'drizzle-orm';
import { aiAccount, aiSetting } from '@ams/db';
import {
  AI_PROVIDER_LABELS, aiEnvKey, aiKeyOptional, baseUrlProblem, loadAiEnv,
  type AiAccount, type AiModelKind, type AiModelList, type AiProvider, type AiRole, type AiTestResult, type CreateAiAccount, type UpdateAiAccount,
} from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { assertPermitted } from '../permissions.js';
import { aiExtract, AiBudget, createAiRuntime, runInAiScope, type AiConfig } from './index.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { listProviderModels, ModelListError, type ModelSource } from './models.js';

export type AccountRow = typeof aiAccount.$inferSelect;
type SettingRow = typeof aiSetting.$inferSelect;

const ROLE_LABEL: Record<AiRole, string> = { analysis: 'Analysis', reading: 'Reading', embeddings: 'Embeddings', assistant: 'Assistant' };
/** "Google (Gemini)" -> "Google": the default label of an account. */
const defaultName = (provider: AiProvider) => AI_PROVIDER_LABELS[provider].replace(/\s*\(.*\)$/, '');

// ---- What an account resolves to ---------------------------------------------------------------------------------------
/** The account's own key, else the server environment's key for its provider (never another provider's), else none. */
export function accountApiKey(row: Pick<AccountRow, 'provider' | 'apiKeyEnc'>): string {
  if (row.apiKeyEnc) return decryptSecret(row.apiKeyEnc);
  return aiEnvKey(loadAiEnv(), row.provider as AiProvider) ?? '';
}
const keySourceOf = (row: AccountRow): AiAccount['keySource'] =>
  row.apiKeyEnc ? 'saved' : aiEnvKey(loadAiEnv(), row.provider as AiProvider) ? 'environment' : 'none';
/** A key is available (or the provider needs none). */
export const accountUsable = (row: AccountRow) => keySourceOf(row) !== 'none' || aiKeyOptional(row.provider as AiProvider);

export function accountConfig(row: AccountRow, model: string): AiConfig {
  return { provider: row.provider, model, apiKey: accountApiKey(row), baseUrl: row.provider === 'openai_compatible' ? row.baseUrl : null };
}
export const modelSourceOf = (row: AccountRow): ModelSource => ({ provider: row.provider as AiProvider, baseUrl: row.baseUrl, apiKey: accountApiKey(row) });
/** Editing the account (new key, other address) starts a fresh model list. */
const cacheKeyOf = (row: AccountRow) => `${row.id}|${row.updatedAt.getTime()}`;

const usedFor = (s: SettingRow | undefined, id: string): AiRole[] => [
  ...(s?.analysisAccountId === id ? ['analysis' as const] : []),
  ...(s?.visionAccountId === id ? ['reading' as const] : []),
  ...(s?.embedAccountId === id ? ['embeddings' as const] : []),
  ...(s?.assistantAccountId === id ? ['assistant' as const] : []),
];

function toDto(row: AccountRow, setting: SettingRow | undefined): AiAccount {
  return {
    id: row.id, name: row.name, provider: row.provider as AiProvider, baseUrl: row.baseUrl,
    keyConfigured: !!row.apiKeyEnc, keyLast4: row.apiKeyEnc ? row.apiKeyLast4 : null, keySource: keySourceOf(row),
    usedFor: usedFor(setting, row.id),
  };
}

async function settingRow(ctx: Ctx) {
  const [row] = await ctx.tx.select().from(aiSetting).where(eq(aiSetting.institutionId, ctx.caller.institutionId));
  return row;
}

/** One account of this institution (RLS keeps other institutions' invisible). */
export async function getAccountRow(ctx: Ctx, id: string): Promise<AccountRow> {
  const [row] = await ctx.tx.select().from(aiAccount).where(eq(aiAccount.id, id));
  if (!row) throw new NotFoundError('that AI account does not exist');
  return row;
}

async function nameTaken(ctx: Ctx, name: string, exceptId?: string) {
  const rows = await ctx.tx.select({ id: aiAccount.id, name: aiAccount.name }).from(aiAccount);
  return rows.some((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase());
}

// ---- CRUD ------------------------------------------------------------------------------------------------------------
export async function listAiAccounts(ctx: Ctx): Promise<AiAccount[]> {
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  const [rows, setting] = [await ctx.tx.select().from(aiAccount).orderBy(asc(aiAccount.createdAt), asc(aiAccount.name)), await settingRow(ctx)];
  return rows.map((r) => toDto(r, setting));
}

export async function createAiAccount(ctx: Ctx, input: CreateAiAccount): Promise<AiAccount> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  if (input.provider === 'openai_compatible') {
    const problem = input.baseUrl ? baseUrlProblem(input.baseUrl) : 'the OpenAI-compatible provider needs a Base URL';
    if (problem) throw new ValidationError(problem);
  } else if (input.baseUrl) {
    throw new ValidationError('a Base URL is only for the OpenAI-compatible provider');
  }
  let name = input.name ?? defaultName(input.provider);
  if (await nameTaken(ctx, name)) {
    if (input.name) throw new ValidationError(`an account called "${name}" already exists; use another name`);
    const base = name;
    for (let n = 2; await nameTaken(ctx, name); n++) name = `${base} ${n}`;
  }
  const [row] = await ctx.tx.insert(aiAccount).values({
    institutionId: ctx.caller.institutionId, name, provider: input.provider,
    baseUrl: input.provider === 'openai_compatible' ? input.baseUrl ?? null : null,
    apiKeyEnc: input.apiKey ? encryptSecret(input.apiKey) : null, apiKeyLast4: input.apiKey ? input.apiKey.slice(-4) : null,
  }).returning();
  return toDto(row!, await settingRow(ctx));
}

/**
 * Edits an account. `apiKey`: a string replaces the key, null removes it, absent keeps it. A saved key belongs to the
 * provider it was entered for, so changing the provider removes it unless a new key comes in the same save: it is never
 * sent to a different company. An account that is in use keeps its provider (the models chosen for it belong to that provider).
 */
export async function updateAiAccount(ctx: Ctx, id: string, patch: UpdateAiAccount): Promise<AiAccount> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  const existing = await getAccountRow(ctx, id);
  const setting = await settingRow(ctx);
  const provider = (patch.provider ?? existing.provider) as AiProvider;
  const switched = provider !== existing.provider;
  const roles = usedFor(setting, id);
  if (switched && roles.length) {
    throw new ConflictError(`this account is used for ${roles.map((r) => ROLE_LABEL[r]).join(' and ')}; choose another account there first, or add a new account for ${AI_PROVIDER_LABELS[provider]}`);
  }
  const baseUrl = provider !== 'openai_compatible' ? null : patch.baseUrl !== undefined ? patch.baseUrl : (switched ? null : existing.baseUrl);
  if (provider === 'openai_compatible') {
    const problem = baseUrl ? baseUrlProblem(baseUrl) : 'the OpenAI-compatible provider needs a Base URL';
    if (problem) throw new ValidationError(problem);
  } else if (patch.baseUrl) {
    throw new ValidationError('a Base URL is only for the OpenAI-compatible provider');
  }
  if (patch.name !== undefined && (await nameTaken(ctx, patch.name, id))) throw new ValidationError(`an account called "${patch.name}" already exists; use another name`);

  const set: Partial<typeof aiAccount.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (switched) set.provider = provider;
  if ((existing.baseUrl ?? null) !== baseUrl) set.baseUrl = baseUrl;
  if (switched && patch.apiKey === undefined) { set.apiKeyEnc = null; set.apiKeyLast4 = null; }
  if (patch.apiKey !== undefined) {
    set.apiKeyEnc = patch.apiKey === null ? null : encryptSecret(patch.apiKey);
    set.apiKeyLast4 = patch.apiKey === null ? null : patch.apiKey.slice(-4);
  }
  if (Object.keys(set).length === 0) return toDto(existing, setting);
  const [row] = await ctx.tx.update(aiAccount).set(set).where(eq(aiAccount.id, id)).returning();
  return toDto(row!, setting);
}

/** Deletes an account that nothing uses; an account used by a role names the roles and says what to do. */
export async function deleteAiAccount(ctx: Ctx, id: string): Promise<void> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  const existing = await getAccountRow(ctx, id);
  const roles = usedFor(await settingRow(ctx), id);
  if (roles.length) {
    throw new ConflictError(`"${existing.name}" is used for ${roles.map((r) => ROLE_LABEL[r]).join(' and ')}. Choose another account there (Models), then delete this one.`);
  }
  await ctx.tx.delete(aiAccount).where(eq(aiAccount.id, id));
}

// ---- Model list ------------------------------------------------------------------------------------------------------
/**
 * The models this account's provider offers, optionally only chat or embedding models. A metadata call (no inference),
 * made on the server so the key stays here. A failure comes back as `error` with an empty list, so the screen can fall
 * back to typing a model id.
 */
export async function listAccountModels(ctx: Ctx, id: string, opts: { kind?: AiModelKind; refresh?: boolean } = {}): Promise<AiModelList> {
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  const row = await getAccountRow(ctx, id);
  if (!accountUsable(row)) return { models: [], error: 'this account has no API key; edit it to add one', cached: false, fetchedAt: null };
  try {
    const r = await listProviderModels(modelSourceOf(row), { cacheKey: cacheKeyOf(row), refresh: opts.refresh ?? false });
    return { models: opts.kind ? r.models.filter((m) => m.kind === opts.kind) : r.models, error: null, cached: r.cached, fetchedAt: r.fetchedAt };
  } catch (e) {
    return { models: [], error: e instanceof ModelListError ? e.message : 'the model list could not be fetched', cached: false, fetchedAt: null };
  }
}

/** Providers whose own model list may carry prices (OpenRouter does; a compatible gateway can). The others never get a USD cap. */
const PRICED_LISTS: readonly AiProvider[] = ['openrouter', 'openai_compatible'];

/** The price per million tokens of one model, when the provider's list gives it; null otherwise (never typed by a person). */
export async function lookupModelPrice(row: AccountRow, model: string): Promise<{ input: number; output: number } | null> {
  if (!PRICED_LISTS.includes(row.provider as AiProvider) || !accountUsable(row)) return null;
  try {
    const { models } = await listProviderModels(modelSourceOf(row), { cacheKey: cacheKeyOf(row) });
    const m = models.find((x) => x.id === model);
    return m?.inputUsdPerMTok !== undefined && m.outputUsdPerMTok !== undefined ? { input: m.inputUsdPerMTok, output: m.outputUsdPerMTok } : null;
  } catch {
    return null;
  }
}

// ---- Test ------------------------------------------------------------------------------------------------------------
/**
 * "Test" on an account: one tiny structured call with a fixed prompt, no institution data, whether or not AI is switched
 * on. The model is the one given, else the one a role already uses with this account. An account with no model to try
 * (it is only for embeddings, or not assigned yet) is checked by fetching its model list instead, which proves the key
 * without any inference. Never throws for a failed call; the reason comes back with the key removed.
 */
export async function testAiAccount(ctx: Ctx, id: string, input: { model?: string } = {}): Promise<AiTestResult> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'ai:manage', { type: 'institution' });
  const row = await getAccountRow(ctx, id);
  const setting = await settingRow(ctx);
  const model = input.model ?? (setting?.analysisAccountId === id ? setting.model : null) ?? (setting?.visionAccountId === id ? setting.visionModel : null) ?? (setting?.assistantAccountId === id ? setting.assistantModel : null) ?? null;
  const started = Date.now();
  const base: AiTestResult = { ok: false, role: null, model, ms: 0, error: null, dimension: null };
  if (!accountUsable(row)) return { ...base, error: 'this account has no API key; edit it to add one' };
  if (!model || (setting?.embedAccountId === id && model === setting.embedModel)) {
    const list = await listAccountModels(ctx, id, { refresh: true });
    return { ...base, ok: list.error === null, ms: Date.now() - started, error: list.error };
  }
  const key = accountApiKey(row);
  return runInAiScope('connection-test', async () => {
    try {
      const runtime = createAiRuntime(accountConfig(row, model), new AiBudget());
      const { data } = await aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'Reply with ok set to true.', schema: z.object({ ok: z.boolean() }), runtime });
      return { ...base, ok: data.ok === true, ms: Date.now() - started, error: data.ok === true ? null : 'The model answered, but not as asked' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ...base, ms: Date.now() - started, error: (key ? message.split(key).join('[key]') : message).slice(0, 500) };
    }
  });
}
