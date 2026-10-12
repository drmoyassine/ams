// The delete side of the Trash (DEC-026): every deletion a person can do in the library writes a snapshot of what goes
// (the rows of the whole subtree with their dependents, as stored) and deletes the rows, in ONE transaction through the
// normal chain. The rows keep their ids so a restore puts them back exactly. Files in storage are not touched here: the
// purge removes them after the item expires.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accreditor, engagement, framework, frameworkVersion, requirement } from '@ams/db';
import { plural, type DeleteResult, type DeletePreview, type TrashKind } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { assertHuman, getDraftVersion, require_ } from '../framework/common.js';
import {
  deleteRows, deleteTables, emptyPayload, idsOf, readRows, readWhere, texts, uuids, type Row, type Tables, type TrashPayload, type TrashRef,
} from './rows.js';
import { insideWords, joinWords, reportUndo, restoreUndo, TRASH_RETENTION_DAYS, writeTrash, type NewTrashItem } from './store.js';

// ---- Shared helpers -----------------------------------------------------------------------------------------------

export interface VersionInfo {
  id: string; frameworkId: string; edition: string; status: string; internal: boolean; frameworkName: string; accreditorShort: string;
}
export async function versionInfo(ctx: Ctx, versionId: string): Promise<VersionInfo> {
  const [r] = await ctx.tx.select({
    id: frameworkVersion.id, frameworkId: frameworkVersion.frameworkId, edition: frameworkVersion.edition, status: frameworkVersion.status,
    internal: framework.internal, frameworkName: framework.name, accreditorShort: accreditor.shortName,
  }).from(frameworkVersion).innerJoin(framework, eq(framework.id, frameworkVersion.frameworkId)).innerJoin(accreditor, eq(accreditor.id, framework.accreditorId))
    .where(eq(frameworkVersion.id, versionId));
  if (!r) throw new NotFoundError(`framework version ${versionId}`);
  return r;
}
/** Where something sat, in words: "Internal Quality Framework" or "Council Handbook 2023". */
export const placeOf = (v: VersionInfo) => (v.internal ? v.frameworkName : `${v.accreditorShort} ${v.frameworkName} ${v.edition}`.trim());

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Codes of a framework that no requirement outside `excludeIds` has in any version. Mappings and the like are keyed by code
 * within the framework, so they go with a code only when the last requirement bearing it goes.
 */
async function orphanCodes(ctx: Ctx, frameworkId: string, codes: string[], excludeIds: string[]): Promise<Set<string>> {
  if (!codes.length) return new Set();
  const res = await ctx.tx.execute<{ code: string }>(sql`
    select distinct r.code from requirement r join framework_version v on v.id = r.framework_version_id
    where v.framework_id = ${frameworkId} and r.code = any(${texts(codes)}) and not (r.id = any(${uuids(excludeIds)}))`);
  const live = new Set(res.rows.map((r) => r.code));
  return new Set(codes.filter((c) => !live.has(c)));
}

/** The mappings that name any of these codes (as the internal item for the institution's own framework, else as the external one). */
async function mappingsFor(ctx: Ctx, info: VersionInfo, codes: Set<string>): Promise<Row[]> {
  if (!codes.size) return [];
  const list = [...codes];
  return readWhere(ctx, 'requirement_mapping', info.internal
    ? sql`t.internal_framework_id = ${info.frameworkId} and t.internal_code = any(${texts(list)})`
    : sql`t.framework_id = ${info.frameworkId} and t.external_code = any(${texts(list)})`);
}

/** Recursive subtree (root first, parents before children) of each root. */
async function subtrees(ctx: Ctx, rootIds: string[]): Promise<Map<string, string[]>> {
  const res = await ctx.tx.execute<{ root_id: string; id: string }>(sql`
    with recursive sub as (
      select id as root_id, id, 0 as depth from requirement where id = any(${uuids(rootIds)})
      union all
      select sub.root_id, r.id, sub.depth + 1 from requirement r join sub on r.parent_id = sub.id)
    select root_id, id from sub order by root_id, depth`);
  const out = new Map<string, string[]>();
  for (const r of res.rows) out.set(r.root_id, [...(out.get(r.root_id) ?? []), r.id]);
  return out;
}

// ---- Requirements -------------------------------------------------------------------------------------------------

interface RootPlan {
  rootId: string; versionId: string; info: VersionInfo; root: Row; ids: string[]; rows: Row[]; notes: Row[];
  ancestors: { id: string; code: string; title: string }[]; refs: TrashRef[]; mappings: Row[];
}
interface RequirementPlan { roots: RootPlan[]; subItems: number; notes: number; mappings: number }

/** What deleting these requirements would remove. Nothing is written. Ids inside another selected id's subtree count once. */
async function planRequirements(ctx: Ctx, rawIds: string[], o: { keepMappings?: boolean } = {}): Promise<RequirementPlan> {
  const ids = [...new Set(rawIds)];
  if (!ids.length) throw new ValidationError('choose what to delete');
  const picked = await readRows(ctx, 'requirement', ids);
  const found = new Set(idsOf(picked));
  const missing = ids.find((i) => !found.has(i));
  if (missing) throw new NotFoundError(`requirement ${missing}`);
  const infos = new Map<string, VersionInfo>();
  for (const v of new Set(picked.map((r) => String(r.framework_version_id)))) {
    await getDraftVersion(ctx, v);
    infos.set(v, await versionInfo(ctx, v));
  }
  const trees = await subtrees(ctx, ids);
  const covered = new Set<string>();
  for (const [root, tree] of trees) for (const id of tree) if (id !== root && ids.includes(id)) covered.add(id);
  const rootIds = ids.filter((i) => !covered.has(i));

  const everyId = rootIds.flatMap((r) => trees.get(r) ?? []);
  const allRows = await readRows(ctx, 'requirement', everyId);
  const rowById = new Map(allRows.map((r) => [String(r.id), r]));
  const allNotes = await readWhere(ctx, 'requirement_note', sql`t.requirement_id = any(${uuids(everyId)})`);
  const proposals = everyId.length
    ? (await ctx.tx.execute<{ id: string; accepted_requirement_id: string }>(sql`select id, accepted_requirement_id from iqf_item_proposal where accepted_requirement_id = any(${uuids(everyId)})`)).rows
    : [];

  const roots: RootPlan[] = [];
  for (const rootId of rootIds) {
    const tree = trees.get(rootId) ?? [rootId];
    const rows = tree.map((i) => rowById.get(i)!).filter(Boolean);
    const root = rowById.get(rootId)!;
    const versionId = String(root.framework_version_id);
    const info = infos.get(versionId)!;
    // The ancestors (nearest first), kept so a restore can offer "put it under the nearest one that is still there".
    const anc = await ctx.tx.execute<{ id: string; code: string; title: string }>(sql`
      with recursive up as (select id, parent_id, code, title, 1 as n from requirement where id = ${root.parent_id ?? null}
        union all select r.id, r.parent_id, r.code, r.title, up.n + 1 from requirement r join up on r.id = up.parent_id)
      select id, code, title from up order by n`);
    const treeSet = new Set(tree);
    const noteRows = allNotes.filter((n) => treeSet.has(String(n.requirement_id)));
    roots.push({
      rootId, versionId, info, root, ids: tree, rows, notes: noteRows, ancestors: anc.rows,
      refs: proposals.filter((p) => treeSet.has(p.accepted_requirement_id)).map((p) => ({ table: 'iqf_item_proposal', id: p.id, column: 'accepted_requirement_id', value: p.accepted_requirement_id })),
      mappings: [],
    });
  }
  // Mappings go with the last requirement that bears their code in the framework.
  const deleting = roots.flatMap((r) => r.ids);
  if (!o.keepMappings) for (const [vid, info] of infos) {
    const mine = roots.filter((r) => r.versionId === vid);
    const codes = [...new Set(mine.flatMap((r) => r.rows.map((x) => String(x.code))))];
    const orphans = await orphanCodes(ctx, info.frameworkId, codes, deleting);
    for (const r of mine) {
      const own = new Set(r.rows.map((x) => String(x.code)).filter((c) => orphans.has(c)));
      r.mappings = await mappingsFor(ctx, info, own);
    }
  }
  return {
    roots,
    subItems: roots.reduce((n, r) => n + r.rows.length - 1, 0),
    notes: roots.reduce((n, r) => n + r.notes.length, 0),
    mappings: roots.reduce((n, r) => n + r.mappings.length, 0),
  };
}

const requirementName = (r: Row) => text(r.code) || text(r.title);

function wordsFor(plan: RequirementPlan) {
  const inside = insideWords({ subItems: plan.subItems, notes: plan.notes, mappings: plan.mappings });
  const codes = plan.roots.map((r) => requirementName(r.root)).join(', ');
  const name = plan.roots.length === 1 ? requirementName(plan.roots[0]!.root) : codes.length <= 40 ? codes : plural(plan.roots.length, 'item');
  return { inside, name };
}

/** The question for the confirm dialog, with what else goes (same words on every screen). */
export async function previewDelete(ctx: Ctx, input: { ids: string[] }): Promise<DeletePreview> {
  await require_(ctx, 'framework:write');
  const plan = await planRequirements(ctx, input.ids);
  const { inside, name } = wordsFor(plan);
  const them = inside.length || plan.roots.length > 1 ? 'them' : 'it';
  const lead = plan.roots.length === 1 ? 'its' : 'their';
  return {
    roots: plan.roots.length,
    counts: { items: plan.roots.length, subItems: plan.subItems, notes: plan.notes, mappings: plan.mappings },
    message: `Delete ${name}${inside.length ? ` and ${lead} ${joinWords(inside)}` : ''}? You can restore ${them} from the Trash for ${TRASH_RETENTION_DAYS} days.`,
    label: `Deleted ${name}${plan.subItems ? ` and ${plural(plan.subItems, 'sub-item')}` : ''}`,
  };
}

async function executeRequirements(ctx: Ctx, plan: RequirementPlan, opts: { groupId?: string; merged?: boolean; label?: string; undoLabel?: string; itemLabel?: string; rootExtra?: Record<string, unknown>; extraMeta?: (r: RootPlan) => Record<string, unknown> | undefined } = {}): Promise<DeleteResult> {
  const items: NewTrashItem[] = plan.roots.map((r) => {
    const tables: Tables = { requirement: r.rows, requirement_note: r.notes, requirement_mapping: r.mappings };
    const payload: TrashPayload = {
      ...emptyPayload({ versionId: r.versionId, rootIds: [r.rootId], parentId: r.root.parent_id ?? null, ancestors: r.ancestors, place: placeOf(r.info), codes: r.rows.map((x) => x.code), ...opts.rootExtra }),
      tables, refs: r.refs,
    };
    const meta = opts.extraMeta?.(r);
    if (meta) payload.meta = meta;
    const parent = r.ancestors[0];
    return {
      kind: 'requirement' as const, label: opts.itemLabel ?? `${text(r.root.code)} · ${text(r.root.title)}`, context: `${placeOf(r.info)}${parent ? ` / ${parent.code}` : ''}`, payload,
      counts: { items: 1, subItems: r.rows.length - 1, notes: r.notes.length, mappings: r.mappings.length },
    };
  });
  // Notes first: the database remembers an AI-made note's requirement by code (record_ai_dismissal).
  const notes = plan.roots.flatMap((r) => idsOf(r.notes));
  await deleteRows(ctx, 'requirement_note', notes);
  await deleteRows(ctx, 'requirement_mapping', plan.roots.flatMap((r) => idsOf(r.mappings)));
  await deleteRows(ctx, 'requirement', plan.roots.flatMap((r) => r.ids));
  const groupId = await writeTrash(ctx, items, opts.groupId);
  const { name } = wordsFor(plan);
  const label = opts.label ?? `Deleted ${name}${plan.subItems ? ` and ${plural(plan.subItems, 'sub-item')}` : ''}`;
  reportUndo(ctx, restoreUndo(groupId, opts.undoLabel ?? label, opts.merged ? { revertMerge: true } : {}));
  return { groupId, label, counts: { items: plan.roots.length, subItems: plan.subItems, notes: plan.notes, mappings: plan.mappings }, items: items.length };
}

/**
 * Deletes requirements with everything under them (children, notes, links to other standards) in one action: one
 * transaction, one Trash group. An id that sits inside another selected id's subtree is not counted twice. Draft and
 * in-review versions only; a published or retired version stays as it is.
 */
export async function deleteMany(ctx: Ctx, input: { ids: string[] }): Promise<DeleteResult> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  return executeRequirements(ctx, await planRequirements(ctx, input.ids));
}

/** One requirement with its whole subtree (what the delete button does). */
export const deleteRequirement = (ctx: Ctx, id: string) => deleteMany(ctx, { ids: [id] });

/** Deletes every requirement of a draft version ("Delete all standards in this version") as one Trash item. */
export async function deleteAllRequirements(ctx: Ctx, versionId: string): Promise<DeleteResult> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  await getDraftVersion(ctx, versionId);
  const top = await ctx.tx.select({ id: requirement.id }).from(requirement).where(and(eq(requirement.frameworkVersionId, versionId), sql`${requirement.parentId} is null`));
  if (!top.length) throw new ConflictError('there is nothing to delete in this version');
  const plan = await planRequirements(ctx, top.map((t) => t.id));
  const info = plan.roots[0]!.info;
  // One Trash item holding every top-level standard, so the Trash shows "All 8 standards of ..." and restores them together.
  const rows = plan.roots.flatMap((r) => r.rows);
  const merged: RequirementPlan = {
    ...plan,
    roots: [{
      rootId: plan.roots[0]!.rootId, versionId, info, root: plan.roots[0]!.root, ids: plan.roots.flatMap((r) => r.ids), rows,
      notes: plan.roots.flatMap((r) => r.notes), ancestors: [], refs: plan.roots.flatMap((r) => r.refs), mappings: plan.roots.flatMap((r) => r.mappings),
    }],
  };
  const total = plan.roots.length + plan.subItems;
  const label = `Deleted all ${plural(total, 'standard')} in ${placeOf(info)}`;
  const rootIds = plan.roots.map((r) => r.rootId);
  const result = await executeRequirements(ctx, merged, { label, undoLabel: label, itemLabel: `All ${plural(total, 'standard')} (${placeOf(info)})`, rootExtra: { rootIds, all: true } });
  return { ...result, counts: { ...result.counts, items: plan.roots.length } };
}

/** The pieces a merge leaves in the Trash: the merged-away requirement, plus what is needed to move its children and notes back. */
export async function trashMergedRequirement(ctx: Ctx, id: string, meta: Record<string, unknown>, intoCode: string): Promise<DeleteResult> {
  // A merge keeps the links to other standards where they are (they are keyed by code and stay as they were).
  const plan = await planRequirements(ctx, [id], { keepMappings: true });
  return executeRequirements(ctx, plan, {
    merged: true, extraMeta: () => ({ merge: meta }),
    label: `Merged ${requirementName(plan.roots[0]!.root)} into ${intoCode}`,
  });
}

// ---- Notes, templates, pages, mappings ------------------------------------------------------------------------------

async function trashSingle(ctx: Ctx, kind: TrashKind, table: 'requirement_note' | 'report_template' | 'source_page' | 'requirement_mapping' | 'milestone' | 'evidence_link', row: Row, o: {
  label: string; context: string | null; root: Record<string, unknown>; verb?: string; undoLabel: string; counts?: Record<string, number>;
}): Promise<DeleteResult> {
  const payload: TrashPayload = { ...emptyPayload(o.root), tables: { [table]: [row] } };
  const refs: TrashRef[] = [];
  if (table === 'evidence_link') {
    const rows = (await ctx.tx.execute<{ id: string }>(sql`select id from evidence_request where evidence_link_id = ${String(row.id)}`)).rows;
    for (const r of rows) refs.push({ table: 'evidence_request', id: r.id, column: 'evidence_link_id', value: String(row.id) });
  }
  payload.refs = refs;
  await deleteRows(ctx, table, [String(row.id)]);
  const groupId = await writeTrash(ctx, [{ kind, label: o.label, context: o.context, payload, counts: o.counts ?? { items: 1 } }]);
  reportUndo(ctx, restoreUndo(groupId, o.undoLabel));
  return { groupId, label: o.undoLabel, counts: o.counts ?? { items: 1 }, items: 1 };
}

export async function trashNote(ctx: Ctx, note: Row, req: Row, info: VersionInfo): Promise<DeleteResult> {
  const t = short(text(note.text).replace(/\s+/g, ' '), 50);
  return trashSingle(ctx, 'note', 'requirement_note', note, {
    label: t, context: `${placeOf(info)} / ${text(req.code)}`, root: { versionId: info.id, requirementId: req.id, requirement: `${text(req.code)} · ${text(req.title)}` },
    undoLabel: `Deleted a note on ${text(req.code)}`,
  });
}

export async function trashTemplate(ctx: Ctx, row: Row, info: VersionInfo): Promise<DeleteResult> {
  return trashSingle(ctx, 'report_template', 'report_template', row, {
    label: text(row.name), context: placeOf(info), root: { versionId: info.id, key: row.key }, undoLabel: `Deleted the template ${text(row.name)}`,
  });
}

export async function trashPage(ctx: Ctx, row: Row, doc: Row, info: VersionInfo): Promise<DeleteResult> {
  return trashSingle(ctx, 'source_page', 'source_page', row, {
    label: `Page ${row.page_no} of ${text(doc.title)}`, context: placeOf(info), root: { versionId: info.id, documentId: doc.id, pageNo: row.page_no },
    undoLabel: `Removed page ${row.page_no} of ${text(doc.title)}`,
  });
}

export async function trashMapping(ctx: Ctx, row: Row, labels: { place: string; text: string }): Promise<DeleteResult> {
  return trashSingle(ctx, 'mapping', 'requirement_mapping', row, {
    label: labels.text, context: labels.place, root: { frameworkId: row.framework_id, internalFrameworkId: row.internal_framework_id, externalCode: row.external_code, internalCode: row.internal_code },
    undoLabel: `Removed the link ${labels.text}`,
  });
}

export async function trashEvidenceLink(ctx: Ctx, row: Row, labels: { text: string; place: string }): Promise<DeleteResult> {
  return trashSingle(ctx, 'evidence_link', 'evidence_link', row, {
    label: labels.text, context: labels.place, root: { engagementRequirementId: row.engagement_requirement_id ?? null, internalFrameworkId: row.internal_framework_id ?? null, internalCode: row.internal_code ?? null, evidenceVersionId: row.evidence_version_id },
    undoLabel: `Removed the evidence link ${labels.text}`,
  });
}

export async function trashMilestone(ctx: Ctx, row: Row, place: string): Promise<DeleteResult> {
  return trashSingle(ctx, 'milestone', 'milestone', row, {
    label: text(row.name), context: place, root: { engagementId: row.engagement_id }, undoLabel: `Deleted the milestone ${text(row.name)}`,
  });
}

// ---- Source documents ---------------------------------------------------------------------------------------------

/** A source document with its pages (and the analysis's proposals that cite it); the original file stays in storage until the purge. */
export async function trashSourceDocument(ctx: Ctx, doc: Row, info: VersionInfo): Promise<DeleteResult> {
  const id = String(doc.id);
  const pages = await readWhere(ctx, 'source_page', sql`t.source_document_id = ${id}`);
  const proposals = await readWhere(ctx, 'extraction_item', sql`t.source_document_id = ${id}`);
  const payload: TrashPayload = {
    ...emptyPayload({ versionId: info.id, documentId: id }), tables: { source_document: [doc], source_page: pages, extraction_item: proposals },
    files: doc.file_name && typeof doc.file_path === 'string' ? [doc.file_path] : [],
  };
  await deleteRows(ctx, 'extraction_item', idsOf(proposals));
  await deleteRows(ctx, 'source_page', idsOf(pages));
  await deleteRows(ctx, 'source_document', [id]);
  const label = `Deleted ${text(doc.title)}${pages.length ? ` and its ${plural(pages.length, 'page')}` : ''}`;
  const groupId = await writeTrash(ctx, [{
    kind: 'source_document', label: text(doc.title), context: placeOf(info), payload,
    counts: { items: 1, pages: pages.length, proposals: proposals.length, files: payload.files.length },
  }]);
  reportUndo(ctx, restoreUndo(groupId, label));
  return { groupId, label, counts: { items: 1, pages: pages.length }, items: 1 };
}

// ---- Versions and whole standards ---------------------------------------------------------------------------------------

/** Everything that belongs to one version, as rows. */
async function versionRows(ctx: Ctx, versionId: string): Promise<{ tables: Tables; files: string[] }> {
  const where = sql`t.framework_version_id = ${versionId}`;
  const [versionRow] = await readRows(ctx, 'framework_version', [versionId]);
  const reqs = await readWhere(ctx, 'requirement', where);
  const docs = await readWhere(ctx, 'source_document', where);
  const tables: Tables = {
    framework_version: [versionRow!],
    source_document: docs,
    source_page: docs.length ? await readWhere(ctx, 'source_page', sql`t.source_document_id = any(${uuids(idsOf(docs))})`) : [],
    analysis_run: await readWhere(ctx, 'analysis_run', where),
    requirement: reqs,
    requirement_note: reqs.length ? await readWhere(ctx, 'requirement_note', sql`t.requirement_id = any(${uuids(idsOf(reqs))})`) : [],
    report_template: await readWhere(ctx, 'report_template', where),
    extraction_item: await readWhere(ctx, 'extraction_item', where),
    iqf_item_proposal: await readWhere(ctx, 'iqf_item_proposal', where),
    analysis_dismissal: await readWhere(ctx, 'analysis_dismissal', where),
  };
  const files = docs.filter((d) => d.file_name && typeof d.file_path === 'string').map((d) => String(d.file_path));
  return { tables, files };
}

async function assertVersionDeletable(ctx: Ctx, versionId: string, info: VersionInfo) {
  await getDraftVersion(ctx, versionId);
  const [used] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(engagement)
    .where(sql`${engagement.frameworkVersionId} = ${versionId} or ${engagement.templateSyncedVersionId} = ${versionId}`);
  if (used?.n) throw new ConflictError(`${placeOf(info)} is used by ${plural(used.n, 'engagement')} and cannot be deleted`);
  const next = await ctx.tx.select({ edition: frameworkVersion.edition }).from(frameworkVersion).where(eq(frameworkVersion.supersedesId, versionId));
  if (next.length) throw new ConflictError(`${plural(next.length, 'version')} (${next.map((n) => n.edition).join(', ')}) was made from this one; delete that first`);
}

/**
 * Removes a version's rows in dependency order. The version's own row goes last (and only when asked): a standard that is
 * deleted whole removes all its version rows in one statement, because a version can point at the one it replaced.
 */
async function removeVersionRows(ctx: Ctx, versionId: string, tables: Tables, keepVersionRow: boolean) {
  const { framework_version: versionRows_, ...rest } = tables;
  await deleteTables(ctx, rest);
  // Includes the ones the deletions above just recorded (record_ai_dismissal): the version is going, they go with it.
  await ctx.tx.execute(sql`select trash_drop_dismissals(${versionId}::uuid)`);
  if (!keepVersionRow) await deleteRows(ctx, 'framework_version', idsOf(versionRows_));
}

async function dropVersion(ctx: Ctx, versionId: string, info: VersionInfo, o: { withMappings: boolean; keepVersionRow: boolean }) {
  const { tables, files } = await versionRows(ctx, versionId);
  if (o.withMappings) {
    const reqIds = idsOf(tables.requirement);
    const codes = [...new Set((tables.requirement ?? []).map((r) => text(r.code)))];
    tables.requirement_mapping = await mappingsFor(ctx, info, await orphanCodes(ctx, info.frameworkId, codes, reqIds));
  }
  const refs: TrashRef[] = [];
  const reqIds = idsOf(tables.requirement);
  if (reqIds.length) {
    const p = await ctx.tx.execute<{ id: string; accepted_requirement_id: string }>(sql`select id, accepted_requirement_id from iqf_item_proposal where accepted_requirement_id = any(${uuids(reqIds)}) and framework_version_id <> ${versionId}`);
    for (const x of p.rows) refs.push({ table: 'iqf_item_proposal', id: x.id, column: 'accepted_requirement_id', value: x.accepted_requirement_id });
  }
  const toDelete: Tables = { ...tables };
  if (!o.withMappings) delete toDelete.requirement_mapping;
  await removeVersionRows(ctx, versionId, toDelete, o.keepVersionRow);
  return { tables, files, refs };
}

/** Deletes a draft or in-review version with all it holds. Published and retired versions can never be deleted. */
export async function deleteVersion(ctx: Ctx, versionId: string): Promise<DeleteResult> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const info = await versionInfo(ctx, versionId);
  await assertVersionDeletable(ctx, versionId, info);
  const { tables, files, refs } = await dropVersion(ctx, versionId, info, { withMappings: true, keepVersionRow: false });
  const counts = { items: 1, requirements: tables.requirement?.length ?? 0, notes: tables.requirement_note?.length ?? 0, documents: tables.source_document?.length ?? 0, pages: tables.source_page?.length ?? 0 };
  const label = `Deleted ${placeOf(info)}${info.internal ? ` ${info.edition}` : ''}`;
  const payload: TrashPayload = { ...emptyPayload({ versionId, frameworkId: info.frameworkId, edition: info.edition, wasStatus: info.status }), tables, files, refs };
  const groupId = await writeTrash(ctx, [{
    kind: 'framework_version', label: `${info.frameworkName} ${info.edition}`, context: info.internal ? 'Internal quality framework' : info.accreditorShort, payload, counts,
  }]);
  const undo = `${label} and ${joinWords(insideWords({ subItems: Math.max(0, counts.requirements), notes: counts.notes }))}`.replace(/ and $/, '');
  reportUndo(ctx, restoreUndo(groupId, counts.requirements || counts.notes ? undo : label));
  return { groupId, label, counts, items: 1 };
}

/** Deletes a whole external standard (every version must still be a draft or in review, and no engagement may use it). */
export async function deleteFramework(ctx: Ctx, frameworkId: string): Promise<DeleteResult> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const [fw] = await ctx.tx.select().from(framework).where(eq(framework.id, frameworkId));
  if (!fw) throw new NotFoundError(`standard ${frameworkId}`);
  if (fw.internal) throw new ConflictError('the institution\'s own quality framework cannot be deleted');
  const [acc] = await ctx.tx.select({ short: accreditor.shortName }).from(accreditor).where(eq(accreditor.id, fw.accreditorId));
  const versions = await ctx.tx.select({ id: frameworkVersion.id, status: frameworkVersion.status, edition: frameworkVersion.edition }).from(frameworkVersion).where(eq(frameworkVersion.frameworkId, frameworkId));
  const frozen = versions.filter((v) => v.status === 'published' || v.status === 'retired');
  if (frozen.length) throw new ConflictError(`${fw.name} has published versions (${frozen.map((v) => v.edition).join(', ')}) and cannot be deleted; a published version is kept for the record`);
  const tables: Tables = {};
  const files: string[] = [];
  const merge = (t: Tables) => { for (const [k, rows] of Object.entries(t)) (tables as Record<string, Row[]>)[k] = [...((tables as Record<string, Row[]>)[k] ?? []), ...(rows ?? [])]; };
  // Newest-first so a version made from another goes before the one it was made from.
  const order = [...versions].reverse();
  const infos = new Map<string, VersionInfo>();
  for (const v of order) {
    const info = await versionInfo(ctx, v.id);
    infos.set(v.id, info);
    await assertVersionDeletableInside(ctx, v.id, info, new Set(versions.map((x) => x.id)));
  }
  const refs: TrashRef[] = [];
  for (const v of order) {
    const part = await dropVersion(ctx, v.id, infos.get(v.id)!, { withMappings: false, keepVersionRow: true });
    merge(part.tables); files.push(...part.files); refs.push(...part.refs);
  }
  const framework_row = await readRows(ctx, 'framework', [frameworkId]);
  const mappings = await readWhere(ctx, 'requirement_mapping', sql`t.framework_id = ${frameworkId} or t.internal_framework_id = ${frameworkId}`);
  const aliases = await readWhere(ctx, 'glossary_alias', sql`t.framework_id = ${frameworkId}`);
  const proposals = await readWhere(ctx, 'iqf_item_proposal', sql`t.framework_id = ${frameworkId} or t.internal_framework_id = ${frameworkId}`);
  const known = new Set(idsOf(tables.iqf_item_proposal));
  const extraProposals = proposals.filter((p) => !known.has(String(p.id)));
  await deleteRows(ctx, 'glossary_alias', idsOf(aliases));
  await deleteRows(ctx, 'requirement_mapping', idsOf(mappings));
  await deleteRows(ctx, 'iqf_item_proposal', idsOf(extraProposals));
  await deleteRows(ctx, 'framework_version', versions.map((v) => v.id));
  await deleteRows(ctx, 'framework', [frameworkId]);
  tables.framework = framework_row;
  tables.glossary_alias = aliases;
  tables.requirement_mapping = mappings;
  tables.iqf_item_proposal = [...(tables.iqf_item_proposal ?? []), ...extraProposals];
  const counts = { items: 1, versions: versions.length, requirements: tables.requirement?.length ?? 0, notes: tables.requirement_note?.length ?? 0, documents: tables.source_document?.length ?? 0 };
  const label = `Deleted ${fw.name}`;
  const payload: TrashPayload = { ...emptyPayload({ frameworkId, accreditorId: fw.accreditorId }), tables, files, refs };
  const groupId = await writeTrash(ctx, [{ kind: 'framework', label: fw.name, context: acc?.short ?? null, payload, counts }]);
  reportUndo(ctx, restoreUndo(groupId, `${label}${versions.length > 1 ? ` and its ${plural(versions.length, 'version')}` : ''}`));
  return { groupId, label, counts, items: 1 };
}

/** Like assertVersionDeletable, but another version of the same standard that goes too does not count as "made from this one". */
async function assertVersionDeletableInside(ctx: Ctx, versionId: string, info: VersionInfo, inside: Set<string>) {
  await getDraftVersion(ctx, versionId);
  const [used] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(engagement)
    .where(sql`${engagement.frameworkVersionId} = ${versionId} or ${engagement.templateSyncedVersionId} = ${versionId}`);
  if (used?.n) throw new ConflictError(`${placeOf(info)} is used by ${plural(used.n, 'engagement')} and cannot be deleted`);
  const next = await ctx.tx.select({ id: frameworkVersion.id }).from(frameworkVersion).where(and(eq(frameworkVersion.supersedesId, versionId), inArray(frameworkVersion.id, [...inside].length ? [...inside] : [versionId])));
  const outside = await ctx.tx.select({ id: frameworkVersion.id }).from(frameworkVersion).where(eq(frameworkVersion.supersedesId, versionId));
  if (outside.length > next.length) throw new ConflictError('another standard\'s version was made from this one; delete that first');
}
