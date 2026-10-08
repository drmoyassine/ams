import type { LanguageModel } from 'ai';

export type FakeReply = string | object | Error | ((options: unknown) => string | object);

export interface FakeAiModel {
  model: LanguageModel;
  /** The options of every call made, in order. */
  calls: unknown[];
}

/**
 * A canned model for tests: each call takes the next reply (the last one repeats). Objects are returned as JSON, which
 * is what a structured-output call parses; an Error makes the call fail. Token counts are reported as given.
 */
export function createFakeAiModel(replies: FakeReply[], usage: { inputTokens?: number; outputTokens?: number } = {}): FakeAiModel {
  const calls: unknown[] = [];
  let n = 0;
  const input = usage.inputTokens ?? 10;
  const output = usage.outputTokens ?? 5;
  const model = {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate(options: unknown) {
      calls.push(options);
      let reply = replies[Math.min(n++, replies.length - 1)];
      if (reply === undefined) throw new Error('createFakeAiModel needs at least one reply');
      if (typeof reply === 'function') reply = reply(options);
      if (reply instanceof Error) throw reply;
      return {
        content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } },
        warnings: [],
      };
    },
    async doStream() { throw new Error('the fake model does not stream'); },
  };
  return { model: model as unknown as LanguageModel, calls };
}
