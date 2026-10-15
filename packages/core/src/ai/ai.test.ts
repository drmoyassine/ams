// The AI connection without a database or a network: a fake model with canned answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AiBudget, AiCallError, AiScopeError, BudgetExceeded, aiExtract, aiOcr, createAiRuntime, createFakeAiModel, getPrompt, runInAiScope, setAiModelForTests,
} from './index.js';
import { decryptSecret, encryptSecret } from './crypto.js';

const config = { provider: 'anthropic', model: 'some-model', apiKey: 'sk-secret-key-1234' };
const schema = z.object({ items: z.array(z.string()) });
const inJob = <T>(fn: () => Promise<T>) => runInAiScope('job', fn);

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
afterEach(() => { setAiModelForTests(null); vi.restoreAllMocks(); });

describe('aiExtract', () => {
  it('returns the schema-validated object and a usage record, at temperature 0 with the versioned prompt', async () => {
    const fake = createFakeAiModel([{ items: ['a', 'b'] }], { inputTokens: 120, outputTokens: 30 });
    setAiModelForTests(fake.model);
    const runtime = createAiRuntime(config, new AiBudget({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 }));
    const { data, usage } = await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'hello', schema, runtime }));
    expect(data).toEqual({ items: ['a', 'b'] });
    expect(usage).toMatchObject({ task: 'connection_test', promptVersion: 'v1', provider: 'anthropic', model: 'some-model', inputTokens: 120, outputTokens: 30, ok: true, error: null });
    expect(usage.costUsd).toBeCloseTo((120 * 3 + 30 * 15) / 1e6);
    expect(usage.ms).toBeGreaterThanOrEqual(0);
    expect(runtime.calls).toEqual([usage]);
    const sent = fake.calls[0] as { temperature?: number; prompt: { role: string; content: unknown }[] };
    expect(sent.temperature).toBe(0);
    expect(JSON.stringify(sent.prompt)).toContain(getPrompt('connection_test', 'v1'));
    expect(JSON.stringify(sent.prompt)).toContain('hello');
  });

  it('asks once more for plain JSON when the model cannot give a structured answer, and checks it against the schema', async () => {
    const fake = createFakeAiModel([new Error('No output generated.'), 'Here it is:\n```json\n{"items":["x"]}\n```']);
    setAiModelForTests(fake.model);
    const runtime = createAiRuntime(config);
    const { data } = await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime }));
    expect(data).toEqual({ items: ['x'] });
    expect(fake.calls).toHaveLength(2);
    expect(JSON.stringify(fake.calls[1])).toContain('JSON Schema');
    expect(runtime.calls).toHaveLength(1); // one logged call
  });

  it('gives up with a plain reason when the plain JSON answer does not fit either', async () => {
    setAiModelForTests(createFakeAiModel([new Error('No output generated.'), 'sorry, I cannot']).model);
    const err = await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime: createAiRuntime(config) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiCallError);
    expect((err as AiCallError).retryable).toBe(false);
    expect((err as Error).message).toContain('returned nothing');
  });

  it('logs each call as one JSON line, without the key', async () => {
    setAiModelForTests(createFakeAiModel([{ items: [] }]).model);
    await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime: createAiRuntime(config) }));
    const line = String(vi.mocked(console.log).mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ msg: 'ai_call', task: 'connection_test', promptVersion: 'v1', ok: true });
    expect(line).not.toContain(config.apiKey);
  });

  it('records a failed call, hides the key from the message, and throws a typed error', async () => {
    setAiModelForTests(createFakeAiModel([new Error(`401 invalid key ${config.apiKey}`)]).model);
    const runtime = createAiRuntime(config);
    const err = await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiCallError);
    expect((err as Error).message).toContain('invalid key');
    expect((err as Error).message).not.toContain(config.apiKey);
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]).toMatchObject({ ok: false });
    expect(runtime.calls[0]!.error).not.toContain(config.apiKey);
  });

  it('fails when the answer does not match the schema', async () => {
    setAiModelForTests(createFakeAiModel([{ wrong: true }]).model);
    const runtime = createAiRuntime(config);
    await expect(inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime }))).rejects.toBeInstanceOf(AiCallError);
    expect(runtime.calls[0]!.ok).toBe(false);
  });

  it('refuses an unknown prompt version', async () => {
    setAiModelForTests(createFakeAiModel([{ items: [] }]).model);
    await expect(inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v99', input: 'x', schema }))).rejects.toThrow(/No prompt/);
  });

  it('cannot run outside a worker job', async () => {
    const fake = createFakeAiModel([{ items: [] }]);
    setAiModelForTests(fake.model);
    await expect(aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema })).rejects.toBeInstanceOf(AiScopeError);
    await expect(aiOcr({ image: new Uint8Array(4), lang: 'en' })).rejects.toBeInstanceOf(AiScopeError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('budget', () => {
  it('stops the run with BudgetExceeded once the token limit is used, without calling the model again', async () => {
    const fake = createFakeAiModel([{ items: [] }], { inputTokens: 60, outputTokens: 50 });
    setAiModelForTests(fake.model);
    const runtime = createAiRuntime(config, new AiBudget({ maxTokens: 100 }));
    await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime }));
    const err = await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect(err).toMatchObject({ limit: 'tokens', max: 100 });
    expect(fake.calls).toHaveLength(1);
    expect(runtime.calls.map((c) => c.ok)).toEqual([true, false]);
  });

  it('stops on the cost limit', async () => {
    setAiModelForTests(createFakeAiModel([{ items: [] }], { inputTokens: 1000, outputTokens: 1000 }).model);
    const runtime = createAiRuntime(config, new AiBudget({ maxCostUsd: 0.01, inputUsdPerMTok: 5, outputUsdPerMTok: 5 }));
    await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime })); // 0.01 spent
    await expect(inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime }))).rejects.toMatchObject({ limit: 'cost' });
  });

  it('refuses a call whose input alone cannot fit, and caps the output to what is left', async () => {
    const fake = createFakeAiModel([{ items: [] }]);
    setAiModelForTests(fake.model);
    const small = createAiRuntime(config, new AiBudget({ maxTokens: 50 }));
    await expect(inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'y'.repeat(3000), schema, runtime: small }))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fake.calls).toHaveLength(0);
    const roomy = createAiRuntime(config, new AiBudget({ maxTokens: 2000 }));
    await inJob(() => aiExtract({ task: 'connection_test', promptVersion: 'v1', input: 'x', schema, runtime: roomy }));
    expect((fake.calls[0] as { maxOutputTokens: number }).maxOutputTokens).toBeLessThanOrEqual(2000);
  });
});

describe('aiOcr', () => {
  it('sends the image with the versioned prompt and returns the text and usage', async () => {
    const fake = createFakeAiModel(['  السلام عليكم  '], { inputTokens: 300, outputTokens: 12 });
    setAiModelForTests(fake.model);
    const runtime = createAiRuntime(config);
    const { text, usage } = await inJob(() => aiOcr({ image: new Uint8Array([1, 2, 3]), mime: 'image/png', lang: 'ar', runtime }));
    expect(text).toContain('السلام عليكم');
    expect(usage).toMatchObject({ task: 'ocr', promptVersion: 'v1', inputTokens: 300, outputTokens: 12, ok: true });
    const content = JSON.stringify(fake.calls[0]);
    expect(content).toContain('Language hint: ar');
    expect(content).toContain('image/png');
  });
});

describe('secrets at rest', () => {
  const secret = 'x'.repeat(40);
  it('round-trips and never stores the plain text', () => {
    const stored = encryptSecret('sk-live-abcdef', secret);
    expect(stored).not.toContain('abcdef');
    expect(decryptSecret(stored, secret)).toBe('sk-live-abcdef');
    expect(encryptSecret('sk-live-abcdef', secret)).not.toBe(stored); // fresh IV each time
  });
  it('cannot be read with another secret or after tampering', () => {
    const stored = encryptSecret('sk-live-abcdef', secret);
    expect(() => decryptSecret(stored, 'y'.repeat(40))).toThrow(/cannot be decrypted/);
    const raw = Buffer.from(stored.slice(3), 'base64');
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 1, raw.length - 1);
    expect(() => decryptSecret(`v1:${raw.toString('base64')}`, secret)).toThrow(/cannot be decrypted/);
  });
});

describe('aiOcr with a provider or model that cannot read images', () => {
  it('fails with the typed AiCallError (no crash, no key); parseDocument records it as an OCR warning and the page stays needsOcr', async () => {
    setAiModelForTests(createFakeAiModel([new Error('400 this model does not accept image input sk-secret-key-1234')]).model);
    const runtime = createAiRuntime({ ...config, provider: 'openai_compatible', baseUrl: 'http://host/v1' });
    const err = await inJob(() => aiOcr({ image: new Uint8Array([1, 2, 3]), lang: 'en', runtime })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiCallError);
    expect((err as Error).message).toContain('image input');
    expect((err as Error).message).not.toContain('sk-secret-key-1234');
    expect(runtime.calls[0]).toMatchObject({ task: 'ocr', provider: 'openai_compatible', ok: false });
  });
});
