import type { EmbeddingModel, LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { AiNotConfiguredError } from './errors.js';

/** What the model is called with: from Settings -> AI, else from the environment. */
export interface AiConfig {
  provider: string;
  model: string;
  apiKey: string;
}

type ModelFactory = (config: AiConfig) => LanguageModel;
let override: ModelFactory | null = null;

/**
 * Tests replace the provider with a fake so nothing reaches the network. Pass a model (see createFakeAiModel), a
 * factory, or null to restore the real provider.
 */
export function setAiModelForTests(model: LanguageModel | ModelFactory | null): void {
  override = model === null ? null : typeof model === 'function' ? model : () => model;
}
export const hasTestModel = () => override !== null;

/** The only place a provider is chosen. Switching provider is configuration (DEC-012). */
export function createModel(config: AiConfig): LanguageModel {
  if (override) return override(config);
  switch (config.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: config.apiKey })(config.model);
    default:
      throw new AiNotConfiguredError(`AI provider "${config.provider}" is not supported`);
  }
}

/** The embedding endpoint: any OpenAI-compatible server (hosted, or self-hosted such as Ollama or TEI), DEC-023. */
export interface EmbedConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimension: number;
}

export type TestEmbedder = (texts: string[], config: EmbedConfig) => { vectors: number[][]; tokens?: number } | Promise<{ vectors: number[][]; tokens?: number }>;
let embedOverride: TestEmbedder | null = null;
/** Tests replace the embedding endpoint with a deterministic function (see createFakeEmbedder). */
export function setEmbedderForTests(fn: TestEmbedder | null): void { embedOverride = fn; }
export const getTestEmbedder = () => embedOverride;

export function createEmbeddingModel(config: EmbedConfig): EmbeddingModel {
  return createOpenAICompatible({ name: 'embeddings', baseURL: config.baseUrl, ...(config.apiKey ? { apiKey: config.apiKey } : {}) }).embeddingModel(config.model);
}
