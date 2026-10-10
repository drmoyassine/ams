import { z } from 'zod';

/**
 * Providers the AI connection can use. Switching provider is configuration, not code (DEC-012).
 * `openai_compatible` is any server that speaks the OpenAI chat API at a Base URL: OpenRouter, Ollama, vLLM, LM Studio, Azure and the like.
 */
export const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'openai_compatible'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google (Gemini)', openai_compatible: 'OpenAI-compatible (custom Base URL)',
};

/** A provider-model Base URL: http(s), no embedded credentials (a key belongs in the key field). Returns an error message or null. */
export function baseUrlProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return 'the Base URL is not a valid URL, for example http://host:11434/v1'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'the Base URL must start with http:// or https://';
  if (url.username || url.password) return 'the Base URL must not contain a user name or password; put the key in the API key field';
  return null;
}

/** Settings -> AI as the client sees it. The key itself never leaves the server: only whether one is set and its last 4 characters. */
/** Embeddings (DEC-023): a separate OpenAI-compatible endpoint. Same rule for the key: only 'configured' and its last 4 characters. */
export const EmbeddingSettingSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  dimension: z.number().int().nullable(),
  keyConfigured: z.boolean(),
  keyLast4: z.string().nullable(),
});
export type EmbeddingSetting = z.infer<typeof EmbeddingSettingSchema>;

export const AiSettingSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  /** Only for `openai_compatible`; null for the other providers. */
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  keyConfigured: z.boolean(),
  keyLast4: z.string().nullable(),
  /** Where the key in use comes from: saved here, the server environment, or nowhere. */
  keySource: z.enum(['settings', 'environment', 'none']),
  maxTokensPerRun: z.number().int().nullable(),
  maxCostUsdPerRun: z.number().nullable(),
  inputUsdPerMTok: z.number().nullable(),
  outputUsdPerMTok: z.number().nullable(),
  /** Check-and-recover rounds after the extraction of a framework analysis (0 switches them off). */
  maxRecoveryRounds: z.number().int(),
  enabled: z.boolean(),
  embeddings: EmbeddingSettingSchema,
});
export type AiSetting = z.infer<typeof AiSettingSchema>;

/** Check-and-recover rounds of a framework analysis: the default, and the most an administrator may set. */
export const DEFAULT_MAX_RECOVERY_ROUNDS = 2;
export const MAX_RECOVERY_ROUNDS_LIMIT = 5;

const positive = z.number().positive().max(1_000_000_000);
export const UpdateEmbeddingSettingSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.url().max(500).nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  apiKey: z.string().trim().min(1).max(500).nullable().optional(),
  dimension: z.number().int().min(8).max(8192).nullable().optional(),
}).strict();

/** `apiKey`: a string replaces the saved key, `null` removes it, absent keeps it. */
export const UpdateAiSettingSchema = z.object({
  provider: z.enum(AI_PROVIDERS).optional(),
  /** Required for `openai_compatible` (checked against the saved provider too); refused for the others. */
  baseUrl: z.string().trim().min(1).max(500).refine((v) => baseUrlProblem(v) === null, { message: 'the Base URL must be an http(s) address without a user name or password' }).nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  apiKey: z.string().trim().min(8).max(500).nullable().optional(),
  maxTokensPerRun: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  maxCostUsdPerRun: positive.nullable().optional(),
  inputUsdPerMTok: positive.nullable().optional(),
  outputUsdPerMTok: positive.nullable().optional(),
  maxRecoveryRounds: z.number().int().min(0).max(MAX_RECOVERY_ROUNDS_LIMIT).optional(),
  enabled: z.boolean().optional(),
  embeddings: UpdateEmbeddingSettingSchema.optional(),
}).strict().superRefine((v, ctx) => {
  if (v.provider && v.provider !== 'openai_compatible' && v.baseUrl) {
    ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'a Base URL is only for the OpenAI-compatible provider' });
  }
  if (v.provider === 'openai_compatible' && v.baseUrl === null) {
    ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'the OpenAI-compatible provider needs a Base URL' });
  }
});
export type UpdateAiSetting = z.infer<typeof UpdateAiSettingSchema>;

export const AiTestResultSchema = z.object({
  ok: z.boolean(), model: z.string().nullable(), ms: z.number(), error: z.string().nullable(),
  /** Present when embeddings are switched on: the same check for the embedding endpoint. */
  embeddings: z.object({ ok: z.boolean(), model: z.string().nullable(), dimension: z.number().int().nullable(), ms: z.number(), error: z.string().nullable() }).nullable(),
});
export type AiTestResult = z.infer<typeof AiTestResultSchema>;
