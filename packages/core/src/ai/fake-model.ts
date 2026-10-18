import type { LanguageModel } from 'ai';

/** A scripted step that calls tools (see fakeToolCalls). */
export interface FakeToolCalls {
  __fakeToolCalls: { name: string; input: unknown }[];
  text?: string;
}

export interface FakeReasoning { __fakeReasoning: string; text?: string }
export type FakeReply = string | object | Error | FakeToolCalls | FakeReasoning | ((options: unknown) => string | object);
/** A reply whose answer is only in the model's reasoning (a thinking model that leaves the reply empty). */
export const fakeReasoning = (reasoning: string, text?: string): FakeReasoning => ({ __fakeReasoning: reasoning, ...(text ? { text } : {}) });

export interface FakeAiModel {
  model: LanguageModel;
  /** The options of every call made, in order (the `prompt` holds the messages the model was sent, tool results included). */
  calls: unknown[];
}

/** A reply in which the model asks for these tools to be run (optionally saying something first); the next reply follows their results. */
export const fakeToolCalls = (calls: { name: string; input: unknown }[], text?: string): FakeToolCalls => ({ __fakeToolCalls: calls, ...(text ? { text } : {}) });

const isToolCalls = (r: unknown): r is FakeToolCalls => typeof r === 'object' && r !== null && '__fakeToolCalls' in r;

/**
 * A canned model for tests: each call takes the next reply (the last one repeats). Objects are returned as JSON, which
 * is what a structured-output call parses; an Error makes the call fail; fakeToolCalls(...) asks for tools to be run (a
 * tool-calling step). Token counts are reported as given.
 */
export function createFakeAiModel(replies: FakeReply[], usage: { inputTokens?: number; outputTokens?: number } = {}): FakeAiModel {
  const calls: unknown[] = [];
  let n = 0;
  let toolCallNo = 0;
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
      if (isToolCalls(reply)) {
        return {
          content: [
            ...(reply.text ? [{ type: 'text', text: reply.text }] : []),
            ...reply.__fakeToolCalls.map((c) => ({ type: 'tool-call', toolCallId: `fake-call-${++toolCallNo}`, toolName: c.name, input: JSON.stringify(c.input) })),
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } },
          warnings: [],
        };
      }
      if (typeof reply === 'object' && reply !== null && '__fakeReasoning' in reply) {
        const rr = reply as FakeReasoning;
        return {
          content: [{ type: 'reasoning', text: rr.__fakeReasoning }, ...(rr.text ? [{ type: 'text', text: rr.text }] : [])],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } },
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } },
        warnings: [],
      };
    },
    // Streaming answers the same replies as one text chunk (tool calls are only used by the non-streaming assistant loop).
    async doStream(options: unknown) {
      const r = await model.doGenerate(options) as { content: { type: string; text?: string }[]; finishReason: unknown; usage: unknown };
      const text = r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      const reasoning = r.content.filter((c) => c.type === 'reasoning').map((c) => c.text ?? '').join('');
      const parts = [
        { type: 'stream-start', warnings: [] },
        ...(reasoning ? [{ type: 'reasoning-start', id: 'r1' }, { type: 'reasoning-delta', id: 'r1', delta: reasoning }, { type: 'reasoning-end', id: 'r1' }] : []),
        ...(text ? [{ type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: text }, { type: 'text-end', id: 't1' }] : []),
        { type: 'finish', finishReason: r.finishReason, usage: r.usage },
      ];
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
  return { model: model as unknown as LanguageModel, calls };
}
