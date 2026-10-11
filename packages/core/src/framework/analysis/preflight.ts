// Can an analysis run start now? A checklist (never a model call, never a key) so the button can say why not before
// anyone clicks it. `startAnalysis` keeps its own hard checks; this only reports them early, with where to fix each.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { analysisRun, sourceDocument, sourcePage } from '@ams/db';
import { ACTIVE_ANALYSIS_STATUSES, type Preflight, type PreflightCheck } from '@ams/shared';
import type { Ctx } from '../../ctx.js';
import { aiPreflightChecks } from '../../ai/settings.js';
import { getVersion, isInternalVersion, require_ } from '../common.js';

export async function analysisPreflight(ctx: Ctx, versionId: string): Promise<Preflight> {
  await require_(ctx, 'framework:write');
  const v = await getVersion(ctx, versionId);
  const checks: PreflightCheck[] = [];
  const internal = await isInternalVersion(ctx, versionId);

  if (internal) checks.push({ id: 'draft', status: 'problem', message: 'The internal quality framework is not analysed from sources.', fix: null });
  else if (v.status !== 'draft') checks.push({ id: 'draft', status: 'problem', message: `Only a draft can be analysed (this version is ${v.status.replace('_', ' ')}). Start a new version to analyse again.`, fix: { label: 'Start a new version', where: 'version' } });
  else checks.push({ id: 'draft', status: 'ok', message: 'This version is a draft.', fix: null });

  const [src] = await ctx.tx.select({
    n: sql<number>`count(*)::int`,
    usable: sql<number>`count(*) filter (where source_document.file_name is not null or exists (select 1 from source_page p where p.source_document_id = source_document.id))::int`,
  }).from(sourceDocument).where(eq(sourceDocument.frameworkVersionId, versionId));
  if (!src?.n) checks.push({ id: 'sources', status: 'problem', message: 'Add the accreditor\'s documents under Sources first.', fix: { label: 'Add sources', where: 'sources' } });
  else if (!src.usable) checks.push({ id: 'sources', status: 'problem', message: 'Upload a source file or type in its pages first; there is nothing to read yet.', fix: { label: 'Open Sources', where: 'sources' } });
  else checks.push({ id: 'sources', status: 'ok', message: `${src.n} ${src.n === 1 ? 'source' : 'sources'} to read.`, fix: null });

  const [active] = await ctx.tx.select({ id: analysisRun.id }).from(analysisRun)
    .where(and(eq(analysisRun.frameworkVersionId, versionId), inArray(analysisRun.status, [...ACTIVE_ANALYSIS_STATUSES])));
  if (active) checks.push({ id: 'running', status: 'problem', message: 'An analysis of this version is already running.', fix: null });

  const [scan] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(sourcePage)
    .innerJoin(sourceDocument, eq(sourceDocument.id, sourcePage.sourceDocumentId))
    .where(and(eq(sourceDocument.frameworkVersionId, versionId), eq(sourcePage.needsOcr, true)));
  checks.push(...await aiPreflightChecks(ctx, { needsOcr: (scan?.n ?? 0) > 0 }));

  const first = checks.find((c) => c.status === 'problem');
  return { canStart: !first, firstProblem: first?.message ?? null, checks };
}
