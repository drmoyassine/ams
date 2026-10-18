// Reviewing and applying what an import found (TASK-075). Proposals are released by the worker's `propose` stage; from then on
// people own them: edit the values, accept or skip one or many, and Apply the accepted ones. Apply runs the target's `apply` AS THE
// PERSON in the request's single transaction (all or nothing), stores one `import_apply` record with the target's undo information,
// and answers with ONE undo descriptor, so Undo and Redo work like an assistant change set. The AI never writes the real records
// and never overwrites what a person edited (AI proposes, humans publish, DEC-006).
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appUser, importApply, importDocument, importProposal, sourceDocument } from '@ams/db';
import {
  APPLIABLE_PROPOSAL_STATUSES, plural, type DecideProposals, type ImportApplyPreview, type ImportApplyResult, type ImportProposal, type ImportProposalList,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman } from '../framework/common.js';
import { reportUndo } from '../trash/store.js';
import { getRunRow, loadRunForRead, toRunDtos } from './runs.js';
import { assertCanRead, assertCanWrite, describeScope } from './scopes.js';
import { findImportTarget, type ApplyItem, type ImportTarget, type TargetScope } from './targets.js';

type ProposalRow = typeof importProposal.$inferSelect;
type RunRow = Awaited<ReturnType<typeof getRunRow>>;

const APPLIABLE = [...APPLIABLE_PROPOSAL_STATUSES] as string[];

function requireTarget(kind: string): ImportTarget<unknown> {
  const t = findImportTarget(kind);
  if (!t) throw new ConflictError(`the import "${kind}" is not available in this version of the app`);
  return t;
}

async function scopeFor(ctx: Ctx, run: RunRow): Promise<TargetScope> {
  return { kind: run.scopeKind as TargetScope['kind'], id: run.scopeId, label: await describeScope(ctx, run.scopeKind, run.scopeId), runId: run.id };
}

const effective = (r: ProposalRow) => r.editedPayload ?? r.payload;

function labelOf(r: ProposalRow): string {
  const t = findImportTarget(r.targetKind);
  if (t) { try { const l = t.proposalLabel(effective(r) as never); if (l) return l; } catch { /* fall back to the stored name */ } }
  return r.label || 'Item';
}

async function documentNames(ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  for (const d of await ctx.tx.select({ id: importDocument.id, n: importDocument.fileName }).from(importDocument).where(inArray(importDocument.id, ids))) out.set(d.id, d.n);
  for (const d of await ctx.tx.select({ id: sourceDocument.id, n: sourceDocument.fileName, t: sourceDocument.title }).from(sourceDocument).where(inArray(sourceDocument.id, ids))) out.set(d.id, d.n ?? d.t);
  return out;
}

export function toProposalDto(r: ProposalRow, names: Map<string, string>): ImportProposal {
  return {
    id: r.id, runId: r.runId, targetKind: r.targetKind, seq: r.seq, label: labelOf(r), payload: r.payload, editedPayload: r.editedPayload, effective: effective(r),
    documentId: r.documentId, documentName: r.documentId ? names.get(r.documentId) ?? null : null, pageNo: r.pageNo, quote: r.quote, quoteVerified: r.quoteVerified,
    confidence: r.confidence, flags: r.flags as string[], status: r.status, appliedRef: r.appliedRef,
  };
}

/** A run with its proposals in reading order (candidates, which only the worker sees, are not listed). */
export async function listImportProposals(ctx: Ctx, runId: string): Promise<ImportProposalList> {
  const run = await loadRunForRead(ctx, runId);
  const rows = await ctx.tx.select().from(importProposal).where(and(eq(importProposal.runId, runId), eq(importProposal.candidate, false))).orderBy(asc(importProposal.seq));
  const names = await documentNames(ctx, [...new Set(rows.map((r) => r.documentId).filter((x): x is string => !!x))]);
  const target = findImportTarget(run.targetKind);
  const choices = target?.fieldChoices ? await target.fieldChoices(ctx, await scopeFor(ctx, run)) : {};
  return {
    run: (await toRunDtos(ctx, [run]))[0]!, proposals: rows.map((r) => toProposalDto(r, names)),
    fieldOptions: { ...(target ? fieldOptionsOf(target.schema) : {}), ...(choices.options ?? {}) },
    fieldSuggestions: choices.suggestions ?? {},
  };
}

/** The fields of a target's item that take one of a fixed list of values (an enum, possibly optional), with that list. */
export function fieldOptionsOf(schema: z.ZodType): Record<string, string[]> {
  let json: Record<string, unknown>;
  try { json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>; } catch { return {}; }
  const props = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
  const enumOf = (p: Record<string, unknown> | undefined): string[] | null => {
    if (!p) return null;
    if (Array.isArray(p.enum)) return p.enum.filter((v): v is string => typeof v === 'string');
    for (const k of ['anyOf', 'oneOf']) {
      const alts = p[k];
      if (Array.isArray(alts)) for (const a of alts) { const e = enumOf(a as Record<string, unknown>); if (e?.length) return e; }
    }
    return null;
  };
  const out: Record<string, string[]> = {};
  for (const [k, p] of Object.entries(props)) { const e = enumOf(p); if (e?.length) out[k] = e; }
  return out;
}

async function loadProposal(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(importProposal).where(eq(importProposal.id, id));
  if (!row || row.candidate) throw new NotFoundError(`proposal ${id}`);
  return { row, run: await getRunRow(ctx, row.runId) };
}

/** Changes the values of one proposal. They must fit the target's schema; the AI's original stays beside them. Counts as accepted. */
export async function editImportProposal(ctx: Ctx, id: string, payload: unknown): Promise<ImportProposal> {
  assertHuman(ctx);
  const { row, run } = await loadProposal(ctx, id);
  await assertCanWrite(ctx, run.scopeKind, run.scopeId);
  if (row.status === 'applied') throw new ConflictError('this one was already applied; undo the apply first, or edit the record itself');
  const target = requireTarget(row.targetKind);
  const parsed = target.schema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('these values do not fit', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const [next] = await ctx.tx.update(importProposal).set({ editedPayload: parsed.data as never, status: 'edited' }).where(eq(importProposal.id, id)).returning();
  const names = await documentNames(ctx, next!.documentId ? [next!.documentId] : []);
  return toProposalDto(next!, names);
}

/** Accept, skip or reset one or many proposals of a run. Applied ones are not changed (undo the apply first). */
export async function decideImportProposals(ctx: Ctx, runId: string, input: DecideProposals): Promise<{ changed: number }> {
  assertHuman(ctx);
  const run = await getRunRow(ctx, runId);
  await assertCanWrite(ctx, run.scopeKind, run.scopeId);
  const rows = await ctx.tx.select().from(importProposal).where(and(eq(importProposal.runId, runId), eq(importProposal.candidate, false), inArray(importProposal.id, input.ids)));
  if (rows.length !== new Set(input.ids).size) throw new NotFoundError('one of these proposals is not in this run');
  const applied = rows.filter((r) => r.status === 'applied');
  if (applied.length) throw new ConflictError(`${plural(applied.length, 'item')} already applied; undo the apply first`);
  let changed = 0;
  for (const r of rows) {
    const status = input.decision === 'skip' ? 'skipped' : input.decision === 'reset' ? 'pending' : r.editedPayload !== null ? 'edited' : 'accepted';
    if (status === r.status) continue;
    await ctx.tx.update(importProposal).set({ status }).where(eq(importProposal.id, r.id));
    changed += 1;
  }
  return { changed };
}

const readyRows = (ctx: Ctx, runId: string) =>
  ctx.tx.select().from(importProposal).where(and(eq(importProposal.runId, runId), eq(importProposal.candidate, false), inArray(importProposal.status, [...APPLIABLE] as never))).orderBy(asc(importProposal.seq));

/** What Apply would write, in the words the confirm dialog uses. Nothing is changed. */
export async function previewImportApply(ctx: Ctx, runId: string): Promise<ImportApplyPreview> {
  const run = await getRunRow(ctx, runId);
  await assertCanRead(ctx, run.scopeKind, run.scopeId);
  const target = findImportTarget(run.targetKind);
  const ready = await readyRows(ctx, runId);
  const [{ n: pending } = { n: 0 }] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(importProposal)
    .where(and(eq(importProposal.runId, runId), eq(importProposal.candidate, false), eq(importProposal.status, 'pending')));
  const noun = target?.itemsLabel ?? 'items';
  const place = await describeScope(ctx, run.scopeKind, run.scopeId);
  return {
    count: ready.length, skippedPending: pending,
    message: ready.length
      ? `Apply ${ready.length} ${ready.length === 1 ? noun.replace(/s$/, '') : noun} to ${place}? You can undo it afterwards.${pending ? ` ${plural(pending, 'row')} still waiting for a decision will be left out.` : ''}`
      : 'Nothing is accepted yet. Accept the rows you want first.',
  };
}

/**
 * Writes the accepted (and edited) proposals of a run: the target's `apply` runs as the person in this request's transaction, so a
 * refusal anywhere puts nothing in. Refused when the place cannot change (a published version). The target decides, record by
 * record, whether it may write (it must skip what a person edited, saying why); those proposals are marked skipped with the reason.
 */
export async function applyImport(ctx: Ctx, runId: string): Promise<ImportApplyResult> {
  assertHuman(ctx);
  const run = await getRunRow(ctx, runId);
  const { place } = await assertCanWrite(ctx, run.scopeKind, run.scopeId);
  const target = requireTarget(run.targetKind);
  if (run.status === 'queued' || run.status === 'running') throw new ConflictError('the import is still working; apply when it has finished');
  const rows = await readyRows(ctx, runId);
  if (!rows.length) throw new ConflictError('nothing is accepted yet: accept the rows you want, then apply');
  const names = await documentNames(ctx, [...new Set(rows.map((r) => r.documentId).filter((x): x is string => !!x))]);
  const items: ApplyItem<unknown>[] = rows.map((r) => {
    const parsed = target.schema.safeParse(effective(r));
    if (!parsed.success) throw new ConflictError(`"${labelOf(r)}" does not fit any more (${parsed.error.issues[0]?.message ?? 'invalid values'}); edit it first`);
    return {
      proposalId: r.id, item: parsed.data, edited: r.editedPayload !== null, label: labelOf(r),
      source: { documentId: r.documentId, documentName: r.documentId ? names.get(r.documentId) ?? null : null, page: r.pageNo, quote: r.quote, quoteVerified: r.quoteVerified },
    };
  });
  const scope = await scopeFor(ctx, run);
  // The target's own services may report undo descriptors of their own; the apply is one group with one descriptor of its own.
  const result = await target.apply({ ...ctx, undo: () => undefined }, items, scope);
  const byId = new Map(result.outcomes.map((o) => [o.proposalId, o]));
  if (byId.size !== result.outcomes.length || items.some((i) => !byId.has(i.proposalId)) || result.outcomes.some((o) => !items.some((i) => i.proposalId === o.proposalId))) {
    throw new Error(`the import "${target.kind}" did not answer for exactly the items it was given`);
  }
  const skipped: ImportApplyResult['skipped'] = [];
  const refs: Record<string, unknown> = {};
  const appliedIds: string[] = [];
  for (const it of items) {
    const o = byId.get(it.proposalId)!;
    if (o.status === 'applied') {
      refs[it.proposalId] = o.ref ?? null;
      appliedIds.push(it.proposalId);
      await ctx.tx.update(importProposal).set({ status: 'applied', appliedRef: (o.ref ?? null) as never }).where(eq(importProposal.id, it.proposalId));
    } else {
      skipped.push({ proposalId: it.proposalId, label: it.label, reason: o.reason });
      await ctx.tx.update(importProposal).set({ status: 'skipped', appliedRef: { skipped: true, reason: o.reason } as never }).where(eq(importProposal.id, it.proposalId));
    }
  }
  const noun = target.itemsLabel;
  const left = skipped.length ? ` ${plural(skipped.length, 'item')} left alone.` : '';
  if (!appliedIds.length) {
    return { applyId: null, state: 'applied', applied: 0, skipped, message: `Nothing was written.${left}` };
  }
  const summary = `Applied ${appliedIds.length} ${appliedIds.length === 1 ? noun.replace(/s$/, '') : noun} to ${place.label}`;
  const [row] = await ctx.tx.insert(importApply).values({
    institutionId: ctx.caller.institutionId, runId, userId: ctx.caller.userId!, targetKind: run.targetKind, scopeKind: run.scopeKind, scopeId: run.scopeId,
    proposalIds: appliedIds, summary, counts: { applied: appliedIds.length, skipped: skipped.length }, inverse: { target: result.inverse ?? null, refs } as never,
  }).returning();
  reportUndo(ctx, { label: summary, method: 'POST', path: `/api/import-applies/${row!.id}/undo` });
  return { applyId: row!.id, state: 'applied', applied: appliedIds.length, skipped, message: `${summary}.${left}` };
}

async function loadApply(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(importApply).where(eq(importApply.id, id));
  if (!row) throw new NotFoundError('that apply does not exist');
  const run = await getRunRow(ctx, row.runId);
  await assertCanWrite(ctx, run.scopeKind, run.scopeId);
  return { row, run, target: requireTarget(row.targetKind) };
}

type Stored = { target: unknown; refs: Record<string, unknown> };

/** Takes a whole apply back in one transaction (the target's `reverse`); the proposals return to accepted. */
export async function undoImportApply(ctx: Ctx, id: string): Promise<ImportApplyResult> {
  assertHuman(ctx);
  const { row, run, target } = await loadApply(ctx, id);
  if (row.state !== 'applied') throw new ConflictError('This was already undone.');
  const stored = row.inverse as Stored;
  let next: unknown;
  try { next = await target.reverse({ ...ctx, undo: () => undefined }, stored.target, await scopeFor(ctx, run)); } catch (e) {
    throw new ConflictError(`Cannot undo: ${e instanceof Error ? e.message : 'the change could not be taken back'}`);
  }
  await ctx.tx.update(importApply).set({ state: 'undone', undoneAt: new Date(), inverse: { target: next ?? null, refs: stored.refs } as never }).where(eq(importApply.id, id));
  const props = await ctx.tx.select().from(importProposal).where(inArray(importProposal.id, row.proposalIds));
  for (const p of props) {
    await ctx.tx.update(importProposal).set({ status: p.editedPayload !== null ? 'edited' : 'accepted', appliedRef: null }).where(eq(importProposal.id, p.id));
  }
  reportUndo(ctx, { label: row.summary, method: 'POST', path: `/api/import-applies/${id}/redo` });
  return { applyId: id, state: 'undone', applied: 0, skipped: [], message: `Undone: ${row.summary}.` };
}

/** Does it again: the target's `reverse` of the undo. Refused when the same items were applied again meanwhile. */
export async function redoImportApply(ctx: Ctx, id: string): Promise<ImportApplyResult> {
  assertHuman(ctx);
  const { row, run, target } = await loadApply(ctx, id);
  if (row.state !== 'undone') throw new ConflictError('This is already in place.');
  const props = await ctx.tx.select().from(importProposal).where(inArray(importProposal.id, row.proposalIds));
  if (props.some((p) => p.status === 'applied')) throw new ConflictError('Cannot redo: some of these items were applied again since.');
  const stored = row.inverse as Stored;
  let next: unknown;
  try { next = await target.reverse({ ...ctx, undo: () => undefined }, stored.target, await scopeFor(ctx, run)); } catch (e) {
    throw new ConflictError(`Cannot redo: ${e instanceof Error ? e.message : 'the change could not be made again'}`);
  }
  await ctx.tx.update(importApply).set({ state: 'applied', undoneAt: null, inverse: { target: next ?? null, refs: stored.refs } as never }).where(eq(importApply.id, id));
  for (const p of props) await ctx.tx.update(importProposal).set({ status: 'applied', appliedRef: (stored.refs[p.id] ?? null) as never }).where(eq(importProposal.id, p.id));
  reportUndo(ctx, { label: row.summary, method: 'POST', path: `/api/import-applies/${id}/undo` });
  return { applyId: id, state: 'applied', applied: row.proposalIds.length, skipped: [], message: `Done again: ${row.summary}.` };
}

/** The applies of a run, newest first (for the report). */
export async function listImportApplies(ctx: Ctx, runId: string) {
  const rows = await ctx.tx.select({ a: importApply, by: appUser.fullName }).from(importApply).leftJoin(appUser, eq(appUser.id, importApply.userId))
    .where(eq(importApply.runId, runId)).orderBy(desc(importApply.appliedAt));
  return rows.map(({ a, by }) => ({
    id: a.id, state: a.state, applied: (a.counts as { applied?: number }).applied ?? 0, appliedAt: a.appliedAt.toISOString(), undoneAt: a.undoneAt?.toISOString() ?? null, byName: by,
  }));
}
