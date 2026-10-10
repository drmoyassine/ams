// createModel(): the only place a provider is chosen (DEC-012). Nothing reaches the network: fetch is replaced and the
// request each provider would send is inspected (address, key header, image part).
import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_PROVIDERS } from '@ams/shared';
import { AiNotConfiguredError } from './errors.js';
import { createModel } from './model.js';

interface Seen { url: string; headers: Record<string, string>; body: string }
let seen: Seen[];
const realFetch = globalThis.fetch;
beforeEach(() => {
  seen = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input instanceof Request ? input.url : input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ error: { message: 'stubbed' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const IMAGE = new Uint8Array([1, 2, 3, 4, 5, 6]);
const IMAGE_B64 = Buffer.from(IMAGE).toString('base64');
const send = (config: Parameters<typeof createModel>[0]) => generateText({
  model: createModel(config), temperature: 0, maxRetries: 0,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'read this page' }, { type: 'file', data: IMAGE, mediaType: 'image/png' }] }],
}).catch(() => undefined);

const cases = [
  { provider: 'anthropic', host: 'api.anthropic.com', header: 'x-api-key', baseUrl: null },
  { provider: 'openai', host: 'api.openai.com', header: 'authorization', baseUrl: null },
  { provider: 'google', host: 'generativelanguage.googleapis.com', header: 'x-goog-api-key', baseUrl: null },
  { provider: 'openai_compatible', host: 'llm.internal:11434', header: 'authorization', baseUrl: 'http://llm.internal:11434/v1' },
] as const;

describe('createModel', () => {
  it('covers every provider the settings accept', () => {
    expect(cases.map((c) => c.provider).sort()).toEqual([...AI_PROVIDERS].sort());
  });

  for (const c of cases) {
    it(`${c.provider}: calls its own endpoint with its own key and sends a page image as a file part`, async () => {
      await send({ provider: c.provider, model: 'any-model', apiKey: 'secret-key-1234', baseUrl: c.baseUrl });
      expect(seen).toHaveLength(1);
      expect(new URL(seen[0]!.url).host).toBe(c.host);
      expect(seen[0]!.headers[c.header]).toContain('secret-key-1234');
      expect(seen[0]!.body).toContain(IMAGE_B64);
    });
  }

  it('openai_compatible: goes to the Base URL (a path prefix is kept) and works without a key', async () => {
    await send({ provider: 'openai_compatible', model: 'local', apiKey: '', baseUrl: 'http://localhost:11434/v1' });
    expect(seen[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(seen[0]!.body).model).toBe('local');
  });

  it('openai_compatible needs a valid Base URL', () => {
    for (const baseUrl of [undefined, null, '', 'ftp://host/v1', 'not a url', 'http://u:p@host/v1']) {
      expect(() => createModel({ provider: 'openai_compatible', model: 'm', apiKey: '', baseUrl })).toThrow(AiNotConfiguredError);
    }
  });

  it('refuses an unknown provider with a typed error', () => {
    expect(() => createModel({ provider: 'nope', model: 'm', apiKey: 'k' })).toThrow(AiNotConfiguredError);
  });

  it('does not use a Base URL for the hosted providers', async () => {
    await send({ provider: 'openai', model: 'm', apiKey: 'k-12345678', baseUrl: 'http://evil.example/v1' });
    expect(new URL(seen[0]!.url).host).toBe('api.openai.com');
  });
});
