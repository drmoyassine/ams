// aiAgent (DEC-027): the multi-step tool loop of the assistant. No database, no network: a fake model that asks for tools.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AiBudget, AiScopeError, TOOL_DATA_LABEL, aiAgent, createAiRuntime, createFakeAiModel, fakeToolCalls, runInAiScope, setAiModelForTests, toolResultForModel, type AgentTool,
} from './index.js';

const runtime = (maxTokens?: number) => createAiRuntime({ provider: 'test', model: 'test', apiKey: '' }, new AiBudget(maxTokens ? { maxTokens } : {}));
const echo: AgentTool = {
  name: 'echo', description: 'Echoes', inputSchema: z.object({ text: z.string() }),
  execute: async (args) => ({ data: { said: (args as { text: string }).text }, summary: 'echoed', links: [] }),
};
const inJob = <T,>(fn: () => Promise<T>) => runInAiScope('job', fn);
const base = { task: 'assistant', promptVersion: 'v1', messages: [{ role: 'user' as const, content: 'hi' }], maxSteps: 5 };

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
afterEach(() => { setAiModelForTests(null); vi.restoreAllMocks(); });

describe('aiAgent', () => {
  it('runs the tools the model asks for, then returns its answer; every step is logged and reported', async () => {
    const fake = createFakeAiModel([fakeToolCalls([{ name: 'echo', input: { text: 'one' } }, { name: 'echo', input: { text: 'two' } }]), 'All done.'], { inputTokens: 100, outputTokens: 20 });
    setAiModelForTests(fake.model);
    const rt = runtime();
    const seen: number[] = [];
    const r = await inJob(() => aiAgent({ ...base, tools: [echo], runtime: rt, onStep: async (s) => { seen.push(s.results.length); } }));
    expect(r.text).toBe('All done.');
    expect(r.stopped).toBe('done');
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]!.calls.map((c) => c.name)).toEqual(['echo', 'echo']);
    expect(r.steps[0]!.results.map((x) => x.output.summary)).toEqual(['echoed', 'echoed']);
    expect(seen).toEqual([2, 0]);
    // Two model calls, logged with the task and prompt version, counted in the budget; temperature 0.
    expect(rt.calls).toHaveLength(2);
    expect(rt.calls[0]).toMatchObject({ task: 'assistant', promptVersion: 'v1', inputTokens: 100, outputTokens: 20, ok: true });
    expect(rt.budget.totalTokens).toBe(240);
    expect((fake.calls[0] as { temperature?: number }).temperature).toBe(0);
  });

  it('gives tool results to the model as labelled, size-capped DATA', async () => {
    const big: AgentTool = { ...echo, name: 'big', execute: async () => ({ data: { text: 'x'.repeat(5000) }, summary: 'big', links: [] }) };
    const fake = createFakeAiModel([fakeToolCalls([{ name: 'big', input: { text: 'a' } }]), 'ok']);
    setAiModelForTests(fake.model);
    await inJob(() => aiAgent({ ...base, tools: [big], runtime: runtime(), maxToolResultChars: 400 }));
    const second = JSON.stringify((fake.calls[1] as { prompt: unknown }).prompt);
    expect(second).toContain(TOOL_DATA_LABEL);
    expect(second).toContain('not instructions');
    expect(second).toContain('truncated');
    expect(second.length).toBeLessThan(5000);
    expect(toolResultForModel('t', { data: { a: 1 }, summary: 's' })).toMatchObject({ [TOOL_DATA_LABEL]: true, tool: 't', result: { a: 1 }, refused: false });
  });

  it('a tool that throws becomes data for the model, not a crash', async () => {
    const boom: AgentTool = { ...echo, name: 'boom', execute: async () => { throw new Error('disk on fire'); } };
    setAiModelForTests(createFakeAiModel([fakeToolCalls([{ name: 'boom', input: { text: 'a' } }]), 'I could not look that up.']).model);
    const r = await inJob(() => aiAgent({ ...base, tools: [boom], runtime: runtime() }));
    expect(r.text).toBe('I could not look that up.');
    expect(r.steps[0]!.results[0]!.output.data).toMatchObject({ error: 'the tool failed' });
  });

  it('stops at the step limit and says it did not finish', async () => {
    setAiModelForTests(createFakeAiModel([fakeToolCalls([{ name: 'echo', input: { text: 'again' } }])]).model);
    const r = await inJob(() => aiAgent({ ...base, tools: [echo], runtime: runtime(), maxSteps: 3 }));
    expect(r.stopped).toBe('max_steps');
    expect(r.steps).toHaveLength(3);
    expect(r.text).toBe('');
  });

  it('stops when the turn\'s token budget is spent, after the step that spent it', async () => {
    const fake = createFakeAiModel([fakeToolCalls([{ name: 'echo', input: { text: 'again' } }])], { inputTokens: 3000, outputTokens: 0 });
    setAiModelForTests(fake.model);
    const rt = runtime(6000);
    const r = await inJob(() => aiAgent({ ...base, tools: [echo], runtime: rt }));
    expect(r.stopped).toBe('budget');
    expect(r.steps).toHaveLength(2);
    expect(fake.calls).toHaveLength(2);
    expect(rt.budget.totalTokens).toBe(6000);
  });

  it('refuses to start when even the prompt does not fit the budget (nothing is sent)', async () => {
    const fake = createFakeAiModel(['never']);
    setAiModelForTests(fake.model);
    const rt = runtime(20);
    await expect(inJob(() => aiAgent({ ...base, tools: [echo], runtime: rt }))).rejects.toThrow(/token budget/);
    expect(fake.calls).toHaveLength(0);
    expect(rt.calls[0]).toMatchObject({ ok: false });
  });

  it('ends early, keeping what it has, when asked to stop between steps', async () => {
    setAiModelForTests(createFakeAiModel([fakeToolCalls([{ name: 'echo', input: { text: 'again' } }])]).model);
    let asked = 0;
    const r = await inJob(() => aiAgent({ ...base, tools: [echo], runtime: runtime(), shouldStop: async () => { asked += 1; return true; } }));
    expect(r.stopped).toBe('cancelled');
    expect(r.steps).toHaveLength(1);
    expect(asked).toBeGreaterThan(0);
  });

  it('turns a provider failure into a typed error without the key', async () => {
    setAiModelForTests(createFakeAiModel([new Error('401 bad key sk-live-secret')]).model);
    const rt = createAiRuntime({ provider: 'test', model: 'test', apiKey: 'sk-live-secret' }, new AiBudget());
    const err = await inJob(() => aiAgent({ ...base, tools: [echo], runtime: rt })).catch((e: Error) => e);
    expect(err).toMatchObject({ name: 'AiCallError' });
    expect((err as Error).message).not.toContain('sk-live-secret');
    expect(rt.calls.at(-1)).toMatchObject({ ok: false });
  });

  it('runs only inside a worker job', async () => {
    setAiModelForTests(createFakeAiModel(['x']).model);
    await expect(aiAgent({ ...base, tools: [], runtime: runtime() })).rejects.toThrow(AiScopeError);
  });
});
