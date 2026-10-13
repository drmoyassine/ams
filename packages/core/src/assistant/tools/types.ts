// The assistant's tool registry (DEC-027). A tool is a plain typed function registered by NAME with a Zod input schema and an
// `execute(ctx, args)`. Each READ tool calls the existing core service with the signed-in person's own ctx, so the permission
// checks are exactly those of the screens; a person who may not see something gets a refusal, not data.
//
// PHASE 2 (bulk edits) slots in here without changing this shape: a write tool has `access: 'propose'` and returns a change
// proposal (a new message part type) instead of writing; the apply step is a separate API call made by the person's button
// press. Phase 1 registers read tools and `propose_memory` only; a test pins that (no tool can read evidence or write standards).
import type { z } from 'zod';
import type { AssistantContext, AssistantLink, MessagePart } from '@ams/shared';
import type { Ctx } from '../../ctx.js';

/** What a tool returns: `data` goes to the model (as labelled data, size-capped); `summary` and `links` go to the person's screen. */
export interface ToolOutput {
  data: unknown;
  /** One plain line for the "Looked up 3 things" list ("Found 5 requirements about library"). */
  summary: string;
  links: AssistantLink[];
  refused?: boolean;
}

/** What a tool may use besides its arguments. */
export interface ToolEnv {
  /** The context chips of the person's message. */
  context: AssistantContext | null;
  conversationId: string;
  messageId: string;
  /** Every text string that tools returned so far in this turn (document text: never to be saved as memory). */
  seenText: string[];
  /** The texts already suggested as memory in this turn (not suggested twice). */
  seenProposals: string[];
  /** Adds a part to the assistant's message (a memory proposal, a change proposal). */
  emit(part: MessagePart): void;
  /**
   * Phase 2. Asks the model to write new texts for a batch of items (draft_rewrites). Only the job provides it (it calls the AI
   * through the one import point, inside the turn's budget); absent where there is no model (tests of single tools).
   */
  rewrite?: (batch: RewriteBatch) => Promise<{ id: string; text: string }[]>;
  /** Texts written by the model in this turn, by set id; propose_changes copies them into the proposal (a `rewrite_text` operation). */
  rewriteSets?: Map<string, RewriteSet>;
}

export interface RewriteBatch { instruction: string; field: 'title' | 'officialText' | 'translationEn'; items: { id: string; code: string; text: string }[] }
export interface RewriteSet { versionId: string; field: 'title' | 'officialText' | 'translationEn'; instruction: string; items: { id: string; text: string }[] }

export interface AssistantTool<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /** `read`: looks things up. `propose`: shows the person something to confirm (the memory card, a change proposal). Never changes anything itself. */
  access: 'read' | 'propose';
  input: I;
  /** The arguments in plain words, for the person's list of steps. */
  describeArgs(args: z.infer<I>): string;
  execute(ctx: Ctx, args: z.infer<I>, env: ToolEnv): Promise<ToolOutput>;
}

export const defineTool = <I extends z.ZodType>(tool: AssistantTool<I>): AssistantTool<I> => tool;

/** Cuts text to a length, with an ellipsis. */
export const clip = (text: string | null | undefined, n: number): string => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
