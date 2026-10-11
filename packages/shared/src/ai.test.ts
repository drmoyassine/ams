import { describe, expect, it } from 'vitest';
import {
  AI_EMBEDDING_PROVIDERS, AI_PROVIDERS, baseUrlProblem, CreateAiAccountSchema, OPENROUTER_BASE_URL, providerSupportsEmbeddings, UpdateAiAccountSchema, UpdateAiSettingSchema,
} from './ai.js';
import { aiEnvKey, aiKeyOptional, loadAiEnv } from './config.js';

const okAccount = (v: unknown) => CreateAiAccountSchema.safeParse(v).success;
const okUpdate = (v: unknown) => UpdateAiAccountSchema.safeParse(v).success;
const okSettings = (v: unknown) => UpdateAiSettingSchema.safeParse(v).success;

describe('AI providers', () => {
  it('lists anthropic, openai, google, openrouter and openai_compatible; only those with embedding models offer embeddings', () => {
    expect([...AI_PROVIDERS]).toEqual(['anthropic', 'openai', 'google', 'openrouter', 'openai_compatible']);
    for (const provider of AI_PROVIDERS) expect(okAccount(provider === 'openai_compatible' ? { provider, baseUrl: 'http://h/v1' } : { provider })).toBe(true);
    expect(okAccount({ provider: 'cohere' })).toBe(false);
    expect([...AI_EMBEDDING_PROVIDERS]).toEqual(['openai', 'google', 'openrouter', 'openai_compatible']);
    expect(AI_PROVIDERS.filter((p) => !providerSupportsEmbeddings(p))).toEqual(['anthropic']);
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });

  it('accepts an http(s) Base URL without credentials for openai_compatible', () => {
    expect(okAccount({ provider: 'openai_compatible', baseUrl: 'http://host:11434/v1' })).toBe(true);
    expect(okUpdate({ baseUrl: 'http://host:11434/v1' })).toBe(true); // checked against the saved provider by the service
  });

  it('refuses a bad Base URL: not a URL, wrong scheme, embedded credentials', () => {
    for (const baseUrl of ['host:11434', 'not a url', 'ftp://host/v1', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@host/v1', 'http://user@host/v1', '']) {
      expect(okAccount({ provider: 'openai_compatible', baseUrl }), baseUrl).toBe(false);
    }
    expect(baseUrlProblem('http://user:pw@host/v1')).toMatch(/user name or password/);
    expect(baseUrlProblem('ftp://host')).toMatch(/http/);
    expect(baseUrlProblem('https://host/v1')).toBeNull();
  });

  it('refuses a Base URL for the hosted providers (OpenRouter too: its address is built in), and a missing one for openai_compatible', () => {
    for (const provider of ['anthropic', 'openai', 'google', 'openrouter']) expect(okAccount({ provider, baseUrl: 'http://host/v1' }), provider).toBe(false);
    expect(okAccount({ provider: 'openai', baseUrl: null })).toBe(true);
    expect(okAccount({ provider: 'openai_compatible' })).toBe(false);
    expect(okUpdate({ provider: 'openrouter', baseUrl: 'http://host/v1' })).toBe(false);
  });

  it('keys: at least 8 characters, null removes (update only), unknown fields refused', () => {
    expect(okAccount({ provider: 'openai', apiKey: 'short' })).toBe(false);
    expect(okAccount({ provider: 'openai', apiKey: 'long-enough-key' })).toBe(true);
    expect(okUpdate({ apiKey: null })).toBe(true);
    expect(okAccount({ provider: 'openai', surprise: 1 })).toBe(false);
  });
});

describe('AI settings update', () => {
  it('has no price or per-field limit inputs any more; the cap is one unit and one value', () => {
    for (const old of [{ inputUsdPerMTok: 3 }, { outputUsdPerMTok: 15 }, { maxCostUsdPerRun: 2 }, { maxTokensPerRun: 10 }, { provider: 'openai' }, { apiKey: 'long-enough-key' }, { cap: { inputUsdPerMTok: 3 } }]) {
      expect(okSettings(old), JSON.stringify(old)).toBe(false);
    }
    expect(okSettings({ cap: { unit: 'tokens', tokens: 2_000_000 } })).toBe(true);
    expect(okSettings({ cap: { unit: 'usd', usd: 2.5 } })).toBe(true);
    expect(okSettings({ cap: { unit: 'words' } })).toBe(false);
    expect(okSettings({ cap: { tokens: 0 } })).toBe(false);
    expect(okSettings({ cap: { tokens: 3_000_000_000 } })).toBe(false); // the column is an integer
  });

  it('bounds the reading options and the recovery rounds', () => {
    expect(okSettings({ reading: { ocrEnabled: false, maxPages: 200, language: 'ar' } })).toBe(true);
    for (const maxPages of [0, 5001, 1.5]) expect(okSettings({ reading: { maxPages } }), String(maxPages)).toBe(false);
    for (const maxRecoveryRounds of [-1, 6, 1.5]) expect(okSettings({ maxRecoveryRounds }), String(maxRecoveryRounds)).toBe(false);
    expect(okSettings({ analysis: { accountId: 'not-a-uuid' } })).toBe(false);
    expect(okSettings({ analysis: { accountId: null, model: null } })).toBe(true);
    expect(okSettings({ embeddings: { enabled: true, dimension: 1536 } })).toBe(false); // the size is detected, never typed
  });
});

describe('AI environment', () => {
  it('reads the key of the chosen provider only', () => {
    const env = loadAiEnv({ AI_PROVIDER: 'google', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GOOGLE_GENERATIVE_AI_API_KEY: 'g', OPENAI_COMPATIBLE_API_KEY: 'c', OPENROUTER_API_KEY: 'r' });
    expect(aiEnvKey(env, 'anthropic')).toBe('a');
    expect(aiEnvKey(env, 'openai')).toBe('o');
    expect(aiEnvKey(env, 'google')).toBe('g');
    expect(aiEnvKey(env, 'openrouter')).toBe('r');
    expect(aiEnvKey(env, 'openai_compatible')).toBe('c');
    expect(aiEnvKey(loadAiEnv({ AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a' }), 'openai')).toBeUndefined();
  });
  it('defaults to anthropic, accepts every provider, rejects others; only openai_compatible may go without a key', () => {
    expect(loadAiEnv({}).AI_PROVIDER).toBe('anthropic');
    for (const p of AI_PROVIDERS) expect(loadAiEnv({ AI_PROVIDER: p }).AI_PROVIDER).toBe(p);
    expect(() => loadAiEnv({ AI_PROVIDER: 'cohere' })).toThrow();
    expect(AI_PROVIDERS.filter(aiKeyOptional)).toEqual(['openai_compatible']);
  });
});
