// The import target registry (TASK-075, docs/ai-import.md). A place that wants the AI to read documents and fill drafts registers ONE
// target: what it can fill (a Zod schema of one proposed item), the versioned prompt, how to check an item, how to name it, and how
// to write accepted items as the person in one transaction. The engine (stages.ts, proposals.ts) does everything else: reading,
// windows, the AI call, quote verification, merging, review, apply, undo and the report.
import { z } from 'zod';
import type { DocScopeKind } from '@ams/shared';
import type { Ctx } from '../ctx.js';

/** What a target's `buildPrompt` is given for one window of pages. */
export interface PromptWindow {
  documentName: string;
  language: string;
  /** The place the items will go to ("Programs", "Council Handbook 2023"). */
  scopeLabel: string;
  firstPage: number;
  lastPage: number;
  /** The pages, each headed by "=== Page N ===" (formatPages). Document text only: evidence is never sent (DEC-013). */
  pages: string;
}

/** What `validate` and `apply` are told about where the items go. */
export interface TargetScope { kind: DocScopeKind; id: string | null; label: string; runId: string }

/** One accepted proposal, as `apply` receives it: the values to write (the person's edits if any) and where they came from. */
export interface ApplyItem<T> {
  proposalId: string;
  /** The effective values (the AI's, or the person's if they edited). Already validated against the target's schema. */
  item: T;
  /** The person changed the values. */
  edited: boolean;
  /** The label from `proposalLabel` (for messages). */
  label: string;
  source: { documentId: string | null; documentName: string | null; page: number | null; quote: string | null; quoteVerified: boolean };
}

/** What `apply` answers for each item. */
export type ApplyOutcome =
  | { proposalId: string; status: 'applied'; ref: unknown }
  /** The target left the real record alone (for example a person edited it since); the reason is shown to the person. */
  | { proposalId: string; status: 'skipped'; reason: string };

export interface ApplyResult {
  outcomes: ApplyOutcome[];
  /**
   * Whatever `reverse` needs to take the whole apply back (JSON): before-images of the rows changed, ids of rows created, Trash group
   * ids of rows deleted. Keep it small and self-contained.
   */
  inverse: unknown;
}

/** One heading (or any outline entry) found by a window of pages, with the numbered form the organise call is given. */
export interface OutlineEntry<H = unknown> { n: number; documentName: string; page: number; item: H }

/**
 * A target that cannot turn one window's pages into its final items by itself (the final items need the whole picture: several
 * documents become ONE framework) says how to do it in two steps. The windows extract an OUTLINE (`outline`: its own schema and
 * prompt; each entry still carries the page and the exact quote, checked like any item), then ONE more model call (`organise`)
 * reads every outline entry of every document and answers the final items, each naming the outline entries it comes from. The
 * final items are the proposals people review; the engine never shows the outline.
 */
export interface OrganiseSpec<T, H, A> {
  outline: { schema: z.ZodType<H>; promptTask: string; promptVersion: string; buildPrompt(window: PromptWindow): string };
  promptTask: string;
  promptVersion: string;
  /** What the place already holds that the answer must fit (the framework as it is now), as plain text for the prompt. */
  context?(ctx: Ctx, scope: TargetScope): Promise<string>;
  buildPrompt(input: { scopeLabel: string; documents: { name: string; language: string; role: string | null }[]; entries: OutlineEntry<H>[]; context: string }): string;
  /** What the model answers: a list of answer items. */
  answer: z.ZodType<{ items: A[] }>;
  /** The numbers (`n`) of the outline entries an answer item comes from. The first one is its source in the review. */
  from(a: A): number[];
  /** The final item (plain data the target's schema accepts), with the model's confidence and its own flags. */
  build(a: A, sources: OutlineEntry<H>[]): { item: T; confidence?: number | null; flags?: string[] };
}

export interface ImportTarget<T = unknown> {
  /** Unique key, stored on runs and proposals ("programs"). */
  kind: string;
  /** Shown on the Import button and in the history ("Programs"). */
  label: string;
  /** One sentence for the person: what this import reads and fills. */
  description: string;
  /** The plural noun for what it finds, for counts ("programs"). */
  itemsLabel: string;
  /** The places that offer this import. */
  scopeKinds: readonly DocScopeKind[];
  /** Which model reads: the analysis model (default) or the reading (vision) model, for targets that read images. */
  aiRole?: 'analysis' | 'reading';
  /**
   * Is this import offered at this particular place? (The standards' Docs tab is one scope kind, but an import for the institution's
   * own framework is not offered on an accreditor's standard.) Default: yes. Checked when the buttons are listed and again on start.
   */
  available?(ctx: Ctx, scope: TargetScope): Promise<boolean>;
  /** Two steps instead of one: outline per window, then one organise call (see OrganiseSpec). The prompt fields below then serve the final items only. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  organise?: OrganiseSpec<T, any, any>;
  /** Zod schema of ONE proposed item. Plain data only; the engine wraps it with the page, the quote and the confidence. */
  schema: z.ZodType<T>;
  /** The system prompt: `PROMPTS[promptTask][promptVersion]` in packages/core/src/ai/prompts (a change of wording is a new version). */
  promptTask: string;
  promptVersion: string;
  /** The user message for one window of pages: the instructions specific to this target followed by the pages. */
  buildPrompt(window: PromptWindow): string;
  /**
   * Plain-words reasons an item deserves a look ("no degree level found"), or an empty list. Never throws and never writes; it
   * runs in the worker with read-only intent. Flags are shown to the person, never silent.
   */
  validate?(item: T, scope: TargetScope, ctx: Ctx): Promise<string[]> | string[];
  /**
   * Choices the review offers for some fields, read as the person: `options` are the only values allowed (a choice), `suggestions`
   * are offered while a new value can still be typed (e.g. the org chart's units, where an unknown unit is proposed as new).
   * Fields with a fixed enum in the schema get their options without this.
   */
  fieldChoices?(ctx: Ctx, scope: TargetScope): Promise<{ options?: Record<string, string[]>; suggestions?: Record<string, string[]> }>;
  /** A short name for the table row, the toast and the report ("BSc Nursing"). */
  proposalLabel(item: T): string;
  /** Items with the same key found in overlapping windows are one item. Return null to never merge an item. Default: the normalised JSON. */
  dedupeKey?(item: T): string | null;
  /**
   * Writes the accepted items as the person (their permissions, their identity), in the caller's transaction: all or nothing. The
   * contract is in docs/ai-import.md: never overwrite a record a person edited (skip it with a reason), create what is new, and
   * return what `reverse` needs. Throw a ConflictError to refuse the whole apply.
   */
  apply(ctx: Ctx, items: ApplyItem<T>[], scope: TargetScope): Promise<ApplyResult>;
  /**
   * Takes an apply back, or puts it back (undo and redo are the same operation): given the `inverse` an apply (or a reverse)
   * returned, does it and returns the inverse of THAT. Runs as the person in one transaction and may refuse (ConflictError).
   */
  reverse(ctx: Ctx, inverse: unknown, scope: TargetScope): Promise<unknown>;
}

const targets = new Map<string, ImportTarget<never>>();

/** Registers (or replaces) an import target. Production targets register at start-up from their own module; tests register their own. */
export function registerImportTarget<T>(target: ImportTarget<T>): void {
  if (!target.scopeKinds.length) throw new Error(`import target ${target.kind} names no scope kind`);
  targets.set(target.kind, target as unknown as ImportTarget<never>);
}

export function unregisterImportTarget(kind: string): void {
  targets.delete(kind);
}

export function findImportTarget(kind: string): ImportTarget<unknown> | undefined {
  return targets.get(kind) as unknown as ImportTarget<unknown> | undefined;
}

/** The targets a scope kind offers. */
export function importTargetsFor(scopeKind: string): ImportTarget<unknown>[] {
  return [...targets.values()].filter((t) => (t.scopeKinds as readonly string[]).includes(scopeKind)) as unknown as ImportTarget<unknown>[];
}

/** What the model must answer for a window: the target's item with the page and the quote it comes from. */
export function windowSchema<T>(item: z.ZodType<T>) {
  return z.object({
    items: z.array(z.object({
      item: item,
      source: z.object({ page: z.number().int(), quote: z.string() }),
      confidence: z.number().min(0).max(1).nullish(),
      flags: z.array(z.string()).default([]),
    })),
  });
}
