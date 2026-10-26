// Starting, following and cancelling a framework analysis (PRD 15, step C). The work itself is done by the `analyse` job
// (stages.ts), one small job per stage step; these services only queue it and report on it.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { analysisRun, sourceDocument } from '@ams/db';
import { ACTIVE_ANALYSIS_STATUSES } from '@ams/shared';
import type { Ctx } from '../../ctx.js';
import { ConflictError, NotFoundError } from '../../ctx.js';
import { aiReadiness } from '../../ai/settings.js';
import { enqueueJob } from '../../jobs/jobs.js';
import { assertHuman, getDraftVersion, getVersion, isInternalVersion, require_ } from '../common.js';
import { guardIntegrity } from '../errors.js';
import { analysisPrompts } from './schemas.js';

export async function getAnalysisRunRow(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(analysisRun).where(eq(analysisRun.id, id));
  if (!row) throw new NotFoundError(`analysis run ${id}`);
  return row;
}

/**
 * Starts analysing a draft version's sources — an external standard's, or the internal quality framework's own documents
 * (TASK-107). Refused unless the version is a draft, AI is switched on and set up (Settings -> AI), the version has
 * sources with a file or page text, and no run is active.
 */
export async function startAnalysis(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const v = await getDraftVersion(ctx, versionId);
  if (v.status !== 'draft') throw new ConflictError(`only a draft version can be analysed (this one is ${v.status})`);
  const internal = await isInternalVersion(ctx, versionId);
  const [src] = await ctx.tx.select({
    n: sql<number>`count(*)::int`,
    usable: sql<number>`count(*) filter (where source_document.file_name is not null or exists (select 1 from source_page p where p.source_document_id = source_document.id))::int`,
  }).from(sourceDocument).where(eq(sourceDocument.frameworkVersionId, versionId));
  if (!src?.n) throw new ConflictError(internal ? 'add the institution\'s documents under Docs first' : 'add the accreditor\'s documents under Sources first');
  if (!src.usable) throw new ConflictError('upload a source file or type in its pages first; there is nothing to analyse');
  const ready = await aiReadiness(ctx);
  if (!ready.ok) throw new ConflictError(ready.reason);
  const [active] = await ctx.tx.select({ id: analysisRun.id }).from(analysisRun)
    .where(and(eq(analysisRun.frameworkVersionId, versionId), inArray(analysisRun.status, [...ACTIVE_ANALYSIS_STATUSES])));
  if (active) throw new ConflictError('an analysis of this version is already running');

  const [row] = await guardIntegrity(() => ctx.tx.insert(analysisRun).values({
    institutionId: ctx.caller.institutionId, frameworkVersionId: versionId, status: 'queued', stage: 'read',
    progress: { stage: 'read', cursor: 0 }, promptVersions: analysisPrompts(internal), startedBy: ctx.caller.userId, startedAt: new Date(),
  }).returning());
  const run = row!;
  await enqueueJob(ctx, { type: 'analyse', payload: { runId: run.id, stage: 'read', cursor: 0 } });
  return run;
}

/** A version's runs, newest first. */
export async function listAnalysisRuns(ctx: Ctx, versionId: string) {
  await require_(ctx, 'framework:read');
  await getVersion(ctx, versionId);
  return ctx.tx.select().from(analysisRun).where(eq(analysisRun.frameworkVersionId, versionId)).orderBy(desc(analysisRun.createdAt)).limit(20);
}

export async function getAnalysisRun(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:read');
  return getAnalysisRunRow(ctx, id);
}

/**
 * Stops a queued or running analysis. The job in flight finishes its own step and then stops; what was written so far
 * stays in the draft (it is all marked as AI-made, with its source).
 */
export async function cancelAnalysis(ctx: Ctx, id: string) {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const run = await getAnalysisRunRow(ctx, id);
  if (!(ACTIVE_ANALYSIS_STATUSES as readonly string[]).includes(run.status)) throw new ConflictError(`the analysis has already ended (${run.status})`);
  const [row] = await ctx.tx.update(analysisRun).set({ status: 'cancelled', finishedAt: new Date(), error: 'cancelled by a person' })
    .where(and(eq(analysisRun.id, id), inArray(analysisRun.status, [...ACTIVE_ANALYSIS_STATUSES]))).returning();
  if (!row) throw new ConflictError('the analysis has already ended');
  return row;
}
