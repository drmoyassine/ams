// The generic `translate` job (TASK-070): English into the institution's secondary language, in batches, for any kind of text
// that has a TranslationSource (the interface catalogue now; the IQF, standards and glossary in TASK-071).
//
// One job = one batch, each in its own transaction so progress shows; the run row holds the position (progress.cursor) so a
// retried or duplicated job is harmless and a crashed run resumes. Each batch goes through aiExtract (temperature 0, prompt
// translate.v1). Every answer is checked by a deterministic validator (translationProblem): a translation that drops, alters or
// invents a {{placeholder}}, is empty, or adds HTML is asked for once more with the reason; if it fails again it is set aside
// (listed in the run's report, not stored, shown in English). Results are origin 'ai', reviewed false; a person's text or a
// reviewed row is never touched (source filter + database guard). The spend cap of Settings -> AI (the analysis role) ends the
// run as `stopped`; Resume continues with what is still pending under a fresh allowance.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { glossaryTerm, job, translationRun } from '@ams/db';
import {
  ACTIVE_TRANSLATION_STATUSES, RESUMABLE_TRANSLATION_STATUSES, languageInfo, nfc, translationProblem, type TranslationKind, type TranslationRun,
} from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { AiDisabledError, AiNotConfiguredError, aiExtract, BudgetExceeded, type AiRuntime } from '../ai/index.js';
import { aiReadiness, loadAiRuntime } from '../ai/settings.js';
import { assertHuman } from '../framework/common.js';
import { enqueueJob } from '../jobs/jobs.js';
import { assertPermitted } from '../permissions.js';
import { translationSourceFor, type TranslationItem } from './source.js';
import './register.js';

export const TRANSLATE_PROMPTS = { translate: 'v1' } as const;
/** Items per call, and a cap on the characters of English in one call (whichever is reached first). */
export const DEFAULT_BATCH_ITEMS = 40;
export const BATCH_CHARS = 6000;
/** The queue retries a failed job 3 times (pgboss-queue.ts): after the 4th attempt the run is marked failed. */
export const MAX_TRANSLATE_ATTEMPTS = 4;

const Answer = z.object({ translations: z.array(z.object({ id: z.string(), text: z.string() })) });
type Run = typeof translationRun.$inferSelect;
type Spend = { inputTokens: number; outputTokens: number; costUsd: number | null; calls: number };
type Progress = { total: number; done: number; flagged: number; batches: number; cursor: number };
type Flag = { id: string; reason: string };
type Report = { flagged?: Flag[]; spendBase?: Spend; runtime?: { model: string }; stoppedAt?: string; [k: string]: unknown };
const PayloadSchema = z.object({ runId: z.uuid(), cursor: z.number().int().min(0).default(0) });

export const runDto = (r: Run): TranslationRun => {
  const p = r.progress as Partial<Progress>;
  const rep = r.report as Report;
  return {
    id: r.id, kind: r.kind as TranslationKind, language: r.language, scopeId: r.scopeId, status: r.status as TranslationRun['status'],
    retranslateStale: !!(r.options as { retranslateStale?: boolean }).retranslateStale,
    progress: { total: p.total ?? 0, done: p.done ?? 0, flagged: p.flagged ?? 0, batches: p.batches ?? 0 },
    usage: r.usage as Spend, model: r.model, error: r.error, flagged: rep.flagged ?? [],
    startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null,
  };
};

async function getRunRow(ctx: Ctx, id: string): Promise<Run> {
  const [row] = await ctx.tx.select().from(translationRun).where(eq(translationRun.id, id));
  if (!row) throw new NotFoundError(`translation run ${id}`);
  return row;
}

// ---- Starting, following, cancelling, resuming -------------------------------------------------------------------------

/** Who may translate which kind. The interface catalogue is the institution's: its administrator. */
async function assertMayTranslate(ctx: Ctx) {
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
}

export interface StartOptions { kind: TranslationKind; language: string; scopeId?: string | null; retranslateStale?: boolean; batchItems?: number }

export async function startTranslation(ctx: Ctx, o: StartOptions): Promise<TranslationRun> {
  assertHuman(ctx);
  await assertMayTranslate(ctx);
  if (!languageInfo(o.language) || o.language === 'en') throw new ValidationError('choose a secondary language in Settings -> Organization first');
  const ready = await aiReadiness(ctx);
  if (!ready.ok) throw new ConflictError(ready.reason);
  const scopeId = o.scopeId ?? null;
  const [active] = await ctx.tx.select({ id: translationRun.id }).from(translationRun)
    .where(and(eq(translationRun.kind, o.kind), eq(translationRun.language, o.language), inArray(translationRun.status, [...ACTIVE_TRANSLATION_STATUSES])));
  if (active) throw new ConflictError('a translation of this is already running');
  const pending = await translationSourceFor(o.kind).listPending(ctx, o.language, { includeStale: !!o.retranslateStale, scopeId });
  if (pending.length === 0) throw new ConflictError('nothing is waiting to be translated');
  const options = { retranslateStale: !!o.retranslateStale, ...(o.batchItems ? { batchItems: o.batchItems } : {}) };
  const progress: Progress = { total: pending.length, done: 0, flagged: 0, batches: 0, cursor: 0 };
  const [row] = await ctx.tx.insert(translationRun).values({
    institutionId: ctx.caller.institutionId, kind: o.kind, language: o.language, scopeId, status: 'queued', options,
    progress, promptVersions: TRANSLATE_PROMPTS, startedBy: ctx.caller.userId, startedAt: new Date(),
  }).returning();
  await enqueueJob(ctx, { type: 'translate', payload: { runId: row!.id, cursor: 0 } });
  return runDto(row!);
}

export async function getTranslationRun(ctx: Ctx, id: string): Promise<TranslationRun> {
  await assertPermitted(ctx, 'org:read', { type: 'any' });
  return runDto(await getRunRow(ctx, id));
}

/** The latest run of a kind for a language (newest first), if any. */
export async function latestTranslationRun(ctx: Ctx, kind: TranslationKind, language: string): Promise<TranslationRun | null> {
  const [row] = await ctx.tx.select().from(translationRun)
    .where(and(eq(translationRun.kind, kind), eq(translationRun.language, language))).orderBy(desc(translationRun.createdAt)).limit(1);
  return row ? runDto(row) : null;
}

export async function cancelTranslation(ctx: Ctx, id: string): Promise<TranslationRun> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
  const run = await getRunRow(ctx, id);
  if (!(ACTIVE_TRANSLATION_STATUSES as readonly string[]).includes(run.status)) throw new ConflictError(`the translation has already ended (${run.status})`);
  const [row] = await ctx.tx.update(translationRun).set({ status: 'cancelled', finishedAt: new Date(), error: 'cancelled by a person' })
    .where(and(eq(translationRun.id, id), inArray(translationRun.status, [...ACTIVE_TRANSLATION_STATUSES]))).returning();
  if (!row) throw new ConflictError('the translation has already ended');
  return runDto(row);
}

/**
 * Continues a stopped, cancelled or failed run with what is still pending, under a fresh spend allowance (the spend so far is
 * kept in the usage total, and the cap counts from now). Items that were set aside get another chance.
 */
export async function resumeTranslation(ctx: Ctx, id: string): Promise<TranslationRun> {
  assertHuman(ctx);
  await assertPermitted(ctx, 'institution:write', { type: 'institution' });
  const run = await getRunRow(ctx, id);
  if (!(RESUMABLE_TRANSLATION_STATUSES as readonly string[]).includes(run.status)) throw new ConflictError(`only a stopped, cancelled or failed translation can be resumed (this one is ${run.status})`);
  const ready = await aiReadiness(ctx);
  if (!ready.ok) throw new ConflictError(ready.reason);
  const [active] = await ctx.tx.select({ id: translationRun.id }).from(translationRun)
    .where(and(eq(translationRun.kind, run.kind), eq(translationRun.language, run.language), inArray(translationRun.status, [...ACTIVE_TRANSLATION_STATUSES])));
  if (active) throw new ConflictError('a translation of this is already running');
  const opts = run.options as { retranslateStale?: boolean };
  const pending = await translationSourceFor(run.kind).listPending(ctx, run.language, { includeStale: !!opts.retranslateStale, scopeId: run.scopeId });
  if (pending.length === 0) throw new ConflictError('nothing is waiting to be translated');
  const p = run.progress as Partial<Progress>;
  const cursor = (p.cursor ?? 0) + 1; // a job still queued from before sees a cursor that no longer matches and does nothing
  const progress: Progress = { total: (p.done ?? 0) + pending.length, done: p.done ?? 0, flagged: 0, batches: p.batches ?? 0, cursor };
  const report: Report = { ...(run.report as Report), flagged: [], spendBase: { ...(run.usage as Spend) } };
  const [row] = await ctx.tx.update(translationRun).set({ status: 'queued', error: null, finishedAt: null, progress, report })
    .where(eq(translationRun.id, id)).returning();
  await enqueueJob(ctx, { type: 'translate', payload: { runId: id, cursor } });
  return runDto(row!);
}

// ---- Glossary ----------------------------------------------------------------------------------------------------------

/**
 * Required term translations for a batch: the institution's glossary terms (English label -> label in the target language)
 * whose English appears in the batch. Only Arabic is stored in the glossary today; other languages get none.
 */
async function glossaryFor(ctx: Ctx, language: string, items: TranslationItem[]): Promise<{ en: string; target: string }[]> {
  if (language !== 'ar') return [];
  const terms = await ctx.tx.select({ en: glossaryTerm.labelEn, ar: glossaryTerm.labelAr }).from(glossaryTerm).where(eq(glossaryTerm.active, true));
  const haystack = items.map((i) => i.text.toLowerCase()).join('\n');
  return terms.filter((t) => t.ar && haystack.includes(t.en.toLowerCase())).map((t) => ({ en: t.en, target: nfc(t.ar!) }));
}

// ---- The batch ----------------------------------------------------------------------------------------------------------

/** Takes items from the front until the batch is full by count or characters (always at least one). */
export function pickBatch(pending: TranslationItem[], maxItems: number, maxChars = BATCH_CHARS): TranslationItem[] {
  const out: TranslationItem[] = [];
  let chars = 0;
  for (const it of pending) {
    if (out.length >= maxItems || (out.length > 0 && chars + it.text.length > maxChars)) break;
    out.push(it);
    chars += it.text.length;
  }
  return out;
}

function inputFor(language: string, items: { id: string; text: string; context?: string | undefined }[], glossary: { en: string; target: string }[]): string {
  const info = languageInfo(language);
  const lines = [`Target language: ${info?.nameEn ?? language} (${language}), ${info?.dir === 'rtl' ? 'written right to left' : 'written left to right'}.`];
  if (glossary.length) lines.push('Glossary (use exactly these translations):', ...glossary.map((g) => `- "${g.en}" => "${g.target}"`));
  lines.push('Items:', JSON.stringify(items.map((i) => ({ id: i.id, text: i.text, ...(i.context ? { context: i.context } : {}) }))));
  return lines.join('\n');
}

export interface BatchResult { valid: { item: TranslationItem; text: string }[]; flagged: Flag[] }

/**
 * Translates one batch: ask, check every answer, ask once more for those that failed (telling the model why), set aside what
 * still fails. Results accumulate in `acc` as they are known, so a spend limit hit during the second call still keeps the
 * first call's good answers.
 */
export async function translateBatch(runtime: AiRuntime, language: string, batch: TranslationItem[], glossary: { en: string; target: string }[], acc: BatchResult): Promise<void> {
  const check = (answers: Map<string, string>, items: TranslationItem[]) => {
    const failed: { item: TranslationItem; reason: string }[] = [];
    for (const item of items) {
      const raw = answers.get(item.id);
      if (raw === undefined) { failed.push({ item, reason: 'the model returned nothing for this item' }); continue; }
      const text = nfc(raw.trim());
      const problem = translationProblem(item.text, text);
      if (problem) failed.push({ item, reason: problem }); else acc.valid.push({ item, text });
    }
    return failed;
  };
  const ask = async (items: { id: string; text: string; context?: string | undefined }[]) => {
    const { data } = await aiExtract({ task: 'translate', promptVersion: TRANSLATE_PROMPTS.translate, input: inputFor(language, items, glossary), schema: Answer, runtime });
    return new Map(data.translations.map((t) => [t.id, t.text]));
  };
  const first = check(await ask(batch), batch);
  if (first.length === 0) return;
  const again = check(await ask(first.map((f) => ({
    id: f.item.id, text: f.item.text,
    context: `${f.item.context ?? ''} Your previous translation was rejected: ${f.reason}. Keep every {{placeholder}} exactly as in the English.`.trim(),
  }))), first.map((f) => f.item));
  for (const f of again) acc.flagged.push({ id: f.item.id, reason: f.reason });
}

// ---- The job ------------------------------------------------------------------------------------------------------------

const ACTIVE: string[] = [...ACTIVE_TRANSLATION_STATUSES];

/** Totals after this job: what was spent before the last resume, plus this allowance's spend so far. */
const usageOf = (runtime: AiRuntime, spend0: Spend, spent: Spend): Spend => {
  const priced = runtime.budget.limits.inputUsdPerMTok != null && runtime.budget.limits.outputUsdPerMTok != null;
  return {
    inputTokens: spend0.inputTokens + runtime.budget.inputTokens, outputTokens: spend0.outputTokens + runtime.budget.outputTokens,
    costUsd: priced ? Math.round(((spend0.costUsd ?? 0) + runtime.budget.costUsd) * 1e6) / 1e6 : spent.costUsd,
    // A call the budget refused never reached the model and is not counted.
    calls: spent.calls + runtime.calls.filter((c) => c.ok || !c.error?.includes('budget for this run is used up')).length,
  };
};

async function endRun(ctx: Ctx, run: Run, status: 'failed' | 'stopped' | 'succeeded', fields: { error?: string | null; usage?: Spend; progress?: Progress; report?: Report }) {
  await ctx.tx.update(translationRun).set({
    status, finishedAt: new Date(), error: fields.error?.slice(0, 1000) ?? null,
    ...(fields.usage ? { usage: fields.usage } : {}), ...(fields.progress ? { progress: fields.progress } : {}), ...(fields.report ? { report: fields.report } : {}),
  }).where(and(eq(translationRun.id, run.id), inArray(translationRun.status, ACTIVE)));
}

async function attemptsOfThisJob(ctx: Ctx) {
  const [row] = await ctx.tx.select({ attempts: job.attempts }).from(job).where(eq(job.id, ctx.caller.requestId));
  return row?.attempts ?? MAX_TRANSLATE_ATTEMPTS;
}

const savepoint = sql`savepoint translate_step`;
const release = sql`release savepoint translate_step`;
const rollback = sql`rollback to savepoint translate_step`;

/** The `translate` job handler: one batch. */
export async function translateJob(ctx: Ctx, payload: Record<string, unknown>) {
  const p = PayloadSchema.parse(payload);
  const run = await getRunRow(ctx, p.runId);
  const info = { runId: run.id, cursor: p.cursor };
  if (!ACTIVE.includes(run.status)) return { ...info, skipped: `the run is ${run.status}` };
  const progress = run.progress as Progress;
  if ((progress.cursor ?? 0) !== p.cursor) return { ...info, skipped: 'the run has moved on' };

  let runtime: AiRuntime;
  try {
    runtime = await loadAiRuntime(ctx);
  } catch (e) {
    if (e instanceof AiDisabledError || e instanceof AiNotConfiguredError) { await endRun(ctx, run, 'failed', { error: e.message }); return { ...info, failed: true, error: e.message }; }
    throw e;
  }
  const report = run.report as Report;
  // The cap counts this allowance only: the spend before the last resume is already in `usage`.
  const spent = run.usage as Spend;
  const spend0: Spend = report.spendBase ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
  runtime.budget.inputTokens = spent.inputTokens - spend0.inputTokens;
  runtime.budget.outputTokens = spent.outputTokens - spend0.outputTokens;
  runtime.budget.costUsd = (spent.costUsd ?? 0) - (spend0.costUsd ?? 0);

  const opts = run.options as { retranslateStale?: boolean; batchItems?: number };
  const source = translationSourceFor(run.kind);
  const flaggedSoFar = report.flagged ?? [];
  const skip = new Set(flaggedSoFar.map((f) => f.id));
  const pending = (await source.listPending(ctx, run.language, { includeStale: !!opts.retranslateStale, scopeId: run.scopeId })).filter((i) => !skip.has(i.id));
  if (pending.length === 0) {
    await endRun(ctx, run, 'succeeded', { usage: spent, progress: { ...progress, flagged: flaggedSoFar.length }, report: { ...report, runtime: { model: runtime.config.model } } });
    return { ...info, done: true };
  }

  const batch = pickBatch(pending, opts.batchItems ?? DEFAULT_BATCH_ITEMS);
  const glossary = await glossaryFor(ctx, run.language, batch);
  const acc: BatchResult = { valid: [], flagged: [] };
  let stopped: BudgetExceeded | null = null;
  await ctx.tx.execute(savepoint);
  try {
    try {
      await translateBatch(runtime, run.language, batch, glossary, acc);
    } catch (e) {
      if (e instanceof BudgetExceeded) stopped = e; else throw e;
    }
    const saved = acc.valid.length ? await source.saveTranslations(ctx, { language: run.language, scopeId: run.scopeId, runId: run.id, results: acc.valid }) : 0;
    await ctx.tx.execute(release);
    const flagged = [...flaggedSoFar, ...acc.flagged];
    const next: Progress = { total: progress.total, done: (progress.done ?? 0) + saved, flagged: flagged.length, batches: (progress.batches ?? 0) + 1, cursor: p.cursor + 1 };
    const nextReport: Report = { ...report, flagged, runtime: { model: runtime.config.model } };
    const usage = usageOf(runtime, spend0, spent);
    if (stopped) {
      nextReport.stoppedAt = new Date().toISOString();
      await endRun(ctx, run, 'stopped', { error: `${stopped.message}. ${next.done} of ${next.total} translated; resume to continue.`, usage, progress: next, report: nextReport });
      return { ...info, stopped: stopped.message, saved, ai: runtime.calls };
    }
    const [row] = await ctx.tx.update(translationRun).set({ status: 'running', progress: next, report: nextReport, usage, model: runtime.config.model })
      .where(and(eq(translationRun.id, run.id), inArray(translationRun.status, ACTIVE))).returning({ id: translationRun.id });
    if (row) await enqueueJob(ctx, { type: 'translate', payload: { runId: run.id, cursor: next.cursor } });
    return { ...info, saved, flagged: acc.flagged.length, ai: runtime.calls };
  } catch (e) {
    await ctx.tx.execute(rollback);
    const message = e instanceof Error ? e.message : String(e);
    if ((await attemptsOfThisJob(ctx)) >= MAX_TRANSLATE_ATTEMPTS) {
      await endRun(ctx, run, 'failed', { error: message, usage: usageOf(runtime, spend0, spent) });
      return { ...info, failed: true, error: message, ai: runtime.calls };
    }
    throw e; // the queue tries this batch again; the run stays where it was
  }
}
