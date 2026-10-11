import type { EmbeddingModel, LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { AI_PROVIDERS, baseUrlProblem, OPENROUTER_BASE_URL } from '@ams/shared';
import { AiNotConfiguredError } from './errors.js';

/** What the model is called with: from an account in Settings -> AI, else from the environment. */
export interface AiConfig {
  provider: string;
  model: string;
  /** Empty for a provider that needs none (a local OpenAI-compatible server). */
  apiKey: string;
  /** The server address; used by `openai_compatible` only (OpenRouter has a fixed one). */
  baseUrl?: string | null;
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
    case 'openai':
      return createOpenAI({ apiKey: config.apiKey })(config.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model);
    case 'openrouter':
      // OpenRouter speaks the OpenAI API at a fixed address, so it goes through the same package with a preset Base URL.
      return createOpenAICompatible({ name: 'openrouter', baseURL: OPENROUTER_BASE_URL, supportsStructuredOutputs: true, ...(config.apiKey ? { apiKey: config.apiKey } : {}) })
        .chatModel(config.model);
    case 'openai_compatible': {
      const problem = config.baseUrl ? baseUrlProblem(config.baseUrl) : 'the OpenAI-compatible provider needs a Base URL';
      if (problem) throw new AiNotConfiguredError(`AI Base URL: ${problem}`);
      // json_schema output: without it the schema would not reach the model and extraction would fail.
      return createOpenAICompatible({ name: 'openai-compatible', baseURL: config.baseUrl!, supportsStructuredOutputs: true, ...(config.apiKey ? { apiKey: config.apiKey } : {}) })
        .chatModel(config.model);
    }
    default:
      throw new AiNotConfiguredError(`AI provider "${config.provider}" is not supported (use one of: ${AI_PROVIDERS.join(', ')})`);
  }
}

/** OpenAI's address for the OpenAI-style embeddings API (the same package as the compatible servers). */
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * The embedding model of one account (DEC-023, DEC-025). OpenAI, OpenRouter and any compatible server use the OpenAI-style
 * /embeddings API through the openai-compatible package; Google uses its own embedding model. Anthropic has none.
 */
export interface EmbedConfig {
  provider: string;
  /** Only for `openai_compatible`. */
  baseUrl?: string | null;
  model: string;
  apiKey: string;
  /** The size of the stored vectors; 0 while it is still being detected by a probe call. */
  dimension: number;
}

export type TestEmbedder = (texts: string[], config: EmbedConfig) => { vectors: number[][]; tokens?: number } | Promise<{ vectors: number[][]; tokens?: number }>;
let embedOverride: TestEmbedder | null = null;
/** Tests replace the embedding endpoint with a deterministic function (see createFakeEmbedder). */
export function setEmbedderForTests(fn: TestEmbedder | null): void { embedOverride = fn; }
export const getTestEmbedder = () => embedOverride;

export function createEmbeddingModel(config: EmbedConfig): EmbeddingModel {
  const key = config.apiKey ? { apiKey: config.apiKey } : {};
  switch (config.provider) {
    case 'openai':
      return createOpenAICompatible({ name: 'openai', baseURL: OPENAI_BASE_URL, ...key }).embeddingModel(config.model);
    case 'openrouter':
      return createOpenAICompatible({ name: 'openrouter', baseURL: OPENROUTER_BASE_URL, ...key }).embeddingModel(config.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: config.apiKey }).embeddingModel(config.model);
    case 'openai_compatible': {
      const problem = config.baseUrl ? baseUrlProblem(config.baseUrl) : 'the OpenAI-compatible provider needs a Base URL';
      if (problem) throw new AiNotConfiguredError(`AI Base URL: ${problem}`);
      return createOpenAICompatible({ name: 'embeddings', baseURL: config.baseUrl!, ...key }).embeddingModel(config.model);
    }
    default:
      throw new AiNotConfiguredError(`the provider "${config.provider}" has no embedding models`);
  }
}
