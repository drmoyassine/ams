// Planning a change set: operations (what the model chose) + the current data -> steps (exact calls of the core services),
// counts, examples, what is skipped and why, what is deleted, and everything that makes it impossible. READ-ONLY: it runs in the
// model's job (propose_changes), in the confirm request (dry run), and again in the apply request, each time on the data as it is
// then. The rows are simulated in memory as the operations are applied one after the other, so a later operation sees the result
// of an earlier one and the rules the database enforces (code uniqueness, no cycles, depth, a draft version) are checked before
// anybody is asked. The service-level dry run (`dryRunPlan` in execute.ts) re-checks the same steps through the real services.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accreditor, framework, frameworkVersion, requirement, requirementMapping, requirementNote } from '@ams/db';
import {
  MAX_ITEM_CHANGES, OP_LABELS, limitsFor, planMoves, type ChangeCounts, type ChangeExample, type ChangeSetInput, type Operation, type RequirementFilter,
} from '@ams/shared';
import type { Ctx } from '../../ctx.js';
import { getVersion, isInternalVersion, require_ } from '../../framework/common.js';
import { isPermitted } from '../../permissions.js';
import { hashOf } from './hash.js';
import { RowIndex, matchFilter, type ReqRow } from './filter.js';
import { codeRule, copyField, fieldValue, setValues, swapTitleAndDescription, textRule, type RowResult } from './recipes.js';
import type { DeleteNote, Plan, ReqPatch, SkippedItem, Step, WrittenItem } from './types.js';

const SKIPPED_SHOWN = 25;
const DELETES_SHOWN = 30;
const clip = (s: string | null | undefined, n = 140) => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
type Op<N extends Operation['op']> = Extract<Operation, { op: N }>;

const PATCH_FIELD_ORDER = ['title', 'officialText', 'code', 'levelLabel', 'isAssessable', 'language', 'translationEn'] as const;
const show = (field: string, v: unknown): string => (field === 'isAssessable' ? (v ? 'assessable' : 'not assessable') : v === null || v === undefined || v === '' ? '(empty)' : clip(String(v), 160));
const exampleLabel = (f: string) => (f === 'officialText' ? 'description' : f === 'levelLabel' ? 'level name' : f === 'isAssessable' ? 'assessable' : f === 'translationEn' ? 'English translation' : f);

export interface VersionFacts {
  id: string; edition: string; status: string; label: string; internal: boolean; frameworkId: string; levelLabels: string[];
}

export async function loadVersionFacts(ctx: Ctx, versionId: string): Promise<VersionFacts> {
  const v = await getVersion(ctx, versionId);
  const [fw] = await ctx.tx.select({ internal: framework.internal, short: accreditor.shortName }).from(framework)
    .innerJoin(accreditor, eq(accreditor.id, framework.accreditorId)).where(eq(framework.id, v.frameworkId));
  const internal = fw?.internal ?? (await isInternalVersion(ctx, versionId));
  return {
    id: v.id, edition: v.edition, status: v.status, label: `${fw?.short ?? ''} ${v.edition}`.trim(), internal, frameworkId: v.frameworkId,
    levelLabels: Array.isArray(v.levelLabels) ? (v.levelLabels as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  };
}

export async function loadRows(ctx: Ctx, versionId: string): Promise<{ rows: ReqRow[]; noteCounts: Map<string, number> }> {
  const rs = await ctx.tx.select().from(requirement).where(eq(requirement.frameworkVersionId, versionId));
  const rows: ReqRow[] = rs.map((r) => ({
    id: r.id, parentId: r.parentId ?? null, code: r.code, levelLabel: r.levelLabel, title: r.title, officialText: r.officialText, translationEn: r.translationEn,
    language: r.language, isAssessable: r.isAssessable, displayOrder: r.displayOrder, origin: r.origin, sourceQuote: r.sourceQuote, quoteVerified: r.quoteVerified,
    editedByPerson: r.editedByPerson,
  }));
  const counts = new Map<string, number>();
  if (rows.length) {
    const grouped = await ctx.tx.select({ id: requirementNote.requirementId, n: sql<number>`count(*)::int` }).from(requirementNote)
      .innerJoin(requirement, eq(requirement.id, requirementNote.requirementId)).where(eq(requirement.frameworkVersionId, versionId)).groupBy(requirementNote.requirementId);
    for (const g of grouped) counts.set(g.id, g.n);
  }
  return { rows, noteCounts: counts };
}

class Builder {
  readonly steps: Step[] = [];
  readonly skipped: SkippedItem[] = [];
  skippedCount = 0;
  readonly deletes: DeleteNote[] = [];
  deletesCount = 0;
  readonly problems: string[] = [];
  readonly warnings: string[] = [];
  readonly written: WrittenItem[] = [];
  readonly perOp: { opIndex: number; op: string; label: string; items: number }[] = [];
  readonly examples = new Map<number, ChangeExample[]>();
  items = 0;
  dropped = 0;
  deferredOps = 0;
  linksByCode = 0;
  tempNo = 0;
  readonly rows = new Map<string, ReqRow>();
  readonly noteCounts = new Map<string, number>();
  private idx: RowIndex | null = null;
  constructor(readonly ctx: Ctx | null, readonly v: VersionFacts, rows: ReqRow[], notes: Map<string, number>) {
    for (const r of rows) this.rows.set(r.id, r);
    for (const [k, n] of notes) this.noteCounts.set(k, n);
  }
  index(): RowIndex { return (this.idx ??= new RowIndex([...this.rows.values()], this.noteCounts)); }
  dirty() { this.idx = null; }
  skip(code: string | null, reason: string) { this.skippedCount++; if (this.skipped.length < SKIPPED_SHOWN) this.skipped.push({ code, reason }); }
  problem(_opIndex: number, op: Operation, message: string) { this.problems.push(`${OP_LABELS[op.op]}: ${message}`); }
  budgetLeft() { return MAX_ITEM_CHANGES - this.items; }
  /** Counts `n` item changes of an operation against the limit; false when they do not fit (the op is left for a later step). */
  take(opIndex: number, op: Operation, n: number): boolean {
    if (n > this.budgetLeft()) { this.dropped += n; return false; }
    this.items += n;
    const row = this.perOp.find((p) => p.opIndex === opIndex) ?? (() => { const p = { opIndex, op: op.op, label: OP_LABELS[op.op], items: 0 }; this.perOp.push(p); return p; })();
    row.items += n;
    return true;
  }
  example(opIndex: number, ex: ChangeExample) { this.examples.set(opIndex, [...(this.examples.get(opIndex) ?? []), ex]); }
  patch(id: string, patch: ReqPatch) { const r = this.rows.get(id); if (r) { this.rows.set(id, { ...r, ...(patch as Partial<ReqRow>) } as ReqRow); this.dirty(); } }
  remove(ids: string[]) { for (const id of ids) { this.rows.delete(id); this.noteCounts.delete(id); } this.dirty(); }
  nextTemp() { return `new-${++this.tempNo}`; }
}

/** A foreign id (another version, or not visible): the reason it is left alone. */
async function foreignReasons(b: Builder, ids: string[]): Promise<Map<string, SkippedItem>> {
  const out = new Map<string, SkippedItem>();
  const unknown = ids.filter((id) => !b.rows.has(id));
  if (!unknown.length) return out;
  if (!b.ctx) { for (const id of unknown) out.set(id, { code: null, reason: 'it does not exist, or you cannot see it' }); return out; }
  const found = await b.ctx.tx.select({ id: requirement.id, code: requirement.code, status: frameworkVersion.status, edition: frameworkVersion.edition })
    .from(requirement).innerJoin(frameworkVersion, eq(frameworkVersion.id, requirement.frameworkVersionId)).where(inArray(requirement.id, unknown));
  const byId = new Map(found.map((f) => [f.id, f]));
  for (const id of unknown) {
    const f = byId.get(id);
    out.set(id, f
      ? { code: f.code, reason: f.status === 'published' || f.status === 'retired' ? `it belongs to ${f.edition}, a ${f.status} version, which is read-only` : `it belongs to another version (${f.edition}); propose it separately` }
      : { code: null, reason: 'it does not exist, or you cannot see it' });
  }
  return out;
}

/** Records, for the ids of a filter that are not in this version, why they are left alone. */
async function noteForeignIds(b: Builder, ids: string[] | undefined) {
  if (!ids) return;
  for (const [, s] of await foreignReasons(b, ids)) b.skip(s.code, s.reason);
}

type RowFn = (row: ReqRow) => RowResult;

/** The common shape of a rule over rows: pick them with the filter, ask the rule about each, record the changes. */
async function perRow(b: Builder, opIndex: number, op: Operation, filter: RequirementFilter | undefined, fn: RowFn, written = false) {
  await noteForeignIds(b, filter?.ids);
  const picked = matchFilter(b.index(), filter);
  if (picked.problems.length) { for (const p of picked.problems) b.problem(opIndex, op, p); return; }
  const changes: { row: ReqRow; patch: ReqPatch }[] = [];
  for (const row of picked.rows) {
    const r = fn(row);
    if (!r) continue;
    if ('skip' in r) { b.skip(row.code, r.skip); continue; }
    changes.push({ row, patch: r.patch });
  }
  commitRowChanges(b, opIndex, op, changes, written);
}

function commitRowChanges(b: Builder, opIndex: number, op: Operation, changes: { row: ReqRow; patch: ReqPatch }[], written = false) {
  if (!changes.length) return;
  const room = b.budgetLeft();
  const take = changes.slice(0, Math.max(0, room));
  b.dropped += changes.length - take.length;
  if (!take.length) { b.deferredOps++; return; }
  b.take(opIndex, op, take.length);
  take.forEach(({ row, patch }) => {
    const was: ReqPatch = {};
    for (const k of Object.keys(patch)) (was as Record<string, unknown>)[k] = (row as unknown as Record<string, unknown>)[k];
    b.steps.push({ kind: 'req_fields', opIndex, id: row.id, code: row.code, set: patch, was, ...(written ? { written: true } : {}) });
    b.patch(row.id, patch);
    if (written) for (const f of ['title', 'officialText', 'translationEn'] as const) if (patch[f] !== undefined) b.written.push({ requirementId: row.id, code: row.code, field: f, text: String(patch[f]), previous: (was[f] as string | null | undefined) ?? null });
  });
  // Examples: the first, the middle and the last change, so a reader sees the spread.
  const pick = [...new Set([0, Math.floor((take.length - 1) / 2), take.length - 1])].filter((i) => i >= 0);
  for (const i of pick) {
    const { row, patch } = take[i]!;
    const field = PATCH_FIELD_ORDER.find((f) => patch[f] !== undefined)!;
    b.example(opIndex, { code: row.code, field: exampleLabel(field), before: show(field, (row as unknown as Record<string, unknown>)[field]), after: show(field, patch[field]) });
  }
}

// ---- Operations -------------------------------------------------------------------------------------------------------------
async function planOp(b: Builder, opIndex: number, op: Operation) {
  switch (op.op) {
    case 'swap_title_and_description':
      return perRow(b, opIndex, op, op.filter, (r) => swapTitleAndDescription(r, op.direction));
    case 'set_field_by_filter': {
      const v = fieldValue(op.field, op.value);
      if (!v.ok) return b.problem(opIndex, op, v.message);
      if (op.field === 'levelLabel' && b.v.internal) return b.problem(opIndex, op, 'the levels of the quality framework follow the tree (depth); rename the levels in the framework\'s settings');
      return perRow(b, opIndex, op, op.filter, (r) => setValues(r, v.set));
    }
    case 'copy_field':
      return perRow(b, opIndex, op, op.filter, (r) => copyField(r, op));
    case 'prefix_or_replace_text': {
      const rule = textRule(op);
      if (!rule.ok) return b.problem(opIndex, op, rule.message);
      return perRow(b, opIndex, op, op.filter, (r) => rule.run(r));
    }
    case 'bulk_set_assessable':
      return perRow(b, opIndex, op, op.filter, (r) => setValues(r, { isAssessable: op.value }));
    case 'bulk_set_level_label':
      if (b.v.internal) return b.problem(opIndex, op, 'the levels of the quality framework follow the tree (depth); rename the levels in the framework\'s settings');
      return perRow(b, opIndex, op, op.filter, (r) => setValues(r, { levelLabel: op.label }));
    case 'set_fields':
      return planSetFields(b, opIndex, op);
    case 'rewrite_text':
      return planRewrite(b, opIndex, op);
    case 'recode':
      return planRecode(b, opIndex, op);
    case 'reparent_by_rule':
      return planReparent(b, opIndex, op);
    case 'move':
      return planMove(b, opIndex, op);
    case 'delete_by_filter':
      return planDelete(b, opIndex, op);
    case 'create_requirement':
      return planCreate(b, opIndex, op);
    case 'merge':
      return planMerge(b, opIndex, op);
    case 'split':
      return planSplit(b, opIndex, op);
    case 'set_note_fields':
      return planNotes(b, opIndex, op);
    case 'accept_suggested_links':
    case 'dismiss_suggested_links':
      return planLinks(b, opIndex, op);
    case 'create_draft':
      return b.problem(opIndex, op, 'creating a draft is a separate step');
  }
}

async function planSetFields(b: Builder, opIndex: number, op: Op<'set_fields'>) {
  if (op.set?.levelLabel !== undefined || op.items?.some((i) => i.set.levelLabel !== undefined)) {
    if (b.v.internal) return b.problem(opIndex, op, 'the levels of the quality framework follow the tree (depth); rename the levels in the framework\'s settings');
  }
  if (op.targets && op.set) return perRow(b, opIndex, op, op.targets, (r) => setValues(r, op.set!));
  const foreign = await foreignReasons(b, op.items!.map((i) => i.id));
  const changes: { row: ReqRow; patch: ReqPatch }[] = [];
  const seen = new Set<string>();
  for (const item of op.items!) {
    const row = b.rows.get(item.id);
    if (!row) { const f = foreign.get(item.id)!; b.skip(f.code, f.reason); continue; }
    if (seen.has(row.id)) { b.problem(opIndex, op, `${row.code} is named twice`); continue; }
    seen.add(row.id);
    const r = setValues(row, item.set);
    if (r && 'patch' in r) changes.push({ row, patch: r.patch });
  }
  // Per-item values are texts the model wrote item by item (unlike a rule or one fixed value): they are marked until the person reviews them.
  commitRowChanges(b, opIndex, op, changes, true);
}

async function planRewrite(b: Builder, opIndex: number, op: Op<'rewrite_text'>) {
  const items = op.items ?? [];
  const foreign = await foreignReasons(b, items.map((i) => i.id));
  const changes: { row: ReqRow; patch: ReqPatch }[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const row = b.rows.get(item.id);
    if (!row) { const f = foreign.get(item.id)!; b.skip(f.code, f.reason); continue; }
    if (seen.has(row.id)) { b.problem(opIndex, op, `${row.code} has two new texts`); continue; }
    seen.add(row.id);
    const text = op.field === 'title' ? item.text.normalize('NFC').replace(/\s+/g, ' ').trim() : item.text.normalize('NFC').trim();
    if (!text) { b.skip(row.code, 'the new text is empty'); continue; }
    const cur = op.field === 'title' ? row.title : op.field === 'officialText' ? row.officialText : row.translationEn;
    if ((cur ?? '') === text) continue;
    changes.push({ row, patch: { [op.field]: text } as ReqPatch });
  }
  commitRowChanges(b, opIndex, op, changes, true);
}

async function planRecode(b: Builder, opIndex: number, op: Op<'recode'>) {
  const rule = codeRule(op);
  if (!rule.ok) return b.problem(opIndex, op, rule.message);
  await noteForeignIds(b, op.filter.ids);
  const picked = matchFilter(b.index(), op.filter);
  if (picked.problems.length) { for (const p of picked.problems) b.problem(opIndex, op, p); return; }
  const wanted = picked.rows.flatMap((row) => { const code = rule.newCode(row); return code === null || code === row.code ? [] : [{ row, code }]; });
  const takenBy = new Map([...b.rows.values()].map((r) => [r.code, r]));
  const dupes = new Map<string, number>();
  for (const w of wanted) dupes.set(w.code, (dupes.get(w.code) ?? 0) + 1);
  const good: { row: ReqRow; patch: ReqPatch }[] = [];
  for (const { row, code } of wanted) {
    if (!code) { b.skip(row.code, 'the new code would be empty'); continue; }
    const other = takenBy.get(code);
    if (other && other.id !== row.id) { b.skip(row.code, `the code ${code} is already used by another item`); continue; }
    if ((dupes.get(code) ?? 0) > 1) { b.skip(row.code, `the code ${code} would be given to two items`); continue; }
    good.push({ row, patch: { code } });
  }
  commitRowChanges(b, opIndex, op, good);
  if (good.length && b.ctx) {
    // Links to other standards (and similar records) name a code; they are not moved when a code changes.
    const codes = good.map((g) => g.row.code);
    const col = b.v.internal ? requirementMapping.internalCode : requirementMapping.externalCode;
    const fwCol = b.v.internal ? requirementMapping.internalFrameworkId : requirementMapping.frameworkId;
    const [n] = await b.ctx!.tx.select({ n: sql<number>`count(*)::int` }).from(requirementMapping).where(and(eq(fwCol, b.v.frameworkId), inArray(col, codes)));
    if (n?.n) { b.linksByCode += n.n; b.warnings.push(`${n.n} link${n.n === 1 ? '' : 's'} to other standards name a code that changes. Links are kept by code, so they stay with the old code and will not follow the item.`); }
  }
}

function moveOutcome(b: Builder, opIndex: number, op: Operation, moves: { id: string; parentId: string | null; index: number }[], label: string) {
  const rows = [...b.rows.values()].map((r) => ({ id: r.id, parentId: r.parentId, displayOrder: r.displayOrder, code: r.code }));
  const plan = planMoves(rows, moves, (id) => b.rows.get(id)?.code ?? 'an item', limitsFor({ internal: b.v.internal, levelLabels: b.v.levelLabels }));
  if (!plan.ok) { b.problem(opIndex, op, plan.message); return; }
  if (plan.unchanged) return;
  const movedRows = moves.map((m) => b.rows.get(m.id)!).filter(Boolean);
  if (!b.take(opIndex, op, plan.movedIds.length)) { b.deferredOps++; return; }
  b.steps.push({ kind: 'move', opIndex, moves, label });
  const pick = [...new Set([0, Math.floor((movedRows.length - 1) / 2), movedRows.length - 1])].filter((i) => i >= 0);
  for (const i of pick) {
    const r = movedRows[i]!; const m = moves[i]!;
    const from = r.parentId ? b.rows.get(r.parentId)?.code ?? 'another item' : 'the top level';
    const to = m.parentId ? b.rows.get(m.parentId)?.code ?? 'another item' : 'the top level';
    b.example(opIndex, { code: r.code, field: 'place', before: `under ${from}`, after: `under ${to}` });
  }
  for (const u of plan.updates) b.patch(u.id, { parentId: u.parentId, displayOrder: u.displayOrder } as unknown as ReqPatch);
}

async function planReparent(b: Builder, opIndex: number, op: Op<'reparent_by_rule'>) {
  let parentId: string | null = null;
  if (op.newParent.id) { if (!b.rows.has(op.newParent.id)) return b.problem(opIndex, op, 'the new parent is not in this version'); parentId = op.newParent.id; }
  else if (op.newParent.code) { const p = b.index().byCode(op.newParent.code); if (!p) return b.problem(opIndex, op, `there is no item with the code ${op.newParent.code} to move them under`); parentId = p.id; }
  await noteForeignIds(b, op.filter.ids);
  const picked = matchFilter(b.index(), op.filter);
  if (picked.problems.length) { for (const p of picked.problems) b.problem(opIndex, op, p); return; }
  const movers = picked.rows.filter((r) => r.id !== parentId && r.parentId !== parentId);
  if (!movers.length) return;
  const ids = new Set(movers.map((m) => m.id));
  const idx = b.index();
  const existing = (idx.children.get(parentId) ?? []).filter((c) => !ids.has(c)).length;
  const room = b.budgetLeft();
  const take = movers.slice(0, Math.max(0, room));
  b.dropped += movers.length - take.length;
  if (!take.length) { b.deferredOps++; return; }
  const moves = take.map((r, i) => ({ id: r.id, parentId, index: op.position === 'start' ? i : existing + i }));
  const parentCode = parentId ? b.rows.get(parentId)?.code ?? '' : '';
  moveOutcome(b, opIndex, op, moves, parentId ? `Moved ${take.length} items under ${parentCode}` : `Moved ${take.length} items to the top level`);
}

async function planMove(b: Builder, opIndex: number, op: Op<'move'>) {
  const foreign = await foreignReasons(b, [...op.moves.map((m) => m.id), ...op.moves.flatMap((m) => (m.parentId ? [m.parentId] : []))]);
  const ok = op.moves.filter((m) => {
    const bad = foreign.get(m.id) ?? (m.parentId ? foreign.get(m.parentId) : undefined);
    if (bad) { b.skip(b.rows.get(m.id)?.code ?? bad.code, bad.reason); return false; }
    return true;
  });
  if (!ok.length) return;
  const moving = new Set(ok.map((m) => m.id));
  const counts = new Map<string | null, number>();
  const idx = b.index();
  const moves = ok.map((m) => {
    const base = counts.get(m.parentId) ?? 0;
    counts.set(m.parentId, base + 1);
    const siblings = (idx.children.get(m.parentId) ?? []).filter((c) => !moving.has(c)).length;
    return { id: m.id, parentId: m.parentId, index: m.index ?? siblings + base };
  });
  moveOutcome(b, opIndex, op, moves, `Moved ${moves.length} item${moves.length === 1 ? '' : 's'}`);
}

async function planDelete(b: Builder, opIndex: number, op: Op<'delete_by_filter'>) {
  await noteForeignIds(b, op.filter.ids);
  const picked = matchFilter(b.index(), op.filter);
  if (picked.problems.length) { for (const p of picked.problems) b.problem(opIndex, op, p); return; }
  const set = new Set(picked.rows.map((r) => r.id));
  const idx = b.index();
  const roots = picked.rows.filter((r) => !idx.hasAncestorIn(r.id, set));
  const keepRoots: { id: string; code: string; title: string; ids: string[]; notes: number }[] = [];
  let used = 0;
  for (const r of roots) {
    const ids = idx.subtree(r.id);
    if (used + ids.length > b.budgetLeft()) { b.dropped += ids.length; continue; }
    used += ids.length;
    keepRoots.push({ id: r.id, code: r.code, title: r.title, ids, notes: ids.reduce((n, id) => n + (b.noteCounts.get(id) ?? 0), 0) });
  }
  if (!keepRoots.length) { if (roots.length) b.deferredOps++; return; }
  b.take(opIndex, op, used);
  b.steps.push({ kind: 'delete', opIndex, ids: keepRoots.map((k) => k.id), codes: keepRoots.map((k) => k.code) });
  for (const k of keepRoots) {
    b.deletesCount++;
    if (b.deletes.length < DELETES_SHOWN) b.deletes.push({ code: k.code, title: clip(k.title, 100), subItems: k.ids.length - 1, notes: k.notes });
  }
  b.remove(keepRoots.flatMap((k) => k.ids));
}

async function planCreate(b: Builder, opIndex: number, op: Op<'create_requirement'>) {
  let parent: ReqRow | null = null;
  if (op.parentId) { parent = b.rows.get(op.parentId) ?? null; if (!parent) return b.problem(opIndex, op, 'the parent is not in this version'); }
  else if (op.parentCode) { parent = b.index().byCode(op.parentCode) ?? null; if (!parent) return b.problem(opIndex, op, `there is no item with the code ${op.parentCode} to put it under`); }
  const code = op.code.normalize('NFC').trim();
  if ([...b.rows.values()].some((r) => r.code === code)) return b.problem(opIndex, op, `the code ${code} is already used in this version`);
  const depth = parent ? b.index().depth(parent.id) + 1 : 0;
  const limits = limitsFor({ internal: b.v.internal, levelLabels: b.v.levelLabels });
  if (depth >= limits.maxLevels) return b.problem(opIndex, op, `it would be deeper than the ${limits.maxLevels} levels this version allows`);
  const levelLabel = op.levelLabel ?? b.v.levelLabels[depth] ?? parent?.levelLabel ?? b.v.levelLabels[0] ?? 'Standard';
  const siblings = b.index().children.get(parent?.id ?? null) ?? [];
  const displayOrder = siblings.reduce((n, id) => Math.max(n, (b.rows.get(id)?.displayOrder ?? -1) + 1), 0);
  if (!b.take(opIndex, op, 1)) { b.deferredOps++; return; }
  const tempId = b.nextTemp();
  const title = op.title.normalize('NFC').replace(/\s+/g, ' ').trim();
  b.steps.push({
    kind: 'create', opIndex, tempId, parentId: parent?.id ?? null, code, levelLabel, title, officialText: op.officialText?.normalize('NFC').trim() || null,
    isAssessable: op.isAssessable ?? true, language: op.language ?? 'en', displayOrder,
  });
  b.rows.set(tempId, {
    id: tempId, parentId: parent?.id ?? null, code, levelLabel, title, officialText: op.officialText ?? null, translationEn: null, language: op.language ?? 'en', isAssessable: op.isAssessable ?? true,
    displayOrder, origin: 'manual', sourceQuote: null, quoteVerified: false, editedByPerson: false,
  });
  b.dirty();
  b.example(opIndex, { code, field: 'new item', before: '(none)', after: `${code} ${clip(title, 100)}${parent ? ` under ${parent.code}` : ''}` });
}

async function planMerge(b: Builder, opIndex: number, op: Op<'merge'>) {
  const foreign = await foreignReasons(b, [op.id, op.intoId]);
  const bad = foreign.get(op.id) ?? foreign.get(op.intoId);
  if (bad) { b.skip(bad.code, bad.reason); return; }
  if (op.id === op.intoId) return b.problem(opIndex, op, 'choose another item to merge into');
  const src = b.rows.get(op.id)!; const dst = b.rows.get(op.intoId)!;
  const idx = b.index();
  if (idx.subtree(op.id).includes(op.intoId)) return b.problem(opIndex, op, `${dst.code} is inside ${src.code}; move it out first, or merge the other way round`);
  const kids = idx.children.get(op.id) ?? [];
  if (!b.take(opIndex, op, 1 + kids.length)) { b.deferredOps++; return; }
  b.steps.push({ kind: 'merge', opIndex, id: op.id, intoId: op.intoId, code: src.code, intoCode: dst.code, useMergedWording: op.useMergedWording });
  b.deletesCount++;
  if (b.deletes.length < DELETES_SHOWN) b.deletes.push({ code: src.code, title: clip(`${src.title} (merged into ${dst.code})`, 100), subItems: 0, notes: b.noteCounts.get(op.id) ?? 0 });
  const order = (idx.children.get(op.intoId) ?? []).length;
  kids.forEach((k, i) => b.patch(k, { parentId: op.intoId, displayOrder: order + i } as unknown as ReqPatch));
  b.noteCounts.set(op.intoId, (b.noteCounts.get(op.intoId) ?? 0) + (b.noteCounts.get(op.id) ?? 0));
  b.remove([op.id]);
  b.example(opIndex, { code: src.code, field: 'merged', before: clip(src.title, 80), after: `into ${dst.code}` });
}

async function planSplit(b: Builder, opIndex: number, op: Op<'split'>) {
  const foreign = await foreignReasons(b, [op.id]);
  const bad = foreign.get(op.id);
  if (bad) { b.skip(bad.code, bad.reason); return; }
  const row = b.rows.get(op.id)!;
  const text = row.officialText ?? '';
  const at = text.indexOf(op.part);
  if (at < 0) return b.problem(opIndex, op, `the part to move out is not in the text of ${row.code}`);
  const rest = `${text.slice(0, at)} ${text.slice(at + op.part.length)}`.replace(/\s{2,}/g, ' ').trim();
  if (!rest) return b.problem(opIndex, op, `choose only part of the text of ${row.code}: it would be left empty`);
  const code = op.code.normalize('NFC').trim();
  if ([...b.rows.values()].some((r) => r.code === code)) return b.problem(opIndex, op, `the code ${code} is already used in this version`);
  if (!b.take(opIndex, op, 2)) { b.deferredOps++; return; }
  const tempId = b.nextTemp();
  b.steps.push({ kind: 'split', opIndex, tempId, id: op.id, code: row.code, part: op.part, newCode: code, title: op.title ?? null });
  b.patch(op.id, { officialText: rest });
  b.rows.set(tempId, { ...row, id: tempId, code, title: op.title ?? code, officialText: op.part, displayOrder: row.displayOrder + 1, origin: 'manual', editedByPerson: false });
  b.dirty();
  b.example(opIndex, { code: row.code, field: 'split', before: clip(text, 100), after: `${code}: ${clip(op.part, 100)}` });
}

async function planNotes(b: Builder, opIndex: number, op: Op<'set_note_fields'>) {
  if (!b.ctx) return b.problem(opIndex, op, 'notes need the database');
  const ctx = b.ctx;
  let notes;
  if (op.noteIds) notes = await ctx.tx.select().from(requirementNote).where(inArray(requirementNote.id, op.noteIds));
  else {
    await noteForeignIds(b, op.requirements?.ids);
    const picked = matchFilter(b.index(), op.requirements);
    if (picked.problems.length) { for (const p of picked.problems) b.problem(opIndex, op, p); return; }
    notes = picked.rows.length ? await ctx.tx.select().from(requirementNote).where(inArray(requirementNote.requirementId, picked.rows.map((r) => r.id))) : [];
  }
  if (op.noteIds) for (const id of op.noteIds) if (!notes.some((n) => n.id === id)) b.skip(null, 'a note does not exist, or you cannot see it');
  const todo: { n: (typeof notes)[number]; req: ReqRow; text?: string; type?: string; authority?: string }[] = [];
  for (const n of notes) {
    const req = b.rows.get(n.requirementId);
    if (!req) { b.skip(null, 'a note belongs to another version (or a published one), which this change set does not touch'); continue; }
    if (op.noteType && n.type !== op.noteType) continue;
    if (op.authority && n.authority !== op.authority) continue;
    const text = op.set.text !== undefined ? op.set.text.normalize('NFC').trim() : undefined;
    const t: { n: typeof n; req: ReqRow; text?: string; type?: string; authority?: string } = { n, req };
    if (text !== undefined && text !== n.text) t.text = text;
    if (op.set.type !== undefined && op.set.type !== n.type) t.type = op.set.type;
    if (op.set.authority !== undefined && op.set.authority !== n.authority) {
      if (op.set.authority === 'required' && !(n.sourceDocumentId && n.sourcePage && n.sourceQuote && n.quoteVerified)) { b.skip(req.code, 'a "required" note needs a quote that is found on its source page'); continue; }
      t.authority = op.set.authority;
    }
    if (t.text !== undefined || t.type !== undefined || t.authority !== undefined) todo.push(t);
  }
  const room = b.budgetLeft();
  const take = todo.slice(0, Math.max(0, room));
  b.dropped += todo.length - take.length;
  if (!take.length) { if (todo.length) b.deferredOps++; return; }
  b.take(opIndex, op, take.length);
  for (const t of take) {
    if (t.text !== undefined || t.type !== undefined) {
      b.steps.push({
        kind: 'note_fields', opIndex, id: t.n.id, requirementCode: t.req.code,
        set: { ...(t.text !== undefined ? { text: t.text } : {}), ...(t.type !== undefined ? { type: t.type } : {}) },
        was: { ...(t.text !== undefined ? { text: t.n.text } : {}), ...(t.type !== undefined ? { type: t.n.type } : {}) },
      });
    }
    if (t.authority !== undefined) b.steps.push({ kind: 'note_authority', opIndex, id: t.n.id, requirementCode: t.req.code, authority: t.authority, was: t.n.authority });
  }
  const pick = [...new Set([0, Math.floor((take.length - 1) / 2), take.length - 1])].filter((i) => i >= 0);
  for (const i of pick) {
    const t = take[i]!;
    const field = t.text !== undefined ? 'text' : t.type !== undefined ? 'type' : 'authority';
    b.example(opIndex, { code: t.req.code, field: `note ${field}`, before: show(field, field === 'text' ? t.n.text : field === 'type' ? t.n.type : t.n.authority), after: show(field, t[field as 'text' | 'type' | 'authority']) });
  }
}

async function planLinks(b: Builder, opIndex: number, op: Op<'accept_suggested_links' | 'dismiss_suggested_links'>) {
  if (!b.ctx) return b.problem(opIndex, op, 'links need the database');
  const ctx = b.ctx;
  if (b.v.internal) return b.problem(opIndex, op, 'suggested links are made from an external standard, not from the quality framework');
  if (!(await isPermitted(ctx.tx, 'framework:review', { type: 'institution' }))) return b.problem(opIndex, op, 'you need permission to review links to accept or dismiss them');
  const accept = op.op === 'accept_suggested_links';
  const rows = await ctx.tx.select().from(requirementMapping).where(eq(requirementMapping.frameworkId, b.v.frameworkId));
  const codes = new Set([...b.rows.values()].map((r) => r.code));
  const suggested = rows.filter((m) => m.origin === 'ai' && m.reviewStatus === 'pending' && codes.has(m.externalCode));
  let chosen = suggested;
  if (op.mappingIds) {
    const byId = new Map(rows.map((m) => [m.id, m]));
    chosen = [];
    for (const id of op.mappingIds) {
      const m = byId.get(id);
      if (!m) b.skip(null, 'a link does not exist, or belongs to another standard');
      else if (!suggested.includes(m)) b.skip(m.externalCode, `the link to ${m.internalCode} is not a pending suggestion`);
      else chosen.push(m);
    }
  } else {
    const relation = op.relation ?? (accept ? 'covers' : undefined);
    if (relation) chosen = suggested.filter((m) => m.relation === relation);
  }
  const room = b.budgetLeft();
  const take = chosen.slice(0, Math.max(0, room));
  b.dropped += chosen.length - take.length;
  if (!take.length) { if (chosen.length) b.deferredOps++; return; }
  b.take(opIndex, op, take.length);
  for (const m of take) b.steps.push({ kind: 'link_review', opIndex, id: m.id, externalCode: m.externalCode, internalCode: m.internalCode, decision: accept ? 'approved' : 'rejected' });
  const pick = [...new Set([0, Math.floor((take.length - 1) / 2), take.length - 1])].filter((i) => i >= 0);
  for (const i of pick) { const m = take[i]!; b.example(opIndex, { code: m.externalCode, field: `link to ${m.internalCode}`, before: 'suggested', after: accept ? 'accepted' : 'dismissed' }); }
}

// ---- A new draft ---------------------------------------------------------------------------------------------------------------
async function planDraft(ctx: Ctx, v: VersionFacts, op: Op<'create_draft'>): Promise<Plan> {
  const b = new Builder(ctx, v, [], new Map());
  const edition = op.edition.normalize('NFC').trim();
  const [clash] = await ctx.tx.select({ id: frameworkVersion.id }).from(frameworkVersion).where(and(eq(frameworkVersion.frameworkId, v.frameworkId), eq(frameworkVersion.edition, edition)));
  if (clash) b.problems.push(`${OP_LABELS.create_draft}: an edition named ${edition} already exists in this standard; choose another name`);
  const [n] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(requirement).where(eq(requirement.frameworkVersionId, v.id));
  b.perOp.push({ opIndex: 0, op: op.op, label: OP_LABELS.create_draft, items: 1 });
  b.items = 1;
  b.steps.push({ kind: 'new_draft', opIndex: 0, sourceVersionId: v.id, edition, changeSummary: op.changeSummary ?? null });
  b.warnings.push(`The new draft starts as a copy of ${v.label} (${n?.n ?? 0} items, with their notes and report templates). The ${v.status} version itself is not changed.`);
  return finish(b, v, { edition });
}

// ---- Entry point --------------------------------------------------------------------------------------------------------------
function finish(b: Builder, v: VersionFacts, newDraft: { edition: string } | null): Plan {
  const examples: ChangeExample[] = [];
  for (const list of b.examples.values()) examples.push(...list.slice(0, 3));
  const counts: ChangeCounts = {
    items: b.items, byOperation: b.perOp.map((p) => ({ op: p.op, label: p.label, items: p.items })), deletes: b.deletesCount, linksByCode: b.linksByCode, writtenByAssistant: b.written.length,
  };
  return {
    versionId: v.id, versionLabel: v.label, steps: b.steps, perOp: b.perOp, items: b.items, examples: examples.slice(0, 9), skipped: b.skipped, skippedCount: b.skippedCount,
    deletes: b.deletes, deletesCount: b.deletesCount, warnings: b.warnings, problems: b.problems, remaining: b.dropped + b.deferredOps, linksByCode: b.linksByCode,
    written: b.written, newDraft, planHash: hashOf(b.steps), counts,
  };
}

/**
 * Plans a change set on the data as it is now. Never writes. `problems` empty means the operations can be applied as planned.
 * Throws ForbiddenError when the person may not write standards at all, NotFoundError for a version they cannot see.
 */
/**
 * The planner proper, on rows already in memory (no database when `ctx` is null: the operations that need one report so). Used by
 * planChangeSet, and by the evaluation set, which runs every recipe over a fixture tree.
 */
export async function planOperations(ctx: Ctx | null, v: VersionFacts, rows: ReqRow[], noteCounts: Map<string, number>, operations: readonly Operation[]): Promise<Plan> {
  const b = new Builder(ctx, v, rows, noteCounts);
  for (const [i, op] of operations.entries()) {
    if (b.dropped > 0 && b.budgetLeft() <= 0) { b.deferredOps++; continue; }
    await planOp(b, i, op);
  }
  if (b.items === 0 && b.problems.length === 0) b.warnings.push('Nothing matched: no item would change.');
  if (b.dropped + b.deferredOps > 0) b.warnings.push(`This is more than ${MAX_ITEM_CHANGES} item changes, the most one step may make. This step makes ${b.items}; ask again for the rest afterwards.`);
  return finish(b, v, null);
}

/**
 * Plans a change set on the data as it is now. Never writes. `problems` empty means the operations can be applied as planned.
 * Throws ForbiddenError when the person may not write standards at all, NotFoundError for a version they cannot see.
 */
export async function planChangeSet(ctx: Ctx, input: ChangeSetInput): Promise<Plan> {
  await require_(ctx, 'framework:write');
  const v = await loadVersionFacts(ctx, input.versionId);
  const first = input.operations[0];
  if (first?.op === 'create_draft') return planDraft(ctx, v, first);
  if (v.status === 'published' || v.status === 'retired') {
    const b = new Builder(ctx, v, [], new Map());
    b.skip(null, `${v.label} is a ${v.status} version and is read-only`);
    b.problems.push(`${v.label} is ${v.status === 'published' ? 'published' : 'retired'}, so it cannot be changed. Start a new draft version from it first (create_draft_proposal), then make the changes in the draft.`);
    return finish(b, v, null);
  }
  const { rows, noteCounts } = await loadRows(ctx, v.id);
  return planOperations(ctx, v, rows, noteCounts, input.operations);
}
