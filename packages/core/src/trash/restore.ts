// The restore side of the Trash (DEC-026). Rows go back with their original ids, in dependency order, in the caller's
// transaction, so a refusal anywhere puts nothing back. The rules (each with its own message):
//  * a frozen (published or retired) version takes nothing back: "Cannot restore: the version is no longer a draft";
//  * a requirement whose parent is gone is not guessed at: the refusal lists the choice (under the nearest ancestor that
//    still exists, or at the top level) and `placeParentId` / `atTopLevel` take it;
//  * a code taken in the meantime: by default the restored one gets "<code> (restored)" (then "(restored 2)"...) and the
//    result says so; `codeConflict: 'refuse'` stops instead. Links keyed by the old code are not brought back for it;
//  * links to other standards whose other side is gone, or that already exist, are dropped and counted;
//  * an AI-made requirement or note that comes back is visible to the analysis again (the database clears its dismissal).
import { and, eq, sql } from 'drizzle-orm';
import { frameworkVersion, trashItem } from '@ams/db';
import { plural, type RestoreChoice, type RestoreOptions, type RestoreResult } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError } from '../ctx.js';
import { assertPermitted } from '../permissions.js';
import { require_ } from '../framework/common.js';
import { relabelByDepth } from '../framework/requirements.js';
import { existing, idsOf, insertRows, texts, TRASH_TABLES, uuids, type Row, type TrashPayload, type Tables } from './rows.js';

type ItemRow = typeof trashItem.$inferSelect;

interface Outcome {
  restored: Record<string, number>;
  dropped: Record<string, number>;
  renamed: { from: string; to: string }[];
  placedUnder: string | null;
  notes: string[];
}
const blank = (): Outcome => ({ restored: {}, dropped: {}, renamed: [], placedUnder: null, notes: [] });
const add = (o: Record<string, number>, k: string, n: number) => { if (n) o[k] = (o[k] ?? 0) + n; };
const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** Conflict that carries the choice a restore needs (the API sends `details` with the 409). */
function choiceError(message: string, choice: RestoreChoice): ConflictError {
  return new ConflictError(message, choice as unknown as Record<string, unknown>);
}

// ---- Shared steps ---------------------------------------------------------------------------------------------------

async function openVersion(ctx: Ctx, versionId: string) {
  const [v] = await ctx.tx.select({ id: frameworkVersion.id, status: frameworkVersion.status, edition: frameworkVersion.edition }).from(frameworkVersion).where(eq(frameworkVersion.id, versionId));
  if (!v) throw new ConflictError('Cannot restore: the version it belonged to was deleted. Restore that version from the Trash first.');
  if (v.status === 'published' || v.status === 'retired') {
    throw new ConflictError(`Cannot restore: the version is no longer a draft (it is ${v.status}). A ${v.status} version cannot be changed; copy what you need into a new version.`);
  }
  return v;
}

/** A citation of a source document that has since been deleted cannot be kept: drop the citation, and the claim that its quote was verified. */
async function dropMissingSources(ctx: Ctx, rows: Row[], out: Outcome): Promise<Row[]> {
  const docIds = [...new Set(rows.map((r) => r.source_document_id).filter((x): x is string => typeof x === 'string'))];
  if (!docIds.length) return rows;
  const live = await existing(ctx, 'source_document', docIds);
  let n = 0;
  const fixed = rows.map((r) => {
    if (typeof r.source_document_id !== 'string' || live.has(r.source_document_id)) return r;
    n += 1;
    return { ...r, source_document_id: null, source_page: null, quote_verified: false };
  });
  if (n) out.notes.push(`${plural(n, 'citation')} of a source that was deleted in the meantime could not be kept`);
  return fixed;
}

/** Mappings come back when both standards still have the code they name and an identical one does not exist already. */
async function restoreMappings(ctx: Ctx, rows: Row[], skipCodes: Set<string>, out: Outcome): Promise<{ inserted: number; missing: number; duplicate: number }> {
  const result = { inserted: 0, missing: 0, duplicate: 0 };
  const keep: Row[] = [];
  for (const m of rows) {
    const codeLive = async (frameworkId: unknown, code: unknown) => {
      const r = await ctx.tx.execute<{ n: number }>(sql`select count(*)::int n from requirement r join framework_version v on v.id = r.framework_version_id where v.framework_id = ${String(frameworkId)} and r.code = ${String(code)}`);
      return (r.rows[0]?.n ?? 0) > 0;
    };
    if (skipCodes.has(text(m.external_code)) || skipCodes.has(text(m.internal_code))) { result.missing += 1; continue; }
    if (!(await codeLive(m.framework_id, m.external_code)) || !(await codeLive(m.internal_framework_id, m.internal_code))) { result.missing += 1; continue; }
    const dup = await ctx.tx.execute<{ n: number }>(sql`select count(*)::int n from requirement_mapping where framework_id = ${String(m.framework_id)} and external_code = ${String(m.external_code)} and internal_code = ${String(m.internal_code)}`);
    if ((dup.rows[0]?.n ?? 0) > 0) { result.duplicate += 1; continue; }
    keep.push(m);
  }
  await insertRows(ctx, 'requirement_mapping', keep);
  result.inserted = keep.length;
  add(out.restored, 'mappings', keep.length);
  add(out.dropped, 'mappings', result.missing + result.duplicate);
  return result;
}

async function restoreRefs(ctx: Ctx, payload: TrashPayload) {
  for (const r of payload.refs) {
    if (r.table === 'iqf_item_proposal' || r.table === 'evidence_request') {
      // Only where the pointer is still empty and the thing it pointed to is back.
      const target = r.column === 'accepted_requirement_id' ? 'requirement' : 'evidence_link';
      await ctx.tx.execute(sql`update ${sql.identifier(r.table)} set ${sql.identifier(r.column)} = ${r.value}::uuid
        where id = ${r.id}::uuid and ${sql.identifier(r.column)} is null and exists (select 1 from ${sql.identifier(target)} where id = ${r.value}::uuid)`);
    }
  }
}

/** Inserts everything a payload holds, in dependency order. */
async function insertAll(ctx: Ctx, tables: Tables, skip: ReadonlySet<string> = new Set()) {
  for (const name of TRASH_TABLES) if (!skip.has(name)) await insertRows(ctx, name, tables[name] ?? []);
}

// ---- Requirements ---------------------------------------------------------------------------------------------------

async function restoreRequirements(ctx: Ctx, item: ItemRow, payload: TrashPayload, opts: RestoreOptions): Promise<Outcome> {
  await require_(ctx, 'framework:write');
  const out = blank();
  const root = payload.root as { versionId: string; rootIds: string[]; parentId: string | null; ancestors?: { id: string; code: string; title: string }[] };
  await openVersion(ctx, root.versionId);
  let rows = (payload.tables.requirement ?? []).map((r) => ({ ...r }));
  const rootIds = new Set(root.rootIds);
  const inPayload = new Set(idsOf(rows));
  let relabel = false;

  // Where do the roots go?
  for (const r of rows.filter((x) => rootIds.has(String(x.id)))) {
    const parentId = typeof r.parent_id === 'string' ? r.parent_id : null;
    if (!parentId || inPayload.has(parentId)) continue;
    if ((await existing(ctx, 'requirement', [parentId])).has(parentId)) continue;
    const ancestors = root.ancestors ?? [];
    const alive = await existing(ctx, 'requirement', ancestors.map((a) => a.id));
    const nearest = ancestors.find((a) => alive.has(a.id)) ?? null;
    if (opts.placeParentId) {
      const [p] = (await ctx.tx.execute<{ id: string; framework_version_id: string; code: string }>(sql`select id, framework_version_id, code from requirement where id = ${opts.placeParentId}`)).rows;
      if (!p || p.framework_version_id !== root.versionId) throw new ConflictError('Cannot restore: the requirement chosen to put it under is not in this version');
      r.parent_id = p.id; out.placedUnder = p.code; relabel = true;
    } else if (opts.atTopLevel) {
      r.parent_id = null; out.placedUnder = 'the top level'; relabel = true;
    } else {
      const parentLabel = ancestors[0] ? `${ancestors[0].code} · ${ancestors[0].title}` : null;
      throw choiceError(
        `Cannot restore ${text(r.code)}: ${parentLabel ?? 'the requirement it sat under'} no longer exists. Restore that from the Trash first, or choose ${nearest ? `to put it under ${nearest.code}` : 'to put it at the top level'}.`,
        { code: 'parent_missing', itemId: item.id, parentLabel, nearestAncestor: nearest ? { id: nearest.id, label: `${nearest.code} · ${nearest.title}` } : null },
      );
    }
  }

  // Codes taken in the meantime.
  const codes = rows.map((r) => text(r.code));
  const taken = new Set((await ctx.tx.execute<{ code: string }>(sql`select code from requirement where framework_version_id = ${root.versionId} and code = any(${texts(codes)})`)).rows.map((r) => r.code));
  const renamedOld = new Set<string>();
  if (taken.size) {
    if (opts.codeConflict === 'refuse') {
      const first = rows.find((r) => taken.has(text(r.code)))!;
      throw choiceError(`Cannot restore ${text(first.code)}: the code ${text(first.code)} is used again in this version. Rename the other one, or restore with a new code.`,
        { code: 'code_taken', itemId: item.id, parentLabel: null, nearestAncestor: null });
    }
    const used = new Set([...taken, ...codes]);
    rows = rows.map((r) => {
      const code = text(r.code);
      if (!taken.has(code)) return r;
      let n = 1;
      let candidate = `${code} (restored)`;
      while (used.has(candidate)) { n += 1; candidate = `${code} (restored ${n})`; }
      used.add(candidate);
      out.renamed.push({ from: code, to: candidate });
      renamedOld.add(code);
      return { ...r, code: candidate };
    });
  }

  rows = await dropMissingSources(ctx, rows, out);
  const notes = await dropMissingSources(ctx, payload.tables.requirement_note ?? [], out);
  await insertRows(ctx, 'requirement', rows);
  await insertRows(ctx, 'requirement_note', notes);
  add(out.restored, 'requirements', rows.length);
  add(out.restored, 'notes', notes.length);
  await restoreMappings(ctx, payload.tables.requirement_mapping ?? [], renamedOld, out);
  await restoreRefs(ctx, payload);

  const merge = payload.meta?.merge as MergeMeta | undefined;
  if (merge && opts.revertMerge !== false) await revertMerge(ctx, merge, root.rootIds[0]!, out);
  if (relabel || merge) await relabelByDepth(ctx, root.versionId);
  return out;
}

/** What a merge records so it can be undone: the children and notes it moved and the target as it was. */
export interface MergeMeta {
  intoId: string;
  useMergedWording?: boolean;
  children: { id: string; displayOrder: number }[];
  noteIds: string[];
  targetBefore: Record<string, unknown> | null;
}

async function revertMerge(ctx: Ctx, m: MergeMeta, restoredId: string, out: Outcome) {
  let kids = 0;
  for (const c of m.children) {
    const r = await ctx.tx.execute(sql`update requirement set parent_id = ${restoredId}::uuid, display_order = ${c.displayOrder} where id = ${c.id}::uuid and parent_id = ${m.intoId}::uuid`);
    kids += r.rowCount ?? 0;
  }
  let notes = 0;
  if (m.noteIds.length) {
    const r = await ctx.tx.execute(sql`update requirement_note set requirement_id = ${restoredId}::uuid where id = any(${uuids(m.noteIds)}) and requirement_id = ${m.intoId}::uuid`);
    notes = r.rowCount ?? 0;
  }
  const b = m.targetBefore;
  if (b) {
    await ctx.tx.execute(sql`update requirement set title = ${b.title as string}, official_text = ${(b.official_text as string | null) ?? null}, language = ${b.language as string},
      source_document_id = ${(b.source_document_id as string | null) ?? null}::uuid, source_page = ${(b.source_page as number | null) ?? null}, source_quote = ${(b.source_quote as string | null) ?? null},
      quote_verified = ${b.quote_verified as boolean}, review_status = ${b.review_status as string}, reviewed_by = ${(b.reviewed_by as string | null) ?? null}::uuid,
      reviewed_at = ${(b.reviewed_at as string | null) ?? null}::timestamptz where id = ${m.intoId}::uuid`);
  }
  if (kids || notes) out.notes.push(`${plural(kids, 'sub-item')} and ${plural(notes, 'note')} moved back`);
}

// ---- Other kinds ----------------------------------------------------------------------------------------------------

async function restoreNote(ctx: Ctx, payload: TrashPayload): Promise<Outcome> {
  await require_(ctx, 'framework:write');
  const out = blank();
  const root = payload.root as { versionId: string; requirementId: string; requirement: string };
  await openVersion(ctx, root.versionId);
  if (!(await existing(ctx, 'requirement', [root.requirementId])).has(root.requirementId)) {
    throw new ConflictError(`Cannot restore: the requirement this note belonged to (${root.requirement}) no longer exists. Restore that from the Trash first.`);
  }
  const notes = await dropMissingSources(ctx, payload.tables.requirement_note ?? [], out);
  await insertRows(ctx, 'requirement_note', notes);
  add(out.restored, 'notes', notes.length);
  return out;
}

async function restoreSourceDocument(ctx: Ctx, payload: TrashPayload): Promise<Outcome> {
  await require_(ctx, 'framework:write');
  const out = blank();
  await openVersion(ctx, String((payload.root as { versionId: string }).versionId));
  const proposals = (payload.tables.extraction_item ?? []).map((p) => ({ ...p }));
  const runs = await existing(ctx, 'analysis_run', proposals.map((p) => p.analysis_run_id).filter((x): x is string => typeof x === 'string'));
  for (const p of proposals) if (typeof p.analysis_run_id === 'string' && !runs.has(p.analysis_run_id)) p.analysis_run_id = null;
  await insertRows(ctx, 'source_document', payload.tables.source_document ?? []);
  await insertRows(ctx, 'source_page', payload.tables.source_page ?? []);
  await insertRows(ctx, 'extraction_item', proposals);
  add(out.restored, 'documents', 1);
  add(out.restored, 'pages', payload.tables.source_page?.length ?? 0);
  return out;
}

async function restoreSourcePage(ctx: Ctx, payload: TrashPayload): Promise<Outcome> {
  await require_(ctx, 'framework:write');
  const out = blank();
  const root = payload.root as { versionId: string; documentId: string; pageNo: number };
  await openVersion(ctx, root.versionId);
  if (!(await existing(ctx, 'source_document', [root.documentId])).has(root.documentId)) throw new ConflictError('Cannot restore: the source document this page belonged to was deleted. Restore that from the Trash first.');
  const taken = await ctx.tx.execute<{ n: number }>(sql`select count(*)::int n from source_page where source_document_id = ${root.documentId}::uuid and page_no = ${root.pageNo}`);
  if ((taken.rows[0]?.n ?? 0) > 0) throw new ConflictError(`Cannot restore: page ${root.pageNo} has been added again.`);
  await insertRows(ctx, 'source_page', payload.tables.source_page ?? []);
  add(out.restored, 'pages', 1);
  return out;
}

async function restoreTemplate(ctx: Ctx, payload: TrashPayload): Promise<Outcome> {
  await require_(ctx, 'framework:write');
  const out = blank();
  const root = payload.root as { versionId: string; key: string };
  await openVersion(ctx, root.versionId);
  const taken = await ctx.tx.execute<{ n: number }>(sql`select count(*)::int n from report_template where framework_version_id = ${root.versionId}::uuid and key = ${root.key}`);
  if ((taken.rows[0]?.n ?? 0) > 0) throw new ConflictError(`Cannot restore: a report template with the key ${root.key} exists again in this version.`);
  const rows = await dropMissingSources(ctx, payload.tables.report_template ?? [], out);
  await insertRows(ctx, 'report_template', rows);
  add(out.restored, 'templates', 1);
  return out;
}

async function restoreMapping(ctx: Ctx, payload: TrashPayload): Promise<Outcome> {
  await require_(ctx, 'framework:write');
  const out = blank();
  const r = await restoreMappings(ctx, payload.tables.requirement_mapping ?? [], new Set(), out);
  if (r.duplicate) throw new ConflictError('Cannot restore: the same link exists again.');
  if (r.missing) throw new ConflictError('Cannot restore: one of the standards it linked no longer exists.');
  return out;
}

/** A whole version or a whole standard: everything it held goes back; a version comes back as a draft. */
async function restoreVersionOrFramework(ctx: Ctx, item: ItemRow, payload: TrashPayload): Promise<Outcome> {
  await require_(ctx, 'framework:write');
  const out = blank();
  const tables: Tables = { ...payload.tables };
  const root = payload.root as { frameworkId: string; accreditorId?: string };
  if (item.kind === 'framework') {
    const acc = (await ctx.tx.execute<{ n: number }>(sql`select count(*)::int n from accreditor where id = ${root.accreditorId ?? null}::uuid`)).rows[0]?.n ?? 0;
    if (!acc) throw new ConflictError('Cannot restore: the accreditor it belonged to no longer exists.');
  } else {
    const fw = (await ctx.tx.execute<{ n: number }>(sql`select count(*)::int n from framework where id = ${root.frameworkId}::uuid`)).rows[0]?.n ?? 0;
    if (!fw) throw new ConflictError('Cannot restore: the standard this version belonged to was deleted. Restore that standard from the Trash first.');
  }
  const versionRows: Row[] = (tables.framework_version ?? []).map((v): Row => ({ ...v, status: 'draft', published_by: null, published_at: null }));
  const liveVersions = new Set((await ctx.tx.execute<{ id: string }>(sql`select id from framework_version where framework_id = ${root.frameworkId}::uuid`)).rows.map((r) => r.id));
  const editions = new Set((await ctx.tx.execute<{ edition: string }>(sql`select edition from framework_version where framework_id = ${root.frameworkId}::uuid`)).rows.map((r) => r.edition));
  const clash = versionRows.find((v) => editions.has(text(v.edition)));
  if (clash) throw new ConflictError(`Cannot restore: this standard already has a version ${text(clash.edition)}. Rename or delete that one first.`);
  const here = new Set(idsOf(versionRows));
  for (const v of versionRows) if (typeof v.supersedes_id === 'string' && !here.has(v.supersedes_id) && !liveVersions.has(v.supersedes_id)) v.supersedes_id = null;
  tables.framework_version = versionRows;
  tables.source_document = await dropMissingSources(ctx, tables.source_document ?? [], out);
  tables.requirement = await dropMissingSources(ctx, tables.requirement ?? [], out);
  tables.requirement_note = await dropMissingSources(ctx, tables.requirement_note ?? [], out);
  tables.report_template = await dropMissingSources(ctx, tables.report_template ?? [], out);
  const mappings = tables.requirement_mapping ?? [];
  await insertAll(ctx, tables, new Set(['requirement_mapping']));
  await restoreMappings(ctx, mappings, new Set(), out);
  await restoreRefs(ctx, payload);
  add(out.restored, 'versions', versionRows.length);
  add(out.restored, 'requirements', tables.requirement.length);
  add(out.restored, 'notes', tables.requirement_note.length);
  add(out.restored, 'documents', tables.source_document.length);
  if (versionRows.some((v) => (payload.tables.framework_version ?? []).find((o) => o.id === v.id)?.status === 'in_review')) out.notes.push('a version that was in review comes back as a draft');
  return out;
}

async function restoreEvidenceLink(ctx: Ctx, payload: TrashPayload): Promise<Outcome> {
  const out = blank();
  const row = (payload.tables.evidence_link ?? [])[0]!;
  const root = payload.root as { engagementRequirementId: string | null };
  if (root.engagementRequirementId) {
    const [er] = (await ctx.tx.execute<{ engagement_id: string }>(sql`select engagement_id from engagement_requirement where id = ${root.engagementRequirementId}::uuid`)).rows;
    if (!er) throw new ConflictError('Cannot restore: the requirement this evidence was linked to no longer exists.');
    await assertPermitted(ctx, 'engagement:work', { type: 'engagement', id: er.engagement_id });
    const [e] = (await ctx.tx.execute<{ status: string }>(sql`select status from engagement where id = ${er.engagement_id}::uuid`)).rows;
    if (e?.status !== 'active') throw new ConflictError(`Cannot restore: the engagement is ${e?.status ?? 'gone'}.`);
  } else await assertPermitted(ctx, 'evidence:write', { type: 'any' });
  if (!(await ctx.tx.execute<{ id: string }>(sql`select id from evidence_version where id = ${String(row.evidence_version_id)}::uuid`)).rows.length) {
    throw new ConflictError('Cannot restore: the evidence version no longer exists.');
  }
  const dup = await ctx.tx.execute<{ n: number }>(sql`select count(*)::int n from evidence_link where evidence_version_id = ${String(row.evidence_version_id)}::uuid
    and (engagement_requirement_id is not distinct from ${(row.engagement_requirement_id as string | null) ?? null}::uuid) and (internal_code is not distinct from ${(row.internal_code as string | null) ?? null})`);
  if ((dup.rows[0]?.n ?? 0) > 0) throw new ConflictError('Cannot restore: this evidence has been linked there again.');
  await insertRows(ctx, 'evidence_link', [row]);
  await restoreRefs(ctx, payload);
  add(out.restored, 'evidenceLinks', 1);
  return out;
}

async function restoreMilestone(ctx: Ctx, payload: TrashPayload): Promise<Outcome> {
  const out = blank();
  const row = (payload.tables.milestone ?? [])[0]!;
  const engagementId = String((payload.root as { engagementId: string }).engagementId);
  await assertPermitted(ctx, 'engagement:manage', { type: 'engagement', id: engagementId });
  const [e] = (await ctx.tx.execute<{ status: string }>(sql`select status from engagement where id = ${engagementId}::uuid`)).rows;
  if (!e) throw new ConflictError('Cannot restore: the engagement no longer exists.');
  if (e.status !== 'active') throw new ConflictError(`Cannot restore: the engagement is ${e.status}.`);
  await insertRows(ctx, 'milestone', [row]);
  add(out.restored, 'milestones', 1);
  return out;
}

// ---- Entry points ---------------------------------------------------------------------------------------------------

/** Restores one Trash row (the caller marks it restored). */
export async function restoreRow(ctx: Ctx, item: ItemRow, opts: RestoreOptions): Promise<Outcome> {
  const payload = item.payload as TrashPayload;
  switch (item.kind) {
    case 'requirement': return restoreRequirements(ctx, item, payload, opts);
    case 'note': return restoreNote(ctx, payload);
    case 'source_document': return restoreSourceDocument(ctx, payload);
    case 'source_page': return restoreSourcePage(ctx, payload);
    case 'report_template': return restoreTemplate(ctx, payload);
    case 'framework_version':
    case 'framework': return restoreVersionOrFramework(ctx, item, payload);
    case 'mapping': return restoreMapping(ctx, payload);
    case 'evidence_link': return restoreEvidenceLink(ctx, payload);
    case 'milestone': return restoreMilestone(ctx, payload);
  }
}

/** The kinds in the order a group is restored: what others hang from first. */
export const RESTORE_ORDER = ['framework', 'framework_version', 'source_document', 'source_page', 'requirement', 'note', 'report_template', 'mapping', 'evidence_link', 'milestone'] as const;

export function mergeOutcomes(parts: Outcome[]): Pick<RestoreResult, 'restored' | 'dropped' | 'renamed' | 'placedUnder'> & { notes: string[] } {
  const o = blank();
  for (const p of parts) {
    for (const [k, n] of Object.entries(p.restored)) add(o.restored, k, n);
    for (const [k, n] of Object.entries(p.dropped)) add(o.dropped, k, n);
    o.renamed.push(...p.renamed);
    o.placedUnder = p.placedUnder ?? o.placedUnder;
    o.notes.push(...p.notes);
  }
  return o;
}

export async function markRestored(ctx: Ctx, id: string) {
  await ctx.tx.update(trashItem).set({ restoredAt: new Date(), payload: { v: 1, restored: true } }).where(and(eq(trashItem.id, id), sql`${trashItem.restoredAt} is null`));
}

export function notFoundGroup(id: string): never {
  throw new NotFoundError(`nothing in the Trash with the id ${id} (it may have been restored or removed already)`);
}
