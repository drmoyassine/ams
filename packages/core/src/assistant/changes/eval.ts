// The evaluation of the assistant's bulk edits (DEC-027 Phase 2): a set of sample instructions (English and Arabic), each with the
// operations it should become and the exact rows those operations should change on a fixture tree. Two uses:
//   * a unit test runs every reference operation list over the fixture and asserts the exact result (no model, no network);
//   * `pnpm assistant:eval` also asks a REAL model to turn each instruction into operations and compares what those operations
//     DO on the fixture with what was expected (different operations with the same effect pass).
// The fixture and the instructions live in packages/core/eval/assistant-instructions.json; the sample names are data only.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ChangeSetInputSchema, OperationSchema, type Operation } from '@ams/shared';
import { aiExtract, type AiRuntime } from '../../ai/index.js';
import type { ReqRow } from './filter.js';
import { planOperations, type VersionFacts } from './plan.js';
import type { Plan, Step } from './types.js';

export interface EvalFixtureRow {
  code: string; parent: string | null; level: string; title: string; text: string | null;
  assessable?: boolean; language?: string; origin?: string; quoteNotFound?: boolean; editedByPerson?: boolean; notes?: number;
}
export interface EvalFixture { version: string; levels: string[]; internal?: boolean; rows: EvalFixtureRow[] }
export interface EvalExpect {
  /** Old code -> the fields that change and their new values (every changed row must be listed, and only those). */
  changes?: Record<string, Record<string, string | boolean | null>>;
  /** Roots that go to the Trash. */
  deleted?: string[];
  /** Code -> the code of its new parent (null: the top level). */
  moved?: Record<string, string | null>;
  created?: string[];
  /** Codes reported as skipped (sorted comparison). */
  skipped?: string[];
  /** The operations cannot be proposed: part of the first problem's text. */
  problem?: string;
}
export interface EvalInstruction { id: string; lang: 'en' | 'ar'; text: string; operations: unknown[]; expect: EvalExpect }
export interface EvalSet { description: string; fixture: EvalFixture; instructions: EvalInstruction[] }

/** A stable uuid for a fixture code, so instructions can refer to rows as "@1-1-1". */
export function uuidFor(code: string): string {
  const h = createHash('sha256').update(`eval:${code}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const EVAL_VERSION_ID = '00000000-0000-4000-8000-0000000000e1';

export function fixtureFacts(f: EvalFixture): VersionFacts {
  return { id: EVAL_VERSION_ID, edition: f.version, status: 'draft', label: f.version, internal: f.internal ?? false, frameworkId: EVAL_VERSION_ID, levelLabels: f.levels };
}
export function fixtureRows(f: EvalFixture): { rows: ReqRow[]; noteCounts: Map<string, number> } {
  const noteCounts = new Map<string, number>();
  const rows = f.rows.map((r, i): ReqRow => {
    if (r.notes) noteCounts.set(uuidFor(r.code), r.notes);
    return {
      id: uuidFor(r.code), parentId: r.parent ? uuidFor(r.parent) : null, code: r.code, levelLabel: r.level, title: r.title, officialText: r.text, translationEn: null,
      language: r.language ?? 'en', isAssessable: r.assessable ?? true, displayOrder: i, origin: r.origin ?? 'manual', sourceQuote: r.quoteNotFound ? 'a quote' : null,
      quoteVerified: false, editedByPerson: r.editedByPerson ?? false,
    };
  });
  return { rows, noteCounts };
}

/** Replaces "@<code>" strings by the fixture row's id, anywhere in the operations. */
export function resolveRefs<T>(value: T): T {
  if (typeof value === 'string') return (value.startsWith('@') ? uuidFor(value.slice(1)) : value) as T;
  if (Array.isArray(value)) return value.map(resolveRefs) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v)])) as T;
  return value;
}

/** Parses operations like the tool does and plans them over the fixture. A refusal of the schema is returned as a problem. */
export async function runOnFixture(f: EvalFixture, operations: unknown[]): Promise<Plan | { schemaProblem: string }> {
  const parsed = ChangeSetInputSchema.safeParse({ versionId: EVAL_VERSION_ID, summary: 'evaluation', operations: resolveRefs(operations) });
  if (!parsed.success) return { schemaProblem: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const { rows, noteCounts } = fixtureRows(f);
  return planOperations(null, fixtureFacts(f), rows, noteCounts, parsed.data.operations);
}

export interface Effect { changes: Record<string, Record<string, string | boolean | null>>; deleted: string[]; moved: Record<string, string | null>; created: string[]; skipped: string[]; problem: string | null }

/** What a plan does to the fixture, in the vocabulary of the expectations (codes, not ids). */
export function effectOf(f: EvalFixture, plan: Plan | { schemaProblem: string }): Effect {
  const empty: Effect = { changes: {}, deleted: [], moved: {}, created: [], skipped: [], problem: null };
  if ('schemaProblem' in plan) return { ...empty, problem: plan.schemaProblem };
  const codeOf = new Map(f.rows.map((r) => [uuidFor(r.code), r.code]));
  const out: Effect = { ...empty, problem: plan.problems[0] ?? null, skipped: plan.skipped.map((s) => s.code ?? '?').sort() };
  for (const s of plan.steps as Step[]) {
    if (s.kind === 'req_fields') out.changes[s.code] = { ...(out.changes[s.code] ?? {}), ...(s.set as Record<string, string | boolean | null>) };
    else if (s.kind === 'delete') out.deleted.push(...s.codes);
    else if (s.kind === 'move') for (const m of s.moves) out.moved[codeOf.get(m.id) ?? m.id] = m.parentId ? codeOf.get(m.parentId) ?? m.parentId : null;
    else if (s.kind === 'create') out.created.push(s.code);
    else if (s.kind === 'merge') out.deleted.push(s.code);
    else if (s.kind === 'split') out.created.push(s.newCode);
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortKeys = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))) as T;

/** The differences between what happened and what was expected; empty when they agree. */
export function compareEffect(effect: Effect, expect: EvalExpect): string[] {
  const diffs: string[] = [];
  if (expect.problem !== undefined) {
    if (!effect.problem) diffs.push(`expected a problem (${expect.problem}) but the operations were accepted`);
    else if (!effect.problem.toLowerCase().includes(expect.problem.toLowerCase())) diffs.push(`problem was "${effect.problem}", expected it to mention "${expect.problem}"`);
    return diffs;
  }
  if (effect.problem) { diffs.push(`unexpected problem: ${effect.problem}`); return diffs; }
  const changes = expect.changes ?? {};
  const eNorm = Object.fromEntries(Object.entries(effect.changes).map(([k, v]) => [k, sortKeys(v)]));
  const xNorm = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, sortKeys(v)]));
  for (const code of new Set([...Object.keys(eNorm), ...Object.keys(xNorm)])) {
    if (!same(eNorm[code], xNorm[code])) diffs.push(`${code}: got ${JSON.stringify(eNorm[code] ?? null)}, expected ${JSON.stringify(xNorm[code] ?? null)}`);
  }
  if (!same([...effect.deleted].sort(), [...(expect.deleted ?? [])].sort())) diffs.push(`deleted ${JSON.stringify(effect.deleted)}, expected ${JSON.stringify(expect.deleted ?? [])}`);
  if (!same(sortKeys(effect.moved), sortKeys(expect.moved ?? {}))) diffs.push(`moved ${JSON.stringify(effect.moved)}, expected ${JSON.stringify(expect.moved ?? {})}`);
  if (!same([...effect.created].sort(), [...(expect.created ?? [])].sort())) diffs.push(`created ${JSON.stringify(effect.created)}, expected ${JSON.stringify(expect.created ?? [])}`);
  if (expect.skipped !== undefined && !same(effect.skipped, [...expect.skipped].sort())) diffs.push(`skipped ${JSON.stringify(effect.skipped)}, expected ${JSON.stringify([...expect.skipped].sort())}`);
  return diffs;
}

/** The reference operations of an instruction, run over the fixture and compared with what is expected. */
export async function checkReference(set: EvalSet, i: EvalInstruction): Promise<string[]> {
  return compareEffect(effectOf(set.fixture, await runOnFixture(set.fixture, i.operations)), i.expect);
}

// ---- Asking a real model ---------------------------------------------------------------------------------------------------------------
const ModelAnswerSchema = z.object({ operations: z.array(OperationSchema).min(1).max(12) });

/** The fixture as the model reads it: one line per item with its id, so operations can name items. */
export function describeFixture(f: EvalFixture): string {
  const lines = [`Version "${f.version}" (a draft). Level names, top to bottom: ${f.levels.join(', ')}.`, 'Items (id | code | level | parent code | assessable | title | description):'];
  for (const r of fixtureRows(f).rows) {
    const parent = f.rows.find((x) => uuidFor(x.code) === r.parentId)?.code ?? '-';
    lines.push(`${r.id} | ${r.code} | ${r.levelLabel} | ${parent} | ${r.isAssessable ? 'yes' : 'no'} | ${r.title.replace(/\s+/g, ' ').slice(0, 100)} | ${(r.officialText ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  return lines.join('\n');
}

/** Asks the real model (through the one import point) which operations an instruction means. Worker-scope: the caller runs it inside runInAiScope. */
export async function askModelForOperations(f: EvalFixture, instruction: string, runtime: AiRuntime): Promise<{ operations: Operation[] }> {
  const input = `${describeFixture(f)}\n\nThe person's instruction:\n${instruction}`;
  const r = await aiExtract({ task: 'assistant_eval', promptVersion: 'v1', input, schema: ModelAnswerSchema, runtime });
  return r.data;
}
