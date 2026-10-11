// The model list of an account's provider: normalised from small recorded payloads, classified, cached. No network: fetch is stubbed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyModelId, clearModelCache, listProviderModels, ModelListError, MODEL_CACHE_MS } from './models.js';

interface Seen { url: string; headers: Record<string, string> }
let seen: Seen[];
let replies: Record<string, { status?: number; body: unknown }>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  seen = []; replies = {}; clearModelCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const hit = Object.entries(replies).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(hit[1].body), { status: hit[1].status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('classifyModelId (when the provider says nothing else)', () => {
  it('finds embedding models and the families that are not chat', () => {
    expect(classifyModelId('text-embedding-3-small')).toBe('embedding');
    expect(classifyModelId('bge-m3-embed')).toBe('embedding');
    for (const id of ['whisper-1', 'tts-1-hd', 'dall-e-3', 'omni-moderation-latest', 'gpt-4o-mini-transcribe', 'gpt-realtime', 'gpt-image-1', 'gpt-4o-audio-preview', 'davinci-002']) {
      expect(classifyModelId(id), id).toBe('other');
    }
    for (const id of ['gpt-4o', 'llama3.1:8b', 'mistral-large', 'qwen2.5-coder']) expect(classifyModelId(id), id).toBe('chat');
  });
});

describe('Anthropic', () => {
  it('lists chat models with their display names and image support, using x-api-key', async () => {
    replies['https://api.anthropic.com/v1/models'] = { body: { data: [
      { type: 'model', id: 'claude-b', display_name: 'Claude B', capabilities: { image_input: { supported: true } } },
      { type: 'model', id: 'claude-a', display_name: 'Claude A' },
    ] } };
    const r = await listProviderModels({ provider: 'anthropic', apiKey: 'ak-123456789' });
    expect(r.models).toEqual([{ id: 'claude-a', name: 'Claude A', kind: 'chat' }, { id: 'claude-b', name: 'Claude B', kind: 'chat', supportsImages: true }]);
    expect(seen[0]!.headers['x-api-key']).toBe('ak-123456789');
    expect(seen[0]!.headers['anthropic-version']).toBeTruthy();
  });
});

describe('OpenAI', () => {
  it('lists models with the kind guessed from the id, using a bearer key', async () => {
    replies['https://api.openai.com/v1/models'] = { body: { object: 'list', data: [{ id: 'gpt-x' }, { id: 'text-embedding-9' }, { id: 'whisper-1' }, { id: 'gpt-x' }] } };
    const r = await listProviderModels({ provider: 'openai', apiKey: 'sk-openai-1234' });
    expect(r.models).toEqual([{ id: 'gpt-x', kind: 'chat' }, { id: 'text-embedding-9', kind: 'embedding' }, { id: 'whisper-1', kind: 'other' }]);
    expect(seen[0]!.headers.authorization).toBe('Bearer sk-openai-1234');
  });
});

describe('Google', () => {
  it('uses the supported generation methods, strips the models/ prefix, follows pages, and sends the key in a header', async () => {
    replies['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=p2'] = { body: { models: [
      { name: 'models/gem-embed', displayName: 'Gem Embed', supportedGenerationMethods: ['embedContent'] },
    ] } };
    replies['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'] = { body: { nextPageToken: 'p2', models: [
      { name: 'models/gemini-chat', displayName: 'Gemini Chat', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/aqa', displayName: 'AQA', supportedGenerationMethods: ['generateAnswer'] },
    ] } };
    const r = await listProviderModels({ provider: 'google', apiKey: 'g-key-123456' });
    expect(r.models).toEqual([
      { id: 'aqa', name: 'AQA', kind: 'other' },
      { id: 'gem-embed', name: 'Gem Embed', kind: 'embedding' },
      { id: 'gemini-chat', name: 'Gemini Chat', kind: 'chat', supportsImages: true },
    ]);
    expect(seen.every((s) => s.headers['x-goog-api-key'] === 'g-key-123456' && !s.url.includes('g-key-123456'))).toBe(true);
  });
});

describe('OpenRouter', () => {
  it('reads modalities and prices (per token -> per million), merges the embeddings list, and works with the fixed address', async () => {
    replies['https://openrouter.ai/api/v1/models'] = { body: { data: [
      { id: 'vendor/chat-1', name: 'Vendor: Chat 1', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '0.000003', completion: '0.000015' } },
      { id: 'vendor/free', name: 'Free', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
      { id: 'vendor/dynamic', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '-1', completion: '-1' } },
      { id: 'vendor/imagegen', architecture: { input_modalities: ['text'], output_modalities: ['image'] }, pricing: { prompt: '0.00001', completion: '0' } },
    ] } };
    replies['https://openrouter.ai/api/v1/embeddings/models'] = { body: { data: [{ id: 'vendor/emb-1', name: 'Emb 1', pricing: { prompt: '0.0000001', completion: '0' } }] } };
    const r = await listProviderModels({ provider: 'openrouter', apiKey: 'or-key-12345678' });
    expect(r.models).toEqual([
      { id: 'vendor/chat-1', name: 'Vendor: Chat 1', kind: 'chat', supportsImages: true, inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
      { id: 'vendor/dynamic', kind: 'chat', supportsImages: false },
      { id: 'vendor/emb-1', name: 'Emb 1', kind: 'embedding', inputUsdPerMTok: 0.1, outputUsdPerMTok: 0 },
      { id: 'vendor/free', name: 'Free', kind: 'chat', supportsImages: false, inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
      { id: 'vendor/imagegen', kind: 'other', supportsImages: false, inputUsdPerMTok: 10, outputUsdPerMTok: 0 },
    ]);
  });

  it('still lists chat models when the embeddings list is unavailable', async () => {
    replies['https://openrouter.ai/api/v1/models'] = { body: { data: [{ id: 'vendor/chat-1' }] } };
    replies['https://openrouter.ai/api/v1/embeddings/models'] = { status: 404, body: {} };
    expect((await listProviderModels({ provider: 'openrouter', apiKey: 'k' })).models.map((m) => m.id)).toEqual(['vendor/chat-1']);
  });
});

describe('OpenAI-compatible', () => {
  it('asks {Base URL}/models, sends the key only when there is one, and reads a data or models array', async () => {
    replies['http://llm.internal:11434/v1/models'] = { body: { data: [{ id: 'llama3.1:8b' }, { id: 'nomic-embed-text' }] } };
    const r = await listProviderModels({ provider: 'openai_compatible', baseUrl: 'http://llm.internal:11434/v1/', apiKey: '' });
    expect(r.models).toEqual([{ id: 'llama3.1:8b', kind: 'chat' }, { id: 'nomic-embed-text', kind: 'embedding' }]);
    expect(seen[0]!.url).toBe('http://llm.internal:11434/v1/models');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    replies['http://other/v1/models'] = { body: { models: [{ model: 'x-1' }] } };
    expect((await listProviderModels({ provider: 'openai_compatible', baseUrl: 'http://other/v1', apiKey: 'k' })).models).toEqual([{ id: 'x-1', kind: 'chat' }]);
  });
});

describe('failures', () => {
  it('say what went wrong without the key', async () => {
    replies['https://api.openai.com/v1/models'] = { status: 401, body: { error: { message: 'bad key sk-secret-9999' } } };
    const err = await listProviderModels({ provider: 'openai', apiKey: 'sk-secret-9999' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelListError);
    expect((err as Error).message).toMatch(/did not accept the key \(HTTP 401\)/);
    expect((err as Error).message).not.toContain('sk-secret-9999');
    const net = await listProviderModels({ provider: 'openai_compatible', baseUrl: 'http://nowhere.invalid/v1', apiKey: 'sk-secret-9999' }).catch((e: unknown) => e);
    expect((net as Error).message).toMatch(/could not reach nowhere\.invalid/);
    replies['http://odd/v1/models'] = { status: 404, body: {} };
    await expect(listProviderModels({ provider: 'openai_compatible', baseUrl: 'http://odd/v1', apiKey: '' })).rejects.toThrow(/Base URL/);
    await expect(listProviderModels({ provider: 'openai_compatible', apiKey: '' })).rejects.toThrow(/no Base URL/);
  });
});

describe('cache', () => {
  it('reuses a list for ten minutes per account, refreshes on request, and starts again when the account changes', async () => {
    replies['https://api.openai.com/v1/models'] = { body: { data: [{ id: 'a' }] } };
    const src = { provider: 'openai', apiKey: 'k-12345678' } as const;
    const first = await listProviderModels(src, { cacheKey: 'acc1|1' });
    expect(first.cached).toBe(false);
    expect((await listProviderModels(src, { cacheKey: 'acc1|1' })).cached).toBe(true);
    expect(seen).toHaveLength(1);
    replies['https://api.openai.com/v1/models'] = { body: { data: [{ id: 'a' }, { id: 'b' }] } };
    expect((await listProviderModels(src, { cacheKey: 'acc1|1' })).models).toHaveLength(1);
    expect((await listProviderModels(src, { cacheKey: 'acc1|1', refresh: true })).models).toHaveLength(2);
    expect((await listProviderModels(src, { cacheKey: 'acc1|2' })).cached).toBe(false); // the account was edited
    expect((await listProviderModels(src, { cacheKey: 'acc2|1' })).cached).toBe(false); // another account
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + MODEL_CACHE_MS + 1000;
      expect((await listProviderModels(src, { cacheKey: 'acc1|1' })).cached).toBe(false); // expired
    } finally { Date.now = realNow; }
  });
});
