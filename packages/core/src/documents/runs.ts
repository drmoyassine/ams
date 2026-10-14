// Starting, following and cancelling an import run (TASK-075). The work itself is done by the `import` job (stages.ts), one small
// job per stage step; these services only check, queue and report. Same shape as the framework analysis (framework/analysis/runs.ts).
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { appUser, importDocument, importProposal, importRun, sourceDocument } from '@ams/db';
import {
  ACTIVE_IMPORT_STATUSES, type DocScopeKind, type ImportCounts, type ImportProgress, type ImportRun, type ImportTargetInfo, type ImportUsage, type Preflight, type PreflightCheck,
  type StartImport,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { aiPreflightChecks, aiReadiness } from '../ai/settings.js';
import { assertHuman } from '../framework/common.js';
import { guardIntegrity } from '../framework/errors.js';
import { enqueueJob } from '../jobs/jobs.js';
import { listDocuments } from './documents.js';
import { assertCanRead, assertCanWrite, getDocScope } from './scopes.js';
import { findImportTarget, importTargetsFor, type ImportTarget } from './targets.js';

type RunRow = typeof importRun.$inferSelect;

export const infoOf = (t: ImportTarget<unknown>): ImportTargetInfo => ({ kind: t.kind, label: t.label, description: t.description, scopeKinds: [...t.scopeKinds], itemsLabel: t.itemsLabel });

/** The imports a place offers (the buttons of its Docs tab). Needs the place's read permission. */
export async function listImportTargets(ctx: Ctx, scopeKind: string, scopeId: string | null): Promise<ImportTargetInfo[]> {
  await assertCanRead(ctx, scopeKind, scopeId);
  return importTargetsFor(scopeKind).map(infoOf);
}

export function targetFor(kind: string, scopeKind: string): ImportTarget<unknown> {
  const t = findImportTarget(kind);
  if (!t) throw new NotFoundError(`import target ${kind}`);
  if (!(t.scopeKinds as readonly string[]).includes(scopeKind)) throw new ConflictError(`"${t.label}" is not offered for ${getDocScope(scopeKind).label}`);
  return t;
}

export async function getRunRow(ctx: Ctx, id: string): Promise<RunRow> {
  const [row] = await ctx.tx.select().from(importRun).where(eq(importRun.id, id));
  if (!row) throw new NotFoundError(`import run ${id}`);
  return row;
}

export async function countsOf(ctx: Ctx, runIds: string[]): Promise<Map<string, ImportCounts>> {
  const out = new Map<string, ImportCounts>();
  const blank = (): ImportCounts => ({ total: 0, pending: 0, accepted: 0, edited: 0, skipped: 0, applied: 0, flagged: 0 });
  for (const id of runIds) out.set(id, blank());
  if (!runIds.length) return out;
  const rows = await ctx.tx.select({
    runId: importProposal.runId, status: importProposal.status, n: sql<number>`count(*)::int`,
    flagged: sql<number>`(count(*) filter (where not ${importProposal.quoteVerified} or jsonb_array_length(${importProposal.flags}) > 0))::int`,
  }).from(importProposal).where(and(inArray(importProposal.runId, runIds), eq(importProposal.candidate, false))).groupBy(importProposal.runId, importProposal.status);
  for (const r of rows) {
    const c = out.get(r.runId)!;
    c.total += r.n; c.flagged += r.flagged;
    c[r.status] += r.n;
  }
  return out;
}

export async function toRunDtos(ctx: Ctx, rows: RunRow[]): Promise<ImportRun[]> {
  if (!rows.length) return [];
  const counts = await countsOf(ctx, rows.map((r) => r.id));
  const users = await ctx.tx.select({ id: appUser.id, name: appUser.fullName }).from(appUser).where(inArray(appUser.id, [...new Set(rows.map((r) => r.startedBy).filter((x): x is string => !!x))].concat('00000000-0000-0000-0000-000000000000')));
  const names = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id, scopeKind: r.scopeKind as DocScopeKind, scopeId: r.scopeId, targetKind: r.targetKind, targetLabel: findImportTarget(r.targetKind)?.label ?? r.targetKind,
    documentIds: r.documentIds, status: r.status, stage: r.stage, progress: r.progress as ImportProgress, usage: r.usage as ImportUsage, error: r.error,
    startedBy: r.startedBy, startedByName: r.startedBy ? names.get(r.startedBy) ?? null : null, startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), counts: counts.get(r.id)!,
  }));
}

/** The documents of a run, in the order they were given, checked to belong to the scope. */
async function documentsOfScope(ctx: Ctx, scopeKind: string, scopeId: string | null, ids: string[]): Promise<string[]> {
  const def = getDocScope(scopeKind);
  const found = def.storage === 'source'
    ? await ctx.tx.select({ id: sourceDocument.id }).from(sourceDocument).where(and(eq(sourceDocument.frameworkVersionId, scopeId!), inArray(sourceDocument.id, ids)))
    : await ctx.tx.select({ id: importDocument.id }).from(importDocument).where(and(
      eq(importDocument.scopeKind, def.kind as never), scopeId ? eq(importDocument.scopeId, scopeId) : sql`${importDocument.scopeId} is null`, inArray(importDocument.id, ids)));
  const have = new Set(found.map((f) => f.id));
  const missing = ids.filter((i) => !have.has(i));
  if (missing.length) throw new ValidationError(`${missing.length === 1 ? 'a document' : `${missing.length} documents`} you chose ${missing.length === 1 ? 'is' : 'are'} not in ${def.label}`);
  return ids;
}

/** Can an import start now? A checklist, never a model call, so the button can say why not before anyone clicks it. */
export async function importPreflight(ctx: Ctx, scopeKind: string, scopeId: string | null, targetKind: string): Promise<Preflight> {
  const { place } = await assertCanWrite(ctx, scopeKind, scopeId, { editable: false });
  const checks: PreflightCheck[] = [];
  const t = findImportTarget(targetKind);
  if (!t || !(t.scopeKinds as readonly string[]).includes(scopeKind)) {
    checks.push({ id: 'target', status: 'problem', message: 'This import is not available here.', fix: null });
  } else checks.push({ id: 'target', status: 'ok', message: `${t.label}: ${t.description}`, fix: null });

  if (!place.editable) checks.push({ id: 'editable', status: 'problem', message: place.fixedReason ?? `${place.label} cannot be changed now.`, fix: scopeKind === 'framework_version' ? { label: 'Start a new version', where: 'version' } : null });
  else checks.push({ id: 'editable', status: 'ok', message: `${place.label} can be changed.`, fix: null });

  const docs = await listDocuments(ctx, scopeKind, scopeId);
  const usable = docs.filter((d) => d.hasFile || (d.pageCount ?? 0) > 0);
  const readable = usable.filter((d) => d.status !== 'failed');
  if (!docs.length) checks.push({ id: 'documents', status: 'problem', message: 'Upload a document first; there is nothing to read.', fix: { label: 'Add documents', where: 'docs' } });
  else if (!readable.length) checks.push({ id: 'documents', status: 'problem', message: 'None of the documents could be read. Check the files, or read them again.', fix: { label: 'Open Docs', where: 'docs' } });
  else {
    const waiting = readable.filter((d) => d.status === 'queued' || d.status === 'reading' || d.status === 'not_read').length;
    checks.push({
      id: 'documents', status: 'ok', fix: null,
      message: `${readable.length} ${readable.length === 1 ? 'document' : 'documents'} to read${waiting ? `; ${waiting} still being read, the import waits for ${waiting === 1 ? 'it' : 'them'}` : ''}.`,
    });
    const failed = docs.length - readable.length;
    if (failed) checks.push({ id: 'unreadable', status: 'note', message: `${failed} ${failed === 1 ? 'document' : 'documents'} could not be read and will be left out.`, fix: { label: 'Open Docs', where: 'docs' } });
  }

  const [active] = t ? await ctx.tx.select({ id: importRun.id }).from(importRun).where(and(
    eq(importRun.scopeKind, scopeKind), scopeId ? eq(importRun.scopeId, scopeId) : sql`${importRun.scopeId} is null`, eq(importRun.targetKind, targetKind), inArray(importRun.status, [...ACTIVE_IMPORT_STATUSES]))) : [];
  if (active) checks.push({ id: 'running', status: 'problem', message: `A ${t!.label.toLowerCase()} import is already running here.`, fix: null });

  checks.push(...await aiPreflightChecks(ctx, { needsOcr: docs.some((d) => d.needsOcrPages > 0) }).then((c) => c.filter((x) => x.id !== 'embeddings')));
  const first = checks.find((c) => c.status === 'problem');
  return { canStart: !first, firstProblem: first?.message ?? null, checks };
}

/**
 * Starts reading documents into a target. Refused unless the place can change, AI is on and set up, every document is in the place,
 * and no run of the same target is active there. The model is called later, by the worker's `import` jobs (DEC-012).
 */
export async function startImport(ctx: Ctx, input: StartImport): Promise<ImportRun> {
  assertHuman(ctx);
  const { scopeKind, targetKind } = input;
  const scopeId = input.scopeId ?? null;
  await assertCanWrite(ctx, scopeKind, scopeId);
  const target = targetFor(targetKind, scopeKind);
  const ready = await aiReadiness(ctx);
  if (!ready.ok) throw new ConflictError(ready.reason);
  const ids = await documentsOfScope(ctx, scopeKind, scopeId, [...new Set(input.documentIds)]);
  const [active] = await ctx.tx.select({ id: importRun.id }).from(importRun).where(and(
    eq(importRun.scopeKind, scopeKind), scopeId ? eq(importRun.scopeId, scopeId) : sql`${importRun.scopeId} is null`, eq(importRun.targetKind, targetKind), inArray(importRun.status, [...ACTIVE_IMPORT_STATUSES])));
  if (active) throw new ConflictError(`a ${target.label.toLowerCase()} import is already running here`);
  const [row] = await guardIntegrity(() => ctx.tx.insert(importRun).values({
    institutionId: ctx.caller.institutionId, scopeKind, scopeId, targetKind, documentIds: ids, status: 'queued', stage: 'read',
    progress: { stage: 'read', cursor: 0, docsTotal: ids.length, docsDone: 0 }, promptVersion: target.promptVersion, startedBy: ctx.caller.userId, startedAt: new Date(),
  }).returning());
  await enqueueJob(ctx, { type: 'import', payload: { runId: row!.id, stage: 'read', cursor: 0 } });
  return (await toRunDtos(ctx, [row!]))[0]!;
}

/** A place's imports, newest first (the history under its Docs tab). */
export async function listImportRuns(ctx: Ctx, scopeKind: string, scopeId: string | null): Promise<ImportRun[]> {
  await assertCanRead(ctx, scopeKind, scopeId);
  const rows = await ctx.tx.select().from(importRun).where(and(eq(importRun.scopeKind, scopeKind), scopeId ? eq(importRun.scopeId, scopeId) : sql`${importRun.scopeId} is null`))
    .orderBy(desc(importRun.createdAt)).limit(30);
  return toRunDtos(ctx, rows);
}

/** A run the caller may read (its place's read permission). */
export async function loadRunForRead(ctx: Ctx, id: string): Promise<RunRow> {
  const row = await getRunRow(ctx, id);
  await assertCanRead(ctx, row.scopeKind, row.scopeId);
  return row;
}

export async function getImportRun(ctx: Ctx, id: string): Promise<ImportRun> {
  return (await toRunDtos(ctx, [await loadRunForRead(ctx, id)]))[0]!;
}

/**
 * Stops a queued or running import. The job in flight finishes its own step and then stops; what was found so far is released as
 * proposals (it is all marked as the AI's, with its page and quote).
 */
export async function cancelImport(ctx: Ctx, id: string): Promise<ImportRun> {
  assertHuman(ctx);
  const run = await getRunRow(ctx, id);
  await assertCanWrite(ctx, run.scopeKind, run.scopeId, { editable: false });
  if (!(ACTIVE_IMPORT_STATUSES as readonly string[]).includes(run.status)) throw new ConflictError(`the import has already ended (${run.status})`);
  const [row] = await ctx.tx.update(importRun).set({ status: 'cancelled', finishedAt: new Date(), error: 'cancelled by a person' })
    .where(and(eq(importRun.id, id), inArray(importRun.status, [...ACTIVE_IMPORT_STATUSES]))).returning();
  if (!row) throw new ConflictError('the import has already ended');
  return (await toRunDtos(ctx, [row]))[0]!;
}
