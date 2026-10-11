// The `analyse` job: one small step of a framework analysis run per job, each in its own transaction so progress shows,
// each queuing the next. The run row holds the stage and the position inside it (progress.cursor); a job whose stage and
// cursor no longer match the run does nothing, so a retried or duplicated job is harmless and a crashed one resumes.
//
//   read      one source per job: reads its file into pages (step A, inline) when it has no page text yet
//   survey    one source per job: the AI proposes its role, language and outline
//   structure one job: the AI proposes the level names, numbering, key terms and scope across the sources
//   extract   one window of ~8 pages (1 page overlap) per job: the AI proposes requirements and notes (Appendix B)
//   gaps      one job per round (cursor = the round about to be asked): the deterministic gap finder (gaps.ts) over all
//             proposals so far; plans the round's narrow questions, or stops (recovery.ts)
//   recover   one question group per job (cursor = its index in the round): a targeted aiExtract (recover.v1) on a few
//             pages; what it brings back is logged like the extraction's and goes through the same checks and merge
//   write     one job: deterministic checks, merge, parents by code, upsert into the draft (write.ts)
//   embed, map, propose_new   the IQF mapping (step E, mapping-stages.ts): suggested links and suggested new IQF items
//   finalise  one job: counts, and the run succeeds
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { analysisRun, extractionItem, frameworkVersion, job, requirement, sourceDocument, sourcePage } from '@ams/db';
import { ACTIVE_ANALYSIS_STATUSES, ANALYSIS_STAGES, type AnalysisGap, type AnalysisProgress, type AnalysisStage, type AnalysisStats, type AnalysisUsage } from '@ams/shared';
import { z } from 'zod';
import type { Ctx } from '../../ctx.js';
import { AiDisabledError, AiNotConfiguredError, aiExtract, aiOcr, BudgetExceeded, type AiRuntime } from '../../ai/index.js';
import { loadAiRuntime, maxRecoveryRounds } from '../../ai/settings.js';
import { enqueueJob } from '../../jobs/jobs.js';
import { getVersion } from '../common.js';
import { extractText } from '../reading.js';
import { formatPages, NOTE_ROLES, pageWindows, REQUIREMENT_ROLES, type DocInfo } from './merge.js';
import { findGaps } from './gaps.js';
import { gapCounts, planTasks, reconcileGaps, type RecoveryState, type RecoveryStop } from './recovery.js';
import { getAnalysisRunRow } from './runs.js';
import { ANALYSIS_PROMPTS, ExtractSchema, RecoverSchema, StructureSchema, SURVEY_ROLE_TO_DOCUMENT_ROLE, SurveySchema, type Structure } from './schemas.js';
import { isMappingStage, MAPPING_STEPS, mappingBudgetStop } from './mapping-stages.js';
import { loadRunState, writeAnalysis } from './write.js';
import { normalizeCode } from './merge.js';

const PayloadSchema = z.object({ runId: z.uuid(), stage: z.enum(ANALYSIS_STAGES), cursor: z.number().int().min(0).default(0) });

/** The queue retries a failed job 3 times (pgboss-queue.ts): after the 4th attempt the run is marked failed. */
export const MAX_ANALYSIS_ATTEMPTS = 4;
/** Window size and overlap (PRD 15.1). */
export const WINDOW_PAGES = 8;
export const WINDOW_OVERLAP = 1;
/** Recovery answers are logged with window numbers from here up (round, question group, question), apart from the extraction's. */
export const RECOVERY_WINDOW_BASE = 1_000_000;

type Run = typeof analysisRun.$inferSelect;
interface SurveyEntry { title: string; proposedRole: string; role: string; roleApplied: boolean; language: string; outline: { heading: string; page?: number | null }[]; confidence: number | null }
interface Window { documentId: string; pages: number[] }
interface Report {
  survey?: Record<string, SurveyEntry>;
  structure?: Structure & { levelLabelsApplied: string[] | null };
  plan?: { windows: Window[] };
  readErrors?: Record<string, string>;
  stats?: AnalysisStats;
  /** Step D: every gap found, with where it ended up, and the state of the recovery rounds. */
  gaps?: AnalysisGap[];
  recovery?: RecoveryState;
  [k: string]: unknown;
}
type Next = { stage: AnalysisStage; cursor: number } | 'done';
interface Step { next: Next; progress?: Partial<AnalysisProgress>; report?: Partial<Report> }

/** Ends the run as failed with this reason; not retried (trying again would not help). */
class AnalysisStop extends Error {}

/** A savepoint: a failed step leaves no half-written rows, and the run can still be marked failed in the same job. */
async function step<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  await ctx.tx.execute(sql`savepoint analysis_step`);
  try {
    const out = await fn();
    await ctx.tx.execute(sql`release savepoint analysis_step`);
    return out;
  } catch (e) {
    await ctx.tx.execute(sql`rollback to savepoint analysis_step`);
    throw e;
  }
}

/** The version's sources in a fixed order, with how many pages of text each has. */
async function sources(ctx: Ctx, versionId: string) {
  return ctx.tx.select({
    id: sourceDocument.id, title: sourceDocument.title, role: sourceDocument.role, roleOrigin: sourceDocument.roleOrigin,
    language: sourceDocument.language, fileName: sourceDocument.fileName,
    pages: sql<number>`(select count(*)::int from source_page p where p.source_document_id = source_document.id)`,
  }).from(sourceDocument).where(eq(sourceDocument.frameworkVersionId, versionId)).orderBy(asc(sourceDocument.createdAt), asc(sourceDocument.title), asc(sourceDocument.id));
}

async function pagesOf(ctx: Ctx, documentId: string, only?: number[]) {
  return ctx.tx.select({ pageNo: sourcePage.pageNo, text: sourcePage.text }).from(sourcePage)
    .where(and(eq(sourcePage.sourceDocumentId, documentId), only ? inArray(sourcePage.pageNo, only) : undefined))
    .orderBy(asc(sourcePage.pageNo));
}

/** Role and language in force for the run: a person's choice first, then the survey's. */
function docInfo(docs: Awaited<ReturnType<typeof sources>>, report: Report): Map<string, DocInfo> {
  return new Map(docs.map((d) => [d.id, { role: d.role, language: report.survey?.[d.id]?.language ?? d.language }]));
}

// ---- The steps ---------------------------------------------------------------------------------------------------

async function read(ctx: Ctx, run: Run, cursor: number, runtime: AiRuntime, report: Report): Promise<Step> {
  const docs = await sources(ctx, run.frameworkVersionId);
  const d = docs[cursor];
  const after = (extra: Partial<Report> = {}): Step => ({
    next: cursor + 1 < docs.length ? { stage: 'read', cursor: cursor + 1 } : { stage: 'survey', cursor: 0 },
    progress: { docsTotal: docs.length, docsDone: Math.min(cursor + 1, docs.length) }, report: extra,
  });
  if (!d || d.pages > 0 || !d.fileName) return after();
  // Step A inline: scanned pages are read by the AI under this run's budget.
  const r = await extractText(ctx, { sourceDocumentId: d.id }, { ocrPage: async (p) => (await aiOcr({ image: p.image, lang: p.language, runtime })).text });
  return after(r.ok ? {} : { readErrors: { ...report.readErrors, [d.id]: r.error ?? 'the file could not be read' } });
}

const SURVEY_PAGES = 30;
const SURVEY_CHARS = 1200;

async function survey(ctx: Ctx, run: Run, cursor: number, runtime: AiRuntime, report: Report): Promise<Step> {
  const docs = (await sources(ctx, run.frameworkVersionId)).filter((d) => d.pages > 0);
  if (!docs.length) throw new AnalysisStop('no source has page text: upload the files, or type in their pages, and analyse again');
  const d = docs[cursor];
  if (!d) return { next: { stage: 'structure', cursor: 0 } };
  const pages = (await pagesOf(ctx, d.id)).slice(0, SURVEY_PAGES);
  const input = [`Document: ${d.title}`, `Pages: ${d.pages}${d.pages > SURVEY_PAGES ? ` (the first ${SURVEY_PAGES} are shown)` : ''}`, '', formatPages(pages, SURVEY_CHARS)].join('\n');
  const { data } = await aiExtract({ task: 'survey', promptVersion: ANALYSIS_PROMPTS.survey, input, schema: SurveySchema, runtime });
  const proposed = SURVEY_ROLE_TO_DOCUMENT_ROLE[data.role];
  // The survey decides the role only where no person has: a role a person chose is never replaced.
  const apply = d.roleOrigin !== 'manual';
  if (apply && (d.role !== proposed || d.roleOrigin !== 'ai')) {
    await ctx.tx.update(sourceDocument).set({ role: proposed, roleOrigin: 'ai' }).where(eq(sourceDocument.id, d.id));
  }
  const entry: SurveyEntry = {
    title: d.title, proposedRole: proposed, role: apply ? proposed : d.role, roleApplied: apply, language: data.language.toLowerCase(),
    outline: data.outline.slice(0, 60), confidence: data.confidence ?? null,
  };
  return {
    next: cursor + 1 < docs.length ? { stage: 'survey', cursor: cursor + 1 } : { stage: 'structure', cursor: 0 },
    progress: { docsTotal: docs.length, docsDone: cursor + 1 },
    report: { survey: { ...report.survey, [d.id]: entry } },
  };
}

const STRUCTURE_PAGES = 4;
const STRUCTURE_CHARS = 3000;

async function structure(ctx: Ctx, run: Run, _cursor: number, runtime: AiRuntime, report: Report): Promise<Step> {
  const docs = (await sources(ctx, run.frameworkVersionId)).filter((d) => d.pages > 0);
  const parts: string[] = ['Documents:'];
  for (const d of docs) {
    const s = report.survey?.[d.id];
    parts.push(`- "${d.title}" (role: ${d.role}, language: ${s?.language ?? d.language}, ${d.pages} pages)`);
    for (const o of s?.outline ?? []) parts.push(`    ${o.heading}${o.page ? ` (page ${o.page})` : ''}`);
  }
  for (const d of docs.filter((x) => REQUIREMENT_ROLES.has(x.role))) {
    parts.push('', `Excerpt of "${d.title}":`, formatPages((await pagesOf(ctx, d.id)).slice(0, STRUCTURE_PAGES), STRUCTURE_CHARS));
  }
  const { data } = await aiExtract({ task: 'structure', promptVersion: ANALYSIS_PROMPTS.structure, input: parts.join('\n'), schema: StructureSchema, runtime });

  // Level names apply to the draft at once (the owner's decision), unless a person has named the levels differently
  // since: they keep theirs when the current names are neither empty nor what an earlier run set.
  const [v] = await ctx.tx.select({ levelLabels: frameworkVersion.levelLabels }).from(frameworkVersion).where(eq(frameworkVersion.id, run.frameworkVersionId));
  const current = ((v?.levelLabels as string[] | undefined) ?? []);
  const [prev] = await ctx.tx.select({ report: analysisRun.report }).from(analysisRun)
    .where(and(eq(analysisRun.frameworkVersionId, run.frameworkVersionId), ne(analysisRun.id, run.id), sql`${analysisRun.report} -> 'structure' -> 'levelLabelsApplied' <> 'null'::jsonb`))
    .orderBy(desc(analysisRun.createdAt)).limit(1);
  const previouslySet = ((prev?.report as Report | undefined)?.structure?.levelLabelsApplied ?? null);
  const same = (a: string[], b: string[] | null) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  let applied: string[] | null = null;
  if (data.level_labels.length && (current.length === 0 || same(current, previouslySet))) {
    await ctx.tx.update(frameworkVersion).set({ levelLabels: data.level_labels }).where(eq(frameworkVersion.id, run.frameworkVersionId));
    applied = data.level_labels;
  }

  const windows: Window[] = [];
  // The documents that state the requirements first, then those that only add notes to them.
  const planned = [...docs.filter((x) => REQUIREMENT_ROLES.has(x.role)), ...docs.filter((x) => !REQUIREMENT_ROLES.has(x.role) && NOTE_ROLES.has(x.role))];
  for (const d of planned) {
    for (const w of pageWindows((await pagesOf(ctx, d.id)).map((p) => p.pageNo), WINDOW_PAGES, WINDOW_OVERLAP)) windows.push({ documentId: d.id, pages: w });
  }
  return {
    next: windows.length ? { stage: 'extract', cursor: 0 } : { stage: 'write', cursor: 0 },
    progress: { windowsTotal: windows.length, windowsDone: 0, items: 0 },
    report: { structure: { ...data, levelLabelsApplied: applied }, plan: { windows } },
  };
}

async function extract(ctx: Ctx, run: Run, cursor: number, runtime: AiRuntime, report: Report): Promise<Step> {
  const windows = report.plan?.windows ?? [];
  const w = windows[cursor];
  const progress = run.progress as AnalysisProgress;
  if (!w) return { next: { stage: 'write', cursor: 0 } };
  const [doc] = await ctx.tx.select().from(sourceDocument).where(eq(sourceDocument.id, w.documentId));
  const pages = await pagesOf(ctx, w.documentId, w.pages);
  const header = [...docHeader(doc, w.documentId, report), `This window: pages ${w.pages[0]} to ${w.pages[w.pages.length - 1]}.`].join('\n');
  const { data } = await aiExtract({ task: 'extract', promptVersion: ANALYSIS_PROMPTS.extract, input: `${header}\n\n${formatPages(pages)}`, schema: ExtractSchema, runtime });

  // The raw answer is kept item by item for the record; the write stage reads it back from here.
  const rows = data.items.map((item, i) => ({
    institutionId: ctx.caller.institutionId, frameworkVersionId: run.frameworkVersionId, jobId: ctx.caller.requestId, analysisRunId: run.id,
    kind: item.kind, payload: { item, documentId: w.documentId, window: cursor, seq: cursor * 10_000 + i },
    sourceDocumentId: w.documentId, sourcePage: item.source.page, sourceQuote: item.source.quote, confidence: item.confidence ?? null, flags: item.flags,
  }));
  if (rows.length) await ctx.tx.insert(extractionItem).values(rows);
  return {
    next: cursor + 1 < windows.length ? { stage: 'extract', cursor: cursor + 1 } : { stage: 'gaps', cursor: 1 },
    progress: { windowsTotal: windows.length, windowsDone: cursor + 1, items: (progress.items ?? 0) + rows.length },
  };
}

/** What every extraction and recovery call is told about the document. */
function docHeader(doc: { title: string; role: string; language: string } | undefined, documentId: string, report: Report): string[] {
  const s = report.structure;
  return [
    `Document: ${doc?.title ?? ''}`,
    `Role: ${doc?.role ?? 'other'}${doc && !REQUIREMENT_ROLES.has(doc.role) ? ' (take notes only: this document does not state the requirements)' : ''}`,
    `Language: ${report.survey?.[documentId]?.language ?? doc?.language ?? 'en'}`,
    `Level names, top first: ${s?.level_labels.length ? s.level_labels.join(' > ') : 'not known'}`,
    ...(s?.numbering.length ? ['Numbering examples:', ...s.numbering.map((n) => `- ${n.level_label}: ${n.examples.join(', ')}`)] : []),
  ];
}

/**
 * Step D, the check: runs the gap finder over everything proposed so far, reconciles it with the gaps on record, and
 * plans the next round of questions, or stops (no gaps, nothing to ask, the round limit, a round that found nothing
 * new, or the spend limit). The cursor is the round about to be asked; no model call is made here.
 */
async function gaps(ctx: Ctx, run: Run, cursor: number, _runtime: AiRuntime, report: Report): Promise<Step> {
  const round = Math.max(1, cursor);
  const docs = await sources(ctx, run.frameworkVersionId);
  const info = docInfo(docs, report);
  const state = await loadRunState(ctx, run, info, docs.filter((d) => REQUIREMENT_ROLES.has(d.role)).map((d) => d.id));
  // A person's rows are theirs: their codes count as known, and they are never asked about again.
  const locked = new Set(state.existing.filter((r) => r.origin !== 'ai' || r.editedByPerson || r.reviewStatus !== 'pending').map((r) => normalizeCode(r.code)));
  const found = findGaps({
    merged: state.merged, raw: state.raw, pages: state.pages, docs: info, numbering: report.structure?.numbering,
    knownCodes: new Set([...state.byCode.keys(), ...state.dismissed.requirements]), lockedCodes: locked,
    coveredPages: state.dismissedRaw.map((r) => ({ documentId: r.documentId, page: r.item.source.page })),
  });
  const rec: RecoveryState = report.recovery ?? { maxRounds: await maxRecoveryRounds(ctx), round: 0, tasks: [], rounds: [], progressMark: -1, stopped: null };
  const all = reconcileGaps(report.gaps ?? [], found, round - 1);
  const mark = state.merged.requirements.filter((r) => r.quoteVerified).length + state.merged.notes.filter((n) => n.quoteVerified).length
    + all.filter((g) => g.status === 'confirmed_absent').length;
  const openKeys = new Set(all.filter((g) => g.status === 'open').map((g) => g.key));
  let stop: RecoveryStop | null = rec.stopped ?? (!openKeys.size ? 'no_gaps' : round > rec.maxRounds ? 'max_rounds' : round > 1 && mark <= rec.progressMark ? 'nothing_new' : null);
  const tasks = stop ? [] : planTasks(found.filter((f) => openKeys.has(f.key)));
  if (!stop && !tasks.length) stop = 'nothing_to_ask';
  const progress = { round: stop ? round - 1 : round, maxRounds: rec.maxRounds, gapsOpen: stop ? 0 : openKeys.size, tasksTotal: tasks.length, tasksDone: 0 };
  if (stop) {
    // Whatever is still open stays so: unresolved, for a person to look at.
    const final = all.map((g) => (g.status === 'open' ? { ...g, status: 'unresolved' as const, round: round - 1 } : g));
    return { next: { stage: 'write', cursor: 0 }, progress, report: { gaps: final, recovery: { ...rec, tasks: [], progressMark: mark, stopped: stop } } };
  }
  const questions = tasks.reduce((n, t) => n + t.questions.length, 0);
  return {
    next: { stage: 'recover', cursor: 0 }, progress,
    report: {
      gaps: all,
      recovery: { ...rec, round, tasks, progressMark: mark, rounds: [...rec.rounds, { round, open: openKeys.size, tasks: tasks.length, questions, itemsLogged: 0, confirmedAbsent: 0 }] },
    },
  };
}

/**
 * Step D, the recovery: one group of narrow questions about the same few pages, in one model call. Items it brings back
 * are logged like the extraction's (the next gaps stage and the writer check and merge them); a question the model
 * answers "not there" closes its gap as confirmed absent, with the model's reason, and it is not asked again.
 */
async function recover(ctx: Ctx, run: Run, cursor: number, runtime: AiRuntime, report: Report): Promise<Step> {
  const rec = report.recovery;
  const task = rec?.tasks[cursor];
  if (!rec || !task) return { next: { stage: 'gaps', cursor: (rec?.round ?? 0) + 1 } };
  const [doc] = await ctx.tx.select().from(sourceDocument).where(eq(sourceDocument.id, task.documentId));
  const pages = await pagesOf(ctx, task.documentId, task.pages);
  const input = [
    ...docHeader(doc, task.documentId, report),
    `These pages: ${task.pages[0]} to ${task.pages[task.pages.length - 1]}.`,
    '', formatPages(pages), '',
    'Questions:', ...task.questions.map((q) => `- id ${q.id}: ${q.text}`),
  ].join('\n');
  const { data } = await aiExtract({ task: 'recover', promptVersion: ANALYSIS_PROMPTS.recover, input, schema: RecoverSchema, runtime });

  const answers = new Map(data.answers.map((a) => [a.id, a]));
  const gapsNow = [...(report.gaps ?? [])];
  const asked = new Set(task.pages);
  const rows: (typeof extractionItem.$inferInsert)[] = [];
  let confirmed = 0;
  task.questions.forEach((q, qi) => {
    const a = answers.get(q.id);
    const gi = gapsNow.findIndex((g) => g.key === q.key);
    if (gi >= 0) gapsNow[gi] = { ...gapsNow[gi]!, attempts: gapsNow[gi]!.attempts + 1, round: rec.round };
    if (!a) return;
    if (!a.found) {
      if (gi >= 0) { gapsNow[gi] = { ...gapsNow[gi]!, status: 'confirmed_absent', reason: a.reason?.trim() || 'not on these pages' }; confirmed++; }
      return;
    }
    const window = RECOVERY_WINDOW_BASE + rec.round * 10_000 + cursor * 10 + qi;
    // Only what is on the pages it was shown is taken (the checks would refuse the rest anyway).
    a.items.filter((item) => asked.has(item.source.page)).forEach((item, k) => rows.push({
      institutionId: ctx.caller.institutionId, frameworkVersionId: run.frameworkVersionId, jobId: ctx.caller.requestId, analysisRunId: run.id,
      kind: item.kind, payload: { item, documentId: task.documentId, window, seq: q.anchorSeq + 0.0001 * (k + 1), round: rec.round, gap: q.key },
      sourceDocumentId: task.documentId, sourcePage: item.source.page, sourceQuote: item.source.quote, confidence: item.confidence ?? null, flags: item.flags,
    }));
  });
  if (rows.length) await ctx.tx.insert(extractionItem).values(rows);
  const rounds = rec.rounds.map((r) => (r.round === rec.round ? { ...r, itemsLogged: r.itemsLogged + rows.length, confirmedAbsent: r.confirmedAbsent + confirmed } : r));
  const progress = run.progress as AnalysisProgress;
  return {
    next: cursor + 1 < rec.tasks.length ? { stage: 'recover', cursor: cursor + 1 } : { stage: 'gaps', cursor: rec.round + 1 },
    progress: { tasksDone: cursor + 1, items: (progress.items ?? 0) + rows.length },
    report: { gaps: gapsNow, recovery: { ...rec, rounds } },
  };
}

async function write(ctx: Ctx, run: Run, _cursor: number, _runtime: AiRuntime, report: Report): Promise<Step> {
  const stats = await writeAnalysis(ctx, run, docInfo(await sources(ctx, run.frameworkVersionId), report));
  if (!report.recovery) return { next: { stage: 'embed', cursor: 0 }, report: { stats } };
  // Each gap links to the requirement card it is about, now that the rows exist.
  const ids = new Map((await ctx.tx.select({ id: requirement.id, code: requirement.code }).from(requirement).where(eq(requirement.frameworkVersionId, run.frameworkVersionId)))
    .map((r) => [normalizeCode(r.code), r.id]));
  const gapList = (report.gaps ?? []).map((g) => ({ ...g, requirementId: g.code ? ids.get(normalizeCode(g.code)) ?? null : null }));
  return {
    next: { stage: 'embed', cursor: 0 },
    report: { stats: { ...stats, ...gapCounts(gapList), recoveryRounds: report.recovery.rounds.length }, gaps: gapList },
  };
}

async function pagesRead(ctx: Ctx, run: Run) {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(sourcePage)
    .innerJoin(sourceDocument, eq(sourceDocument.id, sourcePage.sourceDocumentId)).where(eq(sourceDocument.frameworkVersionId, run.frameworkVersionId));
  return r?.n ?? 0;
}

async function finalise(ctx: Ctx, run: Run, _cursor: number, _runtime: AiRuntime, report: Report): Promise<Step> {
  const stats = report.stats ? { ...report.stats, pagesRead: await pagesRead(ctx, run) } : undefined;
  return { next: 'done', ...(stats ? { report: { stats } } : {}) };
}

const STEPS: Record<AnalysisStage, (ctx: Ctx, run: Run, cursor: number, runtime: AiRuntime, report: Report) => Promise<Step>> = {
  read, survey, structure, extract, gaps, recover, write, ...MAPPING_STEPS, finalise,
};

// ---- Bookkeeping ---------------------------------------------------------------------------------------------------

/** The run's spend so far, carried into this job's budget so the per-run limit covers all of its jobs. */
function seedBudget(runtime: AiRuntime, usage: AnalysisUsage) {
  runtime.budget.inputTokens = usage.inputTokens ?? 0;
  runtime.budget.outputTokens = usage.outputTokens ?? 0;
  runtime.budget.costUsd = usage.costUsd ?? 0;
}
function usageOf(runtime: AiRuntime, before: AnalysisUsage): AnalysisUsage {
  const priced = runtime.budget.limits.inputUsdPerMTok != null && runtime.budget.limits.outputUsdPerMTok != null;
  return {
    inputTokens: runtime.budget.inputTokens, outputTokens: runtime.budget.outputTokens,
    costUsd: priced ? Math.round(runtime.budget.costUsd * 1e6) / 1e6 : null,
    // A call the budget refused never reached the model and is not counted.
    calls: (before.calls ?? 0) + runtime.calls.filter((c) => c.ok || !c.error?.includes('budget for this run is used up')).length,
  };
}

const ACTIVE = [...ACTIVE_ANALYSIS_STATUSES];

/** Records the step and queues the next one, in this job's transaction; nothing happens if the run was cancelled meanwhile. */
async function save(ctx: Ctx, run: Run, stage: AnalysisStage, s: Step, usage: AnalysisUsage, model: string) {
  const report = { ...(run.report as Report), ...s.report };
  const done = s.next === 'done';
  const at = done ? { stage, cursor: 0 } : (s.next as { stage: AnalysisStage; cursor: number });
  const progress = { ...(run.progress as AnalysisProgress), ...s.progress, stage: at.stage, cursor: at.cursor };
  const [row] = await ctx.tx.update(analysisRun).set({
    stage: at.stage, progress, usage, report, model, status: done ? 'succeeded' : 'running', ...(done ? { finishedAt: new Date(), error: null } : {}),
  }).where(and(eq(analysisRun.id, run.id), inArray(analysisRun.status, ACTIVE))).returning({ id: analysisRun.id });
  if (row && !done) await enqueueJob(ctx, { type: 'analyse', payload: { runId: run.id, stage: at.stage, cursor: at.cursor } });
  return !!row;
}

async function fail(ctx: Ctx, run: Run, reason: string, usage: AnalysisUsage | null, extra: Partial<Report> = {}) {
  await ctx.tx.update(analysisRun).set({
    status: 'failed', error: reason.slice(0, 1000), finishedAt: new Date(), report: { ...(run.report as Report), ...extra }, ...(usage ? { usage } : {}),
  }).where(and(eq(analysisRun.id, run.id), inArray(analysisRun.status, ACTIVE)));
}

async function attemptsOfThisJob(ctx: Ctx) {
  const [row] = await ctx.tx.select({ attempts: job.attempts }).from(job).where(eq(job.id, ctx.caller.requestId));
  return row?.attempts ?? MAX_ANALYSIS_ATTEMPTS;
}

/** The `analyse` job handler. */
export async function analyseJob(ctx: Ctx, payload: Record<string, unknown>) {
  const p = PayloadSchema.parse(payload);
  const run = await getAnalysisRunRow(ctx, p.runId);
  const base = { runId: run.id, stage: p.stage, cursor: p.cursor };
  if (!ACTIVE.includes(run.status as (typeof ACTIVE)[number])) return { ...base, skipped: `the run is ${run.status}` };
  const progress = run.progress as AnalysisProgress;
  if (run.stage !== p.stage || (progress.cursor ?? 0) !== p.cursor) return { ...base, skipped: 'the run has moved on' };
  const before = run.usage as AnalysisUsage;
  const version = await getVersion(ctx, run.frameworkVersionId);
  if (version.status !== 'draft') {
    await fail(ctx, run, `the version is ${version.status}: an analysis writes only into a draft`, null);
    return { ...base, failed: true };
  }

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
    await save(ctx, run, p.stage, s, usageOf(runtime, before), runtime.config.model);
    return { ...base, next: s.next, ai: runtime.calls };
  } catch (e) {
    const usage = usageOf(runtime, before);
    if (e instanceof BudgetExceeded && p.stage === 'recover') {
      // The spend limit ends the recovery, not the run: the last check closes the round and everything is written.
      const s: Step = { next: { stage: 'gaps', cursor: (report.recovery?.round ?? 0) + 1 }, report: { recovery: { ...report.recovery!, stopped: 'budget' } } };
      await save(ctx, run, p.stage, s, usage, runtime.config.model);
      return { ...base, next: s.next, stopped: e.message, ai: runtime.calls };
    }
    if (e instanceof BudgetExceeded && isMappingStage(p.stage)) {
      // The spend limit ends the mapping, not the run: the requirements are written and the suggestions so far stay.
      const s = mappingBudgetStop(report);
      await save(ctx, run, p.stage, s, usage, runtime.config.model);
      return { ...base, next: s.next, stopped: e.message, ai: runtime.calls };
    }
    if (e instanceof BudgetExceeded) {
      // The budget stops the run; what the windows so far proposed is still checked and written (partial results kept).
      let stats: AnalysisStats | undefined;
      try {
        stats = await step(ctx, async () => writeAnalysis(ctx, run, docInfo(await sources(ctx, run.frameworkVersionId), report)).then(async (st) => ({ ...st, pagesRead: await pagesRead(ctx, run) })));
      } catch { /* nothing more can be kept */ }
      await fail(ctx, run, e.message, usage, stats ? { stats, stoppedAt: { stage: p.stage, cursor: p.cursor } } : { stoppedAt: { stage: p.stage, cursor: p.cursor } });
      return { ...base, failed: true, error: e.message, ai: runtime.calls };
    }
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof AnalysisStop || e instanceof AiDisabledError || e instanceof AiNotConfiguredError || (await attemptsOfThisJob(ctx)) >= MAX_ANALYSIS_ATTEMPTS) {
      await fail(ctx, run, message, usage);
      return { ...base, failed: true, error: message, ai: runtime.calls };
    }
    throw e; // the queue tries this step again; the run stays where it was
  }
}
