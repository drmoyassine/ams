import { z } from 'zod';

/**
 * Providers an AI account can use. Switching provider is configuration, not code (DEC-012, DEC-025).
 * `openrouter` has a fixed address (OPENROUTER_BASE_URL) and needs only a key. `openai_compatible` is any other server
 * that speaks the OpenAI chat API at a Base URL: Ollama, vLLM, LM Studio, Azure and the like.
 */
export const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'openai_compatible'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google (Gemini)', openrouter: 'OpenRouter', openai_compatible: 'OpenAI-compatible (custom Base URL)',
};
/** OpenRouter's fixed address: the user never types it. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** Providers that offer embedding models. Anthropic has none (DEC-023). */
export const AI_EMBEDDING_PROVIDERS = ['openai', 'google', 'openrouter', 'openai_compatible'] as const satisfies readonly AiProvider[];
export const providerSupportsEmbeddings = (provider: AiProvider) => (AI_EMBEDDING_PROVIDERS as readonly string[]).includes(provider);

/** What a role (Settings -> AI -> Models) uses an account for. */
export const AI_ROLES = ['analysis', 'reading', 'embeddings', 'assistant'] as const;
export type AiRole = (typeof AI_ROLES)[number];

/** The cap on one analysis run: tokens always; USD only when the model's price is known from the provider's own list. */
export const AI_CAP_UNITS = ['tokens', 'usd'] as const;
export type AiCapUnit = (typeof AI_CAP_UNITS)[number];
/**
 * A VERY rough guide for the helper text next to a token cap: about this many tokens are spent per page of source text
 * across a whole analysis (reading, extraction, checks, links). Real runs vary a lot with the model and the document.
 */
export const ROUGH_TOKENS_PER_SOURCE_PAGE = 4000;
/** Pages of scanned source one file may have read by the AI before the rest stay flagged "needs OCR". */
export const DEFAULT_OCR_MAX_PAGES = 200;
export const MAX_OCR_MAX_PAGES = 5000;

/** A provider-model Base URL: http(s), no embedded credentials (a key belongs in the key field). Returns an error message or null. */
export function baseUrlProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return 'the Base URL is not a valid URL, for example http://host:11434/v1'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'the Base URL must start with http:// or https://';
  if (url.username || url.password) return 'the Base URL must not contain a user name or password; put the key in the API key field';
  return null;
}


// ---- Accounts: saved connections (DEC-025) --------------------------------------------------------------------------
const baseUrlField = z.string().trim().min(1).max(500).refine((v) => baseUrlProblem(v) === null, { message: 'the Base URL must be an http(s) address without a user name or password' });

/** A saved connection as the client sees it. The key itself never leaves the server: only whether one is set and its last 4 characters. */
export const AiAccountSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: z.enum(AI_PROVIDERS),
  /** Only for `openai_compatible`; null for the others (OpenRouter's address is fixed). */
  baseUrl: z.string().nullable(),
  keyConfigured: z.boolean(),
  keyLast4: z.string().nullable(),
  /** `saved`: the key stored here; `environment`: this provider's server environment key is used; `none`. */
  keySource: z.enum(['saved', 'environment', 'none']),
  /** Which roles use this account now (a used account cannot be deleted). */
  usedFor: z.array(z.enum(AI_ROLES)),
});
export type AiAccount = z.infer<typeof AiAccountSchema>;

const accountRules = (v: { provider?: AiProvider | undefined; baseUrl?: string | null | undefined }, ctx: z.RefinementCtx) => {
  if (v.provider && v.provider !== 'openai_compatible' && v.baseUrl) {
    ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'a Base URL is only for the OpenAI-compatible provider' });
  }
};
const apiKeyField = z.string().trim().min(8).max(500);

export const CreateAiAccountSchema = z.object({
  /** Defaults to the provider's name. */
  name: z.string().trim().min(1).max(80).optional(),
  provider: z.enum(AI_PROVIDERS),
  baseUrl: baseUrlField.nullable().optional(),
  apiKey: apiKeyField.optional(),
}).strict().superRefine((v, ctx) => {
  accountRules(v, ctx);
  if (v.provider === 'openai_compatible' && !v.baseUrl) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'the OpenAI-compatible provider needs a Base URL' });
});
export type CreateAiAccount = z.infer<typeof CreateAiAccountSchema>;

/** `apiKey`: a string replaces the saved key, `null` removes it, absent keeps it. Changing `provider` removes the key unless a new one comes with it. */
export const UpdateAiAccountSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  provider: z.enum(AI_PROVIDERS).optional(),
  baseUrl: baseUrlField.nullable().optional(),
  apiKey: apiKeyField.nullable().optional(),
}).strict().superRefine(accountRules);
export type UpdateAiAccount = z.infer<typeof UpdateAiAccountSchema>;

export const AiAccountTestSchema = z.object({ model: z.string().trim().min(1).max(200).optional() }).strict();
export type AiAccountTest = z.infer<typeof AiAccountTestSchema>;

// ---- Models fetched from an account's provider ----------------------------------------------------------------------
export const AI_MODEL_KINDS = ['chat', 'embedding', 'other'] as const;
export type AiModelKind = (typeof AI_MODEL_KINDS)[number];
export const AiModelInfoSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  kind: z.enum(AI_MODEL_KINDS),
  supportsImages: z.boolean().optional(),
  /** Only when the provider's own list gives a price. */
  inputUsdPerMTok: z.number().optional(),
  outputUsdPerMTok: z.number().optional(),
});
export type AiModelInfo = z.infer<typeof AiModelInfoSchema>;
export const AiModelListSchema = z.object({
  models: z.array(AiModelInfoSchema),
  /** Why the list could not be fetched (the key is never in it); the screen then lets the person type a model id. */
  error: z.string().nullable(),
  cached: z.boolean(),
  fetchedAt: z.string().nullable(),
});
export type AiModelList = z.infer<typeof AiModelListSchema>;

// ---- Assignments and limits ---------------------------------------------------------------------------------------
export const AiRoleSettingSchema = z.object({ accountId: z.uuid().nullable(), model: z.string().nullable() });

/** Settings -> AI as the client sees it: which account and model does what, the reading options and the cap. No keys, no prices. */
export const AiSettingSchema = z.object({
  /** The global switch. */
  enabled: z.boolean(),
  analysis: AiRoleSettingSchema,
  /** Reading / vision (aiOcr). `accountId` and `model` null: the same as analysis. */
  reading: AiRoleSettingSchema.extend({
    ocrEnabled: z.boolean(),
    maxPages: z.number().int(),
    /** Null: Auto. Used for a source that has no language of its own. */
    language: z.string().nullable(),
  }),
  embeddings: AiRoleSettingSchema.extend({
    enabled: z.boolean(),
    /** Found by a probe call when the assignment is saved or tested; never typed. */
    dimension: z.number().int().nullable(),
  }),
  /**
   * The in-app assistant (DEC-027). `accountId` and `model` null: the same as analysis. `enabled` is the administrator's switch
   * for the assistant alone (AI as a whole is `enabled` above). `maxTokensPerTurn` caps what one reply may spend.
   */
  assistant: AiRoleSettingSchema.extend({
    enabled: z.boolean(),
    maxTokensPerTurn: z.number().int(),
  }),
  /** The cap on one analysis run. */
  cap: z.object({
    unit: z.enum(AI_CAP_UNITS),
    tokens: z.number().int().nullable(),
    usd: z.number().nullable(),
    /** USD can be chosen only when the analysis model's price is known from the provider's own list. */
    usdAvailable: z.boolean(),
  }),
  /** Check-and-recover rounds after the extraction of a framework analysis (0 switches them off). */
  maxRecoveryRounds: z.number().int(),
  /** What the server environment supplies when no account is assigned to analysis. */
  environment: z.object({ provider: z.enum(AI_PROVIDERS), model: z.string().nullable(), keyPresent: z.boolean() }),
});
export type AiSetting = z.infer<typeof AiSettingSchema>;

/** Check-and-recover rounds of a framework analysis: the default, and the most an administrator may set. */
export const DEFAULT_MAX_RECOVERY_ROUNDS = 2;
export const MAX_RECOVERY_ROUNDS_LIMIT = 5;

const modelField = z.string().trim().min(1).max(200).nullable();
/** Absent keeps; `accountId: null` clears the assignment. */
export const UpdateAiSettingSchema = z.object({
  enabled: z.boolean().optional(),
  analysis: z.object({ accountId: z.uuid().nullable().optional(), model: modelField.optional() }).strict().optional(),
  reading: z.object({
    accountId: z.uuid().nullable().optional(), model: modelField.optional(),
    ocrEnabled: z.boolean().optional(),
    maxPages: z.number().int().min(1).max(MAX_OCR_MAX_PAGES).optional(),
    language: z.string().trim().min(2).max(40).nullable().optional(),
  }).strict().optional(),
  embeddings: z.object({ enabled: z.boolean().optional(), accountId: z.uuid().nullable().optional(), model: modelField.optional() }).strict().optional(),
  assistant: z.object({
    enabled: z.boolean().optional(), accountId: z.uuid().nullable().optional(), model: modelField.optional(),
    maxTokensPerTurn: z.number().int().min(1000).max(2_000_000_000).nullable().optional(),
  }).strict().optional(),
  cap: z.object({
    unit: z.enum(AI_CAP_UNITS).optional(),
    tokens: z.number().int().positive().max(2_000_000_000).nullable().optional(),
    usd: z.number().positive().max(1_000_000).nullable().optional(),
  }).strict().optional(),
  maxRecoveryRounds: z.number().int().min(0).max(MAX_RECOVERY_ROUNDS_LIMIT).optional(),
}).strict();
export type UpdateAiSetting = z.infer<typeof UpdateAiSettingSchema>;

export const AiTestRequestSchema = z.object({ role: z.enum(AI_ROLES).default('analysis') }).strict();
export type AiTestRequest = z.infer<typeof AiTestRequestSchema>;
export const AiTestResultSchema = z.object({
  ok: z.boolean(), role: z.enum(AI_ROLES).nullable(), model: z.string().nullable(), ms: z.number(), error: z.string().nullable(),
  /** Embeddings: the size of the vectors the model returned. */
  dimension: z.number().int().nullable(),
});
export type AiTestResult = z.infer<typeof AiTestResultSchema>;
