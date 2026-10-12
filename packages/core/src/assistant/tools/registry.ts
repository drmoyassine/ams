// The registry: every tool the assistant has, by name, and how a tool run is made safe. Phase 1 = read tools over framework
// content + propose_memory. There is deliberately no tool for evidence, datasets, responses, requests, forms or letters, and no
// tool that writes standards (a test pins the list).
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { AgentTool, AgentToolOutput } from '../../ai/index.js';
import type { Ctx } from '../../ctx.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../ctx.js';
import { FRAMEWORK_TOOLS } from './framework-tools.js';
import { proposeMemoryTool } from './memory-tool.js';
import type { AssistantTool, ToolEnv, ToolOutput } from './types.js';

export const ASSISTANT_TOOLS: readonly AssistantTool[] = [...FRAMEWORK_TOOLS, proposeMemoryTool] as readonly AssistantTool[];
export const ASSISTANT_TOOL_NAMES: readonly string[] = ASSISTANT_TOOLS.map((t) => t.name);

/** Every string inside a value (a tool result), for the "never remember text from a document" check. */
export function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof value === 'string') { if (value.length >= 12) out.push(value); }
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  return out;
}

const refusal = (message: string, summary: string): ToolOutput => ({ refused: true, data: { refused: true, message }, summary, links: [] });

/**
 * Runs one tool call as the person: input checked against the tool's schema, inside a savepoint (a failing query cannot poison
 * the job's transaction), and every failure that means "you may not / it is not there" turned into a refusal the model can
 * report, never into data.
 */
export async function runAssistantTool(ctx: Ctx, tool: AssistantTool, rawArgs: unknown, env: ToolEnv): Promise<ToolOutput> {
  const parsed = tool.input.safeParse(rawArgs);
  if (!parsed.success) {
    return { data: { error: 'the arguments were not valid', issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) }, summary: `${tool.name}: invalid arguments`, links: [] };
  }
  await ctx.tx.execute(sql`savepoint assistant_tool`);
  try {
    const out = await tool.execute(ctx, parsed.data, env);
    await ctx.tx.execute(sql`release savepoint assistant_tool`);
    env.seenText.push(...collectStrings(out.data));
    return out;
  } catch (e) {
    await ctx.tx.execute(sql`rollback to savepoint assistant_tool`);
    if (e instanceof ForbiddenError) return refusal('You do not have permission to see this.', 'Not allowed to see that');
    if (e instanceof NotFoundError) return refusal('That does not exist, or you cannot see it.', 'Could not find that');
    if (e instanceof ValidationError || e instanceof ConflictError) return { data: { error: e.message }, summary: clipMessage(e.message), links: [] };
    if (e instanceof ZodError) return { data: { error: 'the data could not be read' }, summary: `${tool.name} failed`, links: [] };
    console.error(JSON.stringify({ level: 'error', msg: 'assistant tool failed', tool: tool.name, err: e instanceof Error ? e.message : String(e) }));
    return { data: { error: 'the lookup failed' }, summary: `${tool.name} failed`, links: [] };
  }
}
const clipMessage = (m: string) => (m.length > 120 ? `${m.slice(0, 120)}…` : m);

/** The tools as the agent loop takes them: bound to this person's ctx and this turn's environment. */
export function toAgentTools(ctx: Ctx, env: ToolEnv, tools: readonly AssistantTool[] = ASSISTANT_TOOLS): AgentTool[] {
  // The model may ask for several tools in one step; they share one connection (and savepoints), so they run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  return tools.map((t) => ({
    name: t.name, description: t.description, inputSchema: t.input,
    execute: (args: unknown): Promise<AgentToolOutput> => {
      const run = queue.then(() => runAssistantTool(ctx, t, args, env));
      queue = run.catch(() => undefined);
      return run;
    },
  }));
}
