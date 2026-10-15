// The `import` job (TASK-075, docs/ai-import.md): one small stage step of an import run per job, each in its own transaction so
// progress shows, each queuing the next. The run row holds the stage and the position inside it (progress.cursor); a job whose
// stage and cursor no longer match the run does nothing, so a retried or duplicated job is harmless and a crashed one resumes.
// The same machinery as the framework analysis (framework/analysis/stages.ts): budget, cancel, resume, failure.
//
//   read     one document per job: waits (bounded) for the parser service to have read it; plans the windows when all are read
//   extract  one window of ~8 pages (1 page overlap) per job: aiExtract (temperature 0) with the target's versioned prompt and
//            schema; each item with its page and quote is stored as a CANDIDATE (invisible to people)
//   verify   one job: the quote of every candidate is looked for on its page with the Arabic-aware matcher; the target's own
//            checks add their reasons. Flags are plain words and are never silent
//   propose  one job: duplicates found in the overlap are merged, the rest are released as proposals for a person to review
//   finalise one job: counts; the run succeeds (or ends failed at the spend limit, keeping what was proposed)
//
// The worker's database role writes only import_run, import_proposal (candidates) and import_page rows here; it has no grant on
// the target's real records and never calls `apply` (DEC-006).
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { importPage, importProposal, importRun, job, sourcePage, sourceDocument } from '@ams/db';
import { ACTIVE_IMPORT_STATUSES, IMPORT_STAGES, IMPORT_WINDOW_OVERLAP, IMPORT_WINDOW_PAGES, type ImportProgress, type ImportStage, type ImportUsage } from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { AiCallError, AiDisabledError, AiNotConfiguredError, aiExtract, BudgetExceeded, type AiRuntime } from '../ai/index.js';
import { loadAiRuntime } from '../ai/settings.js';
import { enqueueJob } from '../jobs/jobs.js';
import { formatPages, LOW_CONFIDENCE, pageWindows } from '../framework/analysis/merge.js';
import { verifyQuote } from '../framework/quote-match.js';
import { documentReadState } from './documents.js';
import { getRunRow } from './runs.js';
import { describeScope, getDocScope } from './scopes.js';
import { findImportTarget, windowSchema, type ImportTarget, type TargetScope } from './targets.js';

const PayloadSchema = z.object({ runId: z.uuid(), stage: z.enum(IMPORT_STAGES), cursor: z.number().int().min(0).default(0) });

/** The queue retries a failed job 3 times (pgboss-queue.ts): after the 4th attempt the run is marked failed. */
export const MAX_IMPORT_ATTEMPTS = 4;
/** How long a waiting `read` step sleeps before looking again, and how many looks it makes (about 30 minutes in all). */
export const IMPORT_READ_WAIT_SECONDS = 5;
export const MAX_IMPORT_READ_WAITS = 360;

type Run = typeof importRun.$inferSelect;
interface Window { documentId: string; pages: number[] }
interface Report {
  plan?: { windows: Window[] };
  readErrors?: Record<string, string>;
  /** How many times this run has waited for each document to be read. */
  readWaits?: Record<string, number>;
  /** Documents that have text to read, in order. */
  readable?: string[];
  stoppedBy?: 'budget' | 'cancelled' | 'error';
  stoppedMessage?: string;
  merged?: number;
  runtime?: { model: string; role: 'analysis' | 'reading' };
  [k: string]: unknown;
}
type Next = { stage: ImportStage; cursor: number } | 'done';
interface Step {
  next: Next; progress?: Partial<ImportProgress>; report?: Partial<Report>;
  /** Queue the next job this many seconds from now (the step is waiting for another job). */
  delaySeconds?: number;
}

/** Ends the run as failed with this reason; not retried (trying again would not help). */
class ImportStop extends Error {}

/** A savepoint: a failed step leaves no half-written rows, and the run can still be marked failed in the same job. */
async function step<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  await ctx.tx.execute(sql`savepoint import_step`);
  try {
    const out = await fn();
    await ctx.tx.execute(sql`release savepoint import_step`);
    return out;
  } catch (e) {
    await ctx.tx.execute(sql`rollback to savepoint import_step`);
    throw e;
  }
}

/** The text of some pages of a document, from whichever table holds them. */
async function pagesOf(ctx: Ctx, scopeKind: string, documentId: string, only?: number[]): Promise<{ pageNo: number; text: string }[]> {
  if (getDocScope(scopeKind).storage === 'source') {
    return ctx.tx.select({ pageNo: sourcePage.pageNo, text: sourcePage.text }).from(sourcePage)
      .where(and(eq(sourcePage.sourceDocumentId, documentId), only ? inArray(sourcePage.pageNo, only) : undefined)).orderBy(asc(sourcePage.pageNo));
  }
  return ctx.tx.select({ pageNo: importPage.pageNo, text: importPage.text }).from(importPage)
    .where(and(eq(importPage.importDocumentId, documentId), only ? inArray(importPage.pageNo, only) : undefined)).orderBy(asc(importPage.pageNo));
}

const targetOf = (run: Run): ImportTarget<unknown> => {
  const t = findImportTarget(run.targetKind);
  if (!t) throw new ImportStop(`the import "${run.targetKind}" is not available (it is not registered in this version of the app)`);
  return t;
};

const scopeOf = async (ctx: Ctx, run: Run): Promise<TargetScope> => ({
  kind: run.scopeKind as TargetScope['kind'], id: run.scopeId, label: await describeScope(ctx, run.scopeKind, run.scopeId), runId: run.id,
});

// ---- The stages ----------------------------------------------------------------------------------------------------------

async function read(ctx: Ctx, run: Run, cursor: number, _runtime: AiRuntime, report: Report): Promise<Step> {
  const ids = run.documentIds;
  const progress = { docsTotal: ids.length, docsDone: Math.min(cursor + 1, ids.length) };
  const id = ids[cursor];
  if (id === undefined) return plan(ctx, run, report);
  // The last document read moves straight on to planning the windows.
  const after = async (extra: Partial<Report> = {}): Promise<Step> => {
    if (cursor + 1 < ids.length) return { next: { stage: 'read', cursor: cursor + 1 }, progress, report: extra };
    const planned = await plan(ctx, run, { ...report, ...extra });
    return { ...planned, report: { ...extra, ...planned.report } };
  };
  const state = await documentReadState(ctx, run.scopeKind, id);
  if (!state) return after({ readErrors: { ...report.readErrors, [id]: 'the document was deleted' } });
  if (state.status === 'read' || state.status === 'needs_ocr') return after();
  if (state.status === 'failed') return after({ readErrors: { ...report.readErrors, [id]: state.error ?? 'the file could not be read' } });

  // Not read yet. A standards source nobody asked to read is queued here; an upload is already queued by its upload.
  const waits = report.readWaits?.[id] ?? 0;
  if (state.status === 'not_read' && waits === 0) await queueRead(ctx, run.scopeKind, id);
  if (waits + 1 >= MAX_IMPORT_READ_WAITS) {
    throw new ImportStop(`reading "${state.name}" did not finish in time (it is ${state.status.replace('_', ' ')}); is the parser service running?`);
  }
  return {
    next: { stage: 'read', cursor }, progress: { ...progress, docsDone: cursor }, report: { readWaits: { ...report.readWaits, [id]: waits + 1 } }, delaySeconds: IMPORT_READ_WAIT_SECONDS,
  };
}

/** Queues the parser for a standards source nobody has asked to read (the agent never parses; the parser service does). */
async function queueRead(ctx: Ctx, scopeKind: string, id: string) {
  if (getDocScope(scopeKind).storage !== 'source') return;
  await ctx.tx.update(sourceDocument).set({ textStatus: 'queued' }).where(eq(sourceDocument.id, id));
  await enqueueJob(ctx, { type: 'extract_text', payload: { sourceDocumentId: id } });
}

/** All documents are read (or failed): window the readable ones. */
async function plan(ctx: Ctx, run: Run, report: Report): Promise<Step> {
  const windows: Window[] = [];
  const readable: string[] = [];
  for (const id of run.documentIds) {
    if (report.readErrors?.[id]) continue;
    const pages = (await pagesOf(ctx, run.scopeKind, id)).filter((p) => p.text.trim()).map((p) => p.pageNo);
    if (!pages.length) continue;
    readable.push(id);
    for (const w of pageWindows(pages, IMPORT_WINDOW_PAGES, IMPORT_WINDOW_OVERLAP)) windows.push({ documentId: id, pages: w });
  }
  if (!windows.length) throw new ImportStop('none of the documents had text to read; check that the files open, or read them again');
  return {
    next: { stage: 'extract', cursor: 0 }, progress: { windowsTotal: windows.length, windowsDone: 0, items: 0, docsDone: run.documentIds.length }, report: { plan: { windows }, readable },
  };
}

/** The runtime the target reads with: the analysis model, or the reading (vision) model for a target that declares it. */
function runtimeFor(target: ImportTarget<unknown>, runtime: AiRuntime): { runtime: AiRuntime; role: 'analysis' | 'reading' } {
  if (target.aiRole !== 'reading') return { runtime, role: 'analysis' };
  if (runtime.visionError && !runtime.vision) throw new ImportStop(`this import needs the reading model, which is not ready (${runtime.visionError})`);
  return { runtime: runtime.vision ? { ...runtime, config: runtime.vision } : runtime, role: 'reading' };
}

async function extract(ctx: Ctx, run: Run, cursor: number, runtime: AiRuntime, report: Report): Promise<Step> {
  const windows = report.plan?.windows ?? [];
  const w = windows[cursor];
  const progress = run.progress as ImportProgress;
  if (!w) return { next: { stage: 'verify', cursor: 0 } };
  const target = targetOf(run);
  const rt = runtimeFor(target, runtime);
  const state = await documentReadState(ctx, run.scopeKind, w.documentId);
  const pages = await pagesOf(ctx, run.scopeKind, w.documentId, w.pages);
  const scope = await scopeOf(ctx, run);
  const input = target.buildPrompt({
    documentName: state?.name ?? 'document', language: state?.language ?? 'en', scopeLabel: scope.label, firstPage: w.pages[0]!, lastPage: w.pages[w.pages.length - 1]!, pages: formatPages(pages),
  });
  const { data } = await aiExtract({ task: target.promptTask, promptVersion: target.promptVersion, input, schema: windowSchema(target.schema), runtime: rt.runtime });
  const rows = data.items.map((it, i) => ({
    institutionId: ctx.caller.institutionId, runId: run.id, targetKind: run.targetKind, candidate: true, windowNo: cursor, seq: cursor * 10_000 + i,
    payload: it.item as never, documentId: w.documentId, pageNo: it.source.page, quote: it.source.quote, confidence: it.confidence ?? null, flags: it.flags.map((f) => f.trim()).filter(Boolean),
  }));
  if (rows.length) await ctx.tx.insert(importProposal).values(rows);
  return {
    next: cursor + 1 < windows.length ? { stage: 'extract', cursor: cursor + 1 } : { stage: 'verify', cursor: 0 },
    progress: { windowsTotal: windows.length, windowsDone: cursor + 1, items: (progress.items ?? 0) + rows.length },
    report: { runtime: { model: rt.runtime.config.model, role: rt.role } },
  };
}

const NOT_FOUND = 'The quote was not found on the page it cites.';
const NO_QUOTE = 'The AI gave no quote for this.';
const UNSURE = 'The AI was not sure about this one.';

/** Checks every candidate's quote on its page, and adds the target's own reasons. Idempotent: it recomputes flags from the model's own. */
async function verify(ctx: Ctx, run: Run): Promise<Step> {
  await verifyCandidates(ctx, run);
  return { next: { stage: 'propose', cursor: 0 } };
}

async function verifyCandidates(ctx: Ctx, run: Run) {
  const target = findImportTarget(run.targetKind);
  const rows = await ctx.tx.select().from(importProposal).where(and(eq(importProposal.runId, run.id), eq(importProposal.candidate, true))).orderBy(asc(importProposal.seq));
  const texts = new Map<string, Map<number, string>>();
  const textsOf = async (docId: string) => {
    if (!texts.has(docId)) texts.set(docId, new Map((await pagesOf(ctx, run.scopeKind, docId)).map((p) => [p.pageNo, p.text])));
    return texts.get(docId)!;
  };
  const scope = target ? await scopeOf(ctx, run) : null;
  for (const r of rows) {
    const own = (r.flags as string[]).filter((f) => ![NOT_FOUND, NO_QUOTE, UNSURE].includes(f));
    const flags = [...own];
    let verified = false;
    let page = r.pageNo;
    if (!r.quote?.trim()) flags.push(NO_QUOTE);
    else if (r.documentId && r.pageNo !== null) {
      const check = verifyQuote(r.quote, await textsOf(r.documentId), r.pageNo);
      verified = check.verified;
      if (check.verified && check.page !== null) page = check.page;
      else flags.push(NOT_FOUND);
    } else flags.push(NOT_FOUND);
    if (r.confidence !== null && r.confidence < LOW_CONFIDENCE) flags.push(UNSURE);
    if (target && scope) {
      try {
        const extra = await target.validate?.(r.payload as never, scope, ctx);
        for (const f of extra ?? []) if (f.trim()) flags.push(f.trim());
      } catch { /* a check that cannot run is not a reason to stop the run */ }
    }
    await ctx.tx.update(importProposal).set({ quoteVerified: verified, pageNo: page, flags: [...new Set(flags)] }).where(eq(importProposal.id, r.id));
  }
}

const norm = (v: unknown): unknown => {
  if (typeof v === 'string') return v.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, norm(x)]));
  return v;
};

/** Merges what overlapping windows proposed twice and releases the rest to people. Idempotent: no candidates, nothing to do. */
async function propose(ctx: Ctx, run: Run, _cursor: number, _runtime: AiRuntime, report: Report): Promise<Step> {
  const merged = await releaseCandidates(ctx, run);
  return { next: { stage: 'finalise', cursor: 0 }, report: { merged: (report.merged ?? 0) + merged } };
}

async function releaseCandidates(ctx: Ctx, run: Run): Promise<number> {
  const target = findImportTarget(run.targetKind);
  const rows = await ctx.tx.select().from(importProposal).where(and(eq(importProposal.runId, run.id), eq(importProposal.candidate, true)));
  if (!rows.length) return 0;
  const order = new Map(run.documentIds.map((d, i) => [d, i]));
  rows.sort((a, b) => (order.get(a.documentId ?? '') ?? 99) - (order.get(b.documentId ?? '') ?? 99) || a.windowNo - b.windowNo || a.seq - b.seq);
  const groups = new Map<string, typeof rows>();
  rows.forEach((r, i) => {
    let key: string | null;
    try { key = target?.dedupeKey ? target.dedupeKey(r.payload as never) : JSON.stringify(norm(r.payload)); } catch { key = null; }
    const k = key === null ? `unique:${i}` : `${r.documentId ?? ''}|${key}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  });
  const best = (g: typeof rows) => [...g].sort((a, b) => Number(b.quoteVerified) - Number(a.quoteVerified) || (b.confidence ?? 0) - (a.confidence ?? 0) || JSON.stringify(b.payload).length - JSON.stringify(a.payload).length)[0]!;
  const keep = [...groups.values()].map((g) => ({ row: best(g), group: g }));
  const drop = keep.flatMap(({ row, group }) => group.filter((g) => g.id !== row.id).map((g) => g.id));
  if (drop.length) await ctx.tx.delete(importProposal).where(inArray(importProposal.id, drop));
  keep.sort((a, b) => rows.indexOf(a.row) - rows.indexOf(b.row));
  let n = 0;
  for (const { row } of keep) {
    n += 1;
    let label = '';
    try { label = target?.proposalLabel(row.payload as never) ?? ''; } catch { label = ''; }
    await ctx.tx.update(importProposal).set({ candidate: false, seq: n, label: label.slice(0, 300) }).where(eq(importProposal.id, row.id));
  }
  return drop.length;
}

async function finalise(ctx: Ctx, run: Run, _cursor: number, _runtime: AiRuntime, report: Report): Promise<Step> {
  void ctx; void run;
  if (report.stoppedBy === 'budget') throw new ImportStop(report.stoppedMessage ?? 'the spend limit for one run was reached');
  return { next: 'done' };
}

const STEPS: Record<ImportStage, (ctx: Ctx, run: Run, cursor: number, runtime: AiRuntime, report: Report) => Promise<Step>> = { read, extract, verify, propose, finalise };

// ---- Bookkeeping ---------------------------------------------------------------------------------------------------------

function seedBudget(runtime: AiRuntime, usage: ImportUsage) {
  runtime.budget.inputTokens = usage.inputTokens ?? 0;
  runtime.budget.outputTokens = usage.outputTokens ?? 0;
  runtime.budget.costUsd = usage.costUsd ?? 0;
}
function usageOf(runtime: AiRuntime, before: ImportUsage): ImportUsage {
  const priced = runtime.budget.limits.inputUsdPerMTok != null && runtime.budget.limits.outputUsdPerMTok != null;
  return {
    inputTokens: runtime.budget.inputTokens, outputTokens: runtime.budget.outputTokens,
    costUsd: priced ? Math.round(runtime.budget.costUsd * 1e6) / 1e6 : null,
    // A call the budget refused never reached the model and is not counted.
    calls: (before.calls ?? 0) + runtime.calls.filter((c) => c.ok || !c.error?.includes('budget for this run is used up')).length,
  };
}

const ACTIVE = [...ACTIVE_IMPORT_STATUSES];

/** Records the step and queues the next one, in this job's transaction; nothing happens if the run was cancelled meanwhile. */
async function save(ctx: Ctx, run: Run, stage: ImportStage, s: Step, usage: ImportUsage, runtime: AiRuntime | null) {
  const done = s.next === 'done';
  const at = done ? { stage, cursor: 0 } : (s.next as { stage: ImportStage; cursor: number });
  // `read` past its last document moves to the extract stage through plan(): the cursor then points past the end.
  const progress = { ...(run.progress as ImportProgress), ...s.progress, stage: at.stage, cursor: at.cursor };
  const [row] = await ctx.tx.update(importRun).set({
    stage: at.stage, progress, usage, report: { ...(run.report as Report), ...s.report }, ...(runtime ? { model: runtime.config.model } : {}),
    status: done ? 'succeeded' : 'running', ...(done ? { finishedAt: new Date(), error: null } : {}),
  }).where(and(eq(importRun.id, run.id), inArray(importRun.status, ACTIVE))).returning({ id: importRun.id });
  if (row && !done) await enqueueJob(ctx, { type: 'import', payload: { runId: run.id, stage: at.stage, cursor: at.cursor }, ...(s.delaySeconds ? { delaySeconds: s.delaySeconds } : {}) });
  return !!row;
}

async function fail(ctx: Ctx, run: Run, reason: string, usage: ImportUsage | null, extra: Partial<Report> = {}) {
  await ctx.tx.update(importRun).set({
    status: 'failed', error: reason.slice(0, 1000), finishedAt: new Date(), report: { ...(run.report as Report), ...extra }, ...(usage ? { usage } : {}),
  }).where(and(eq(importRun.id, run.id), inArray(importRun.status, ACTIVE)));
}

async function attemptsOfThisJob(ctx: Ctx) {
  const [row] = await ctx.tx.select({ attempts: job.attempts }).from(job).where(eq(job.id, ctx.caller.requestId));
  return row?.attempts ?? MAX_IMPORT_ATTEMPTS;
}

/** The `import` job handler. */
export async function importJob(ctx: Ctx, payload: Record<string, unknown>) {
  const p = PayloadSchema.parse(payload);
  const run = await getRunRow(ctx, p.runId);
  const base = { runId: run.id, stage: p.stage, cursor: p.cursor };
  if (run.status === 'cancelled') {
    // What was found before the person pressed Cancel is kept: checked and released like any other (no model call).
    await step(ctx, async () => { await verifyCandidates(ctx, run); await releaseCandidates(ctx, run); });
    return { ...base, skipped: 'the run is cancelled' };
  }
  if (!ACTIVE.includes(run.status as (typeof ACTIVE)[number])) return { ...base, skipped: `the run is ${run.status}` };
  const progress = run.progress as ImportProgress;
  if (run.stage !== p.stage || (progress.cursor ?? 0) !== p.cursor) return { ...base, skipped: 'the run has moved on' };
  const before = run.usage as ImportUsage;

  let runtime: AiRuntime;
  try {
    runtime = await loadAiRuntime(ctx);
  } catch (e) {
    if (e instanceof AiDisabledError || e instanceof AiNotConfiguredError) { await fail(ctx, run, e.message, null); return { ...base, failed: true, error: e.message }; }
    throw e;
  }
  seedBudget(runtime, before);
  const report = run.report as Report;
  try {
    const s = await step(ctx, () => STEPS[p.stage](ctx, run, p.cursor, runtime, report));
    const kept = await save(ctx, run, p.stage, s, usageOf(runtime, before), runtime);
    if (!kept) { await step(ctx, async () => { await verifyCandidates(ctx, run); await releaseCandidates(ctx, run); }); return { ...base, skipped: 'the run was cancelled meanwhile', ai: runtime.calls }; }
    return { ...base, next: s.next, ai: runtime.calls };
  } catch (e) {
    const usage = usageOf(runtime, before);
    if (e instanceof BudgetExceeded && p.stage === 'extract') {
      // The spend limit ends the reading, not the work already done: what the windows so far proposed is checked and released, and
      // the run ends failed with the reason (partial proposals are kept).
      const s: Step = { next: { stage: 'verify', cursor: 0 }, report: { stoppedBy: 'budget', stoppedMessage: e.message } };
      await save(ctx, run, p.stage, s, usage, runtime);
      return { ...base, next: s.next, stopped: e.message, ai: runtime.calls };
    }
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof ImportStop || e instanceof BudgetExceeded || e instanceof AiDisabledError || e instanceof AiNotConfiguredError || (e instanceof AiCallError && !e.retryable) || (await attemptsOfThisJob(ctx)) >= MAX_IMPORT_ATTEMPTS) {
      const stoppedBy = e instanceof BudgetExceeded || report.stoppedBy === 'budget' ? 'budget' : 'error';
      // At the spend limit anything already proposed is still released; otherwise a failed run shows nothing half-done.
      if (e instanceof BudgetExceeded) await step(ctx, async () => { await verifyCandidates(ctx, run); await releaseCandidates(ctx, run); }).catch(() => undefined);
      await fail(ctx, run, message, usage, { stoppedBy, stoppedMessage: report.stoppedMessage ?? message });
      return { ...base, failed: true, error: message, ai: runtime.calls };
    }
    throw e; // the queue tries this step again; the run stays where it was
  }
}
