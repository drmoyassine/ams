import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, baseUrlProblem, UpdateAiSettingSchema } from './ai.js';
import { aiEnvKey, aiKeyOptional, loadAiEnv } from './config.js';

const ok = (v: unknown) => UpdateAiSettingSchema.safeParse(v).success;

describe('AI providers', () => {
  it('lists anthropic, openai, google and openai_compatible', () => {
    expect([...AI_PROVIDERS]).toEqual(['anthropic', 'openai', 'google', 'openai_compatible']);
    for (const provider of AI_PROVIDERS) expect(ok({ provider })).toBe(true);
    expect(ok({ provider: 'cohere' })).toBe(false);
  });

  it('accepts an http(s) Base URL without credentials for openai_compatible', () => {
    expect(ok({ provider: 'openai_compatible', baseUrl: 'http://host:11434/v1' })).toBe(true);
    expect(ok({ provider: 'openai_compatible', baseUrl: 'https://openrouter.ai/api/v1' })).toBe(true);
    expect(ok({ baseUrl: 'http://host:11434/v1' })).toBe(true); // checked against the saved provider by the service
  });

  it('refuses a bad Base URL: not a URL, wrong scheme, embedded credentials', () => {
    for (const baseUrl of ['host:11434', 'not a url', 'ftp://host/v1', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@host/v1', 'http://user@host/v1', '']) {
      expect(ok({ provider: 'openai_compatible', baseUrl }), baseUrl).toBe(false);
    }
    expect(baseUrlProblem('http://user:pw@host/v1')).toMatch(/user name or password/);
    expect(baseUrlProblem('ftp://host')).toMatch(/http/);
    expect(baseUrlProblem('https://host/v1')).toBeNull();
  });

  it('refuses a Base URL for the hosted providers, and a missing one for openai_compatible in the same save', () => {
    for (const provider of ['anthropic', 'openai', 'google']) expect(ok({ provider, baseUrl: 'http://host/v1' })).toBe(false);
    expect(ok({ provider: 'openai', baseUrl: null })).toBe(true);
    expect(ok({ provider: 'openai_compatible', baseUrl: null })).toBe(false);
  });
});

describe('AI environment', () => {
  it('reads the key of the chosen provider only', () => {
    const env = loadAiEnv({ AI_PROVIDER: 'google', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GOOGLE_GENERATIVE_AI_API_KEY: 'g', OPENAI_COMPATIBLE_API_KEY: 'c' });
    expect(aiEnvKey(env, 'anthropic')).toBe('a');
    expect(aiEnvKey(env, 'openai')).toBe('o');
    expect(aiEnvKey(env, 'google')).toBe('g');
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
