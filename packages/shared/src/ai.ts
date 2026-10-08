import { z } from 'zod';

/** Providers the AI connection can use. Switching provider is configuration, not code (DEC-012); only one ships so far. */
export const AI_PROVIDERS = ['anthropic'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

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
  model: z.string().nullable(),
  keyConfigured: z.boolean(),
  keyLast4: z.string().nullable(),
  /** Where the key in use comes from: saved here, the server environment, or nowhere. */
  keySource: z.enum(['settings', 'environment', 'none']),
  maxTokensPerRun: z.number().int().nullable(),
  maxCostUsdPerRun: z.number().nullable(),
  inputUsdPerMTok: z.number().nullable(),
  outputUsdPerMTok: z.number().nullable(),
  enabled: z.boolean(),
  embeddings: EmbeddingSettingSchema,
});
export type AiSetting = z.infer<typeof AiSettingSchema>;

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
  model: z.string().trim().min(1).max(200).nullable().optional(),
  apiKey: z.string().trim().min(8).max(500).nullable().optional(),
  maxTokensPerRun: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  maxCostUsdPerRun: positive.nullable().optional(),
  inputUsdPerMTok: positive.nullable().optional(),
  outputUsdPerMTok: positive.nullable().optional(),
  enabled: z.boolean().optional(),
  embeddings: UpdateEmbeddingSettingSchema.optional(),
}).strict();
export type UpdateAiSetting = z.infer<typeof UpdateAiSettingSchema>;

export const AiTestResultSchema = z.object({
  ok: z.boolean(), model: z.string().nullable(), ms: z.number(), error: z.string().nullable(),
  /** Present when embeddings are switched on: the same check for the embedding endpoint. */
  embeddings: z.object({ ok: z.boolean(), model: z.string().nullable(), dimension: z.number().int().nullable(), ms: z.number(), error: z.string().nullable() }).nullable(),
});
export type AiTestResult = z.infer<typeof AiTestResultSchema>;
