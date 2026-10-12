// The `assistant` job: one conversation turn (DEC-027). It runs through runJob's identity-carrying transaction AS THE PERSON who
// sent the message (the job envelope carries their user id), so every tool checks that person's permissions through the same
// core services as the screens; the worker's database role can add and update only the assistant's own message.
//
// Progress: after each tool step the assistant message is updated in a SEPARATE committed transaction (ctx.detached), so the
// panel's polling shows "looked up 2 things" while the turn is still going. The final answer closes the message as `done`.
// A turn never throws for an expected problem (AI off, budget spent, provider error): it ends the message as `failed` with a
// plain reason, so the queue does not retry and the person sees why.
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { assistantConversation, assistantMessage } from '@ams/db';
import { ASSISTANT_MAX_STEPS, parseParts, type AssistantContext, type AssistantUsage, type MessagePart } from '@ams/shared';
import { AssistantContextSchema } from '@ams/shared';
import {
  AiCallError, AiDisabledError, AiNotConfiguredError, AssistantDisabledError, BudgetExceeded, aiAgent, type AgentStep,
} from '../ai/index.js';
import { loadAssistantRuntime } from '../ai/settings.js';
import type { JobHandler } from '../jobs/handlers.js';
import { describeContext } from './context.js';
import { memoryBlock, retrieveMemory } from './memory.js';
import { ASSISTANT_TOOLS, toAgentTools } from './tools/registry.js';
import type { ToolEnv } from './tools/types.js';

const PayloadSchema = z.object({ conversationId: z.uuid(), userMessageId: z.uuid(), assistantMessageId: z.uuid() });

/** At most this many characters of earlier conversation go back to the model. */
const HISTORY_CHARS = 16_000;
const HISTORY_MESSAGES = 24;

const textOf = (parts: MessagePart[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n').trim();

/** The plain sentence a person reads when a turn fails. Never contains a key or internals. */
function failureMessage(e: unknown): string {
  if (e instanceof AiDisabledError || e instanceof AssistantDisabledError || e instanceof AiNotConfiguredError) return e.message;
  if (e instanceof BudgetExceeded) return 'This answer reached its size limit before it could finish. Try a narrower question.';
  if (e instanceof AiCallError) return `The AI service did not answer: ${e.message.slice(0, 200)}`;
  return 'Something went wrong while answering. Try again.';
}

export const assistantJob: JobHandler = async (ctx, rawPayload) => {
  const payload = PayloadSchema.parse(rawPayload);
  const detached = ctx.detached;
  if (!detached) throw new Error('the assistant job needs a job context (ctx.detached)');

  // Row-level security limits all of this to the person's own conversation; a deleted conversation is simply gone.
  const [conv] = await ctx.tx.select().from(assistantConversation).where(eq(assistantConversation.id, payload.conversationId));
  const [asst] = await ctx.tx.select().from(assistantMessage).where(eq(assistantMessage.id, payload.assistantMessageId));
  const [userMsg] = await ctx.tx.select().from(assistantMessage).where(eq(assistantMessage.id, payload.userMessageId));
  if (!conv || !asst || !userMsg || asst.conversationId !== conv.id || userMsg.conversationId !== conv.id) return { skipped: 'gone' };
  if (asst.status !== 'queued' && asst.status !== 'running') return { skipped: asst.status };

  /** Saves progress in its own transaction. Returns false when the person has stopped the turn meanwhile. */
  const save = (patch: { parts?: MessagePart[]; status?: 'running' | 'done' | 'failed'; error?: string | null; usage?: AssistantUsage }) =>
    detached(async (d) => {
      const rows = await d.tx.update(assistantMessage).set({
        ...(patch.parts ? { parts: patch.parts } : {}), ...(patch.status ? { status: patch.status } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}), ...(patch.usage ? { usage: patch.usage } : {}),
      }).where(and(eq(assistantMessage.id, payload.assistantMessageId), eq(assistantMessage.role, 'assistant'), inArray(assistantMessage.status, ['queued', 'running'])))
        .returning({ id: assistantMessage.id, status: assistantMessage.status });
      return rows.length > 0;
    });
  const isCancelled = () => detached(async (d) => {
    const [m] = await d.tx.select({ status: assistantMessage.status }).from(assistantMessage).where(eq(assistantMessage.id, payload.assistantMessageId));
    return !m || m.status === 'cancelled';
  });

  await save({ status: 'running', parts: [] });
  const parts: MessagePart[] = [];
  const startedAt = Date.now();
  try {
    const runtime = await loadAssistantRuntime(ctx);
    const contextParsed = AssistantContextSchema.safeParse(userMsg.context);
    const context: AssistantContext | null = contextParsed.success ? contextParsed.data : null;
    const question = textOf(parseParts(userMsg.parts));

    // Earlier turns of this conversation (their text only), newest last, within a size cap.
    const earlier = await ctx.tx.select().from(assistantMessage).where(and(eq(assistantMessage.conversationId, conv.id), lt(assistantMessage.createdAt, userMsg.createdAt)))
      .orderBy(asc(assistantMessage.createdAt), asc(assistantMessage.id));
    let budget = HISTORY_CHARS;
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of earlier.slice(-HISTORY_MESSAGES).reverse()) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const content = textOf(parseParts(m.parts));
      if (!content || budget - content.length < 0) continue;
      budget -= content.length;
      history.unshift({ role: m.role, content });
    }

    const memory = await retrieveMemory(ctx, { context, query: question });
    const dataBlock = [await describeContext(ctx, context), '', memoryBlock(memory)].join('\n');

    const pending: MessagePart[] = [];
    const env: ToolEnv = {
      context, conversationId: conv.id, messageId: asst.id, seenText: [], seenProposals: [],
      emit: (p) => { pending.push(p); },
    };
    const byName = new Map(ASSISTANT_TOOLS.map((t) => [t.name, t]));
    const onStep = async (step: AgentStep) => {
      for (const c of step.calls) {
        const result = step.results.find((r) => r.id === c.id);
        const tool = byName.get(c.name);
        const parsed = tool?.input.safeParse(c.input);
        // The call part keeps the model's own call id, which its result names in `callId`.
        parts.push({ id: c.id, type: 'tool_call', name: c.name, summary: tool && parsed?.success ? tool.describeArgs(parsed.data as never) : c.name });
        if (result) {
          parts.push({
            id: crypto.randomUUID(), type: 'tool_result', callId: c.id, name: c.name, summary: result.output.summary,
            links: (result.output.links ?? []) as never, ...(result.output.refused ? { refused: true } : {}),
          });
        }
      }
      parts.push(...pending.splice(0));
      await save({ parts: [...parts] });
    };

    const result = await aiAgent({
      task: 'assistant', promptVersion: 'v1', context: dataBlock, messages: [...history, { role: 'user', content: question }],
      tools: toAgentTools(ctx, env), runtime, maxSteps: ASSISTANT_MAX_STEPS, onStep, shouldStop: isCancelled,
    });

    let answer = result.text.trim();
    if (result.stopped === 'budget') answer = `${answer}${answer ? '\n\n' : ''}I stopped here because this answer reached its size limit. Ask me to continue, or narrow the question.`;
    else if (result.stopped === 'max_steps') answer = `${answer}${answer ? '\n\n' : ''}I stopped here after looking things up several times. Ask me to continue, or narrow the question.`;
    else if (!answer && result.stopped === 'done') answer = 'I could not put an answer together. Could you rephrase the question?';
    if (answer) parts.push({ id: crypto.randomUUID(), type: 'text', text: answer });
    const calls = runtime.calls.filter((c) => c.ok);
    const usage: AssistantUsage = {
      inputTokens: runtime.budget.inputTokens, outputTokens: runtime.budget.outputTokens, costUsd: runtime.budget.limits.inputUsdPerMTok != null ? runtime.budget.costUsd : null,
      calls: calls.length, model: runtime.config.model,
    };
    if (result.stopped !== 'cancelled') await save({ parts, status: 'done', usage, error: null });
    return { status: result.stopped === 'cancelled' ? 'cancelled' : 'done', stopped: result.stopped, steps: result.steps.length, usage, ms: Date.now() - startedAt, ai: runtime.calls };
  } catch (e) {
    const message = failureMessage(e);
    if (!(e instanceof AiDisabledError || e instanceof AssistantDisabledError || e instanceof AiNotConfiguredError || e instanceof BudgetExceeded || e instanceof AiCallError)) {
      console.error(JSON.stringify({ level: 'error', msg: 'assistant turn failed', err: e instanceof Error ? e.message : String(e) }));
    }
    await save({ parts, status: 'failed', error: message }).catch(() => undefined);
    return { status: 'failed', error: message };
  }
};
