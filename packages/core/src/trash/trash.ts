// Trash: what a person can see, restore and remove for good (DEC-026). Who sees what: a person sees the Trash items of the
// kinds they are allowed to delete (library kinds need framework:write, evidence links evidence:write, milestones
// engagement:manage), plus anything they deleted themselves; an admin holds every permission, so sees all.
import { and, desc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { appUser, importDocument, sourceDocument, trashItem } from '@ams/db';
import {
  plural, TRASH_RETENTION_DAYS, type Permission, type RestoreOptions, type RestoreResult, type TrashContent, type TrashGroup, type TrashItem, type TrashKind, type TrashList,
} from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ForbiddenError, NotFoundError } from '../ctx.js';
import { isPermitted } from '../permissions.js';
import { assertHuman } from '../framework/common.js';
import type { TrashPayload } from './rows.js';
import { daysLeft, reportUndo } from './store.js';
import { redeleteDescriptor } from './redo.js';
import { markRestored, mergeOutcomes, notFoundGroup, RESTORE_ORDER, restoreRow } from './restore.js';

type ItemRow = typeof trashItem.$inferSelect;

/** The permission that lets a person delete (and so see, restore and remove) each kind. */
export const KIND_PERMISSION: Record<TrashKind, Permission> = {
  requirement: 'framework:write', note: 'framework:write', source_document: 'framework:write', source_page: 'framework:write', report_template: 'framework:write',
  framework_version: 'framework:write', framework: 'framework:write', mapping: 'framework:write', evidence_link: 'evidence:write', milestone: 'engagement:manage', import_document: 'org:write',
};

async function allowedKinds(ctx: Ctx): Promise<TrashKind[]> {
  const perms = [...new Set(Object.values(KIND_PERMISSION))];
  const ok = new Map<Permission, boolean>();
  for (const p of perms) ok.set(p, await isPermitted(ctx.tx, p, { type: 'any' }));
  return (Object.keys(KIND_PERMISSION) as TrashKind[]).filter((k) => ok.get(KIND_PERMISSION[k]));
}

/** What the caller may see: the kinds they may delete, or anything they deleted themselves. */
async function visibleWhere(ctx: Ctx) {
  const kinds = await allowedKinds(ctx);
  const mine = ctx.caller.userId ? eq(trashItem.deletedBy, ctx.caller.userId) : undefined;
  const byKind = kinds.length ? inArray(trashItem.kind, kinds) : undefined;
  return or(byKind, mine) ?? sql`false`;
}

const live = and(isNull(trashItem.restoredAt), gt(trashItem.expiresAt, sql`now()`));

function toItem(r: Pick<ItemRow, 'id' | 'groupId' | 'kind' | 'label' | 'context' | 'counts' | 'deletedBy' | 'deletedAt' | 'expiresAt'> & { deletedByName: string | null }): TrashItem {
  return {
    id: r.id, groupId: r.groupId, kind: r.kind, label: r.label, context: r.context, counts: r.counts as Record<string, number>,
    deletedBy: r.deletedBy, deletedByName: r.deletedByName, deletedAt: r.deletedAt.toISOString(), expiresAt: r.expiresAt.toISOString(), daysLeft: daysLeft(r.expiresAt),
  };
}

const sum = (items: TrashItem[]) => {
  const out: Record<string, number> = {};
  for (const it of items) for (const [k, n] of Object.entries(it.counts)) out[k] = (out[k] ?? 0) + n;
  return out;
};

/** The Trash, grouped by the action that put things there, newest first. */
export async function listTrash(ctx: Ctx, opts: { kind?: TrashKind; q?: string } = {}): Promise<TrashList> {
  const q = opts.q?.trim();
  const rows = await ctx.tx.select({
    id: trashItem.id, groupId: trashItem.groupId, kind: trashItem.kind, label: trashItem.label, context: trashItem.context, counts: trashItem.counts,
    deletedBy: trashItem.deletedBy, deletedAt: trashItem.deletedAt, expiresAt: trashItem.expiresAt, deletedByName: appUser.fullName,
  }).from(trashItem).leftJoin(appUser, eq(appUser.id, trashItem.deletedBy))
    .where(and(live, await visibleWhere(ctx), opts.kind ? eq(trashItem.kind, opts.kind) : undefined,
      q ? or(ilike(trashItem.label, `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`), ilike(trashItem.context, `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`)) : undefined))
    .orderBy(desc(trashItem.deletedAt), desc(trashItem.id));
  const groups = new Map<string, TrashItem[]>();
  for (const r of rows) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), toItem(r)]);
  const out: TrashGroup[] = [...groups.entries()].map(([groupId, items]) => {
    const first = items[0]!;
    const kinds = [...new Set(items.map((i) => i.kind))];
    const label = items.length === 1 ? first.label : `${plural(items.length, 'item')}: ${items.slice(0, 3).map((i) => i.label.split(' · ')[0]).join(', ')}${items.length > 3 ? '…' : ''}`;
    return {
      groupId, deletedAt: first.deletedAt, expiresAt: first.expiresAt, daysLeft: first.daysLeft, deletedBy: first.deletedBy, deletedByName: first.deletedByName,
      label, counts: sum(items), kinds, items,
    };
  });
  return { retentionDays: TRASH_RETENTION_DAYS, groups: out, total: rows.length };
}

/** How many items are in the Trash for the caller (the badge in the Settings menu). */
export async function countTrash(ctx: Ctx): Promise<{ count: number }> {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(trashItem).where(and(live, await visibleWhere(ctx)));
  return { count: r?.n ?? 0 };
}

async function loadItems(ctx: Ctx, by: { groupId?: string; itemId?: string }): Promise<ItemRow[]> {
  if (!by.groupId && !by.itemId) throw new NotFoundError('say which group or item');
  const rows = await ctx.tx.select().from(trashItem)
    .where(and(live, await visibleWhere(ctx), by.groupId ? eq(trashItem.groupId, by.groupId) : eq(trashItem.id, by.itemId!)))
    .orderBy(trashItem.createdAt);
  if (!rows.length) notFoundGroup(by.groupId ?? by.itemId!);
  return rows;
}

const order = (k: string) => { const i = (RESTORE_ORDER as readonly string[]).indexOf(k); return i < 0 ? 99 : i; };

/**
 * Puts a group (everything one action deleted) or a single item back, with the original ids, all or nothing. Refusals
 * say why and, where there is a choice, what the choices are (see restore.ts for the rules).
 */
export async function restoreTrash(ctx: Ctx, by: { groupId?: string; itemId?: string }, opts: RestoreOptions = {}): Promise<RestoreResult> {
  assertHuman(ctx);
  const items = (await loadItems(ctx, by)).sort((a, b) => order(a.kind) - order(b.kind) || a.createdAt.getTime() - b.createdAt.getTime());
  const parts = [];
  // Read before the rows are marked restored (that empties the payload): the Redo of this restore deletes the same things again.
  const again = redeleteDescriptor(items.map((it) => ({ kind: it.kind, label: it.label, payload: it.payload as TrashPayload })), opts);
  for (const it of items) {
    parts.push(await restoreRow(ctx, it, opts));
    await markRestored(ctx, it.id);
  }
  const merged = mergeOutcomes(parts);
  const label = items.length === 1 ? items[0]!.label : plural(items.length, 'item');
  const detail = [
    ...Object.entries(merged.restored).map(([k, n]) => plural(n, k.replace(/s$/, ''), k)),
  ];
  const bits = [`Restored ${label}`];
  if (detail.length > 1 || merged.renamed.length) bits.push(`(${detail.join(', ')})`);
  for (const r of merged.renamed) bits.push(`${r.from} was taken in the meantime, so it is now ${r.to}.`);
  const droppedN = Object.values(merged.dropped).reduce((a, b) => a + b, 0);
  if (droppedN) bits.push(`${plural(droppedN, 'link')} to other standards could not be brought back because the other side is gone or already exists.`);
  if (merged.placedUnder) bits.push(`Placed under ${merged.placedUnder}.`);
  bits.push(...merged.notes.map((n) => `${n.charAt(0).toUpperCase()}${n.slice(1)}.`));
  if (again) reportUndo(ctx, again);
  return {
    groupId: items[0]!.groupId, label, restored: merged.restored, dropped: merged.dropped, renamed: merged.renamed, placedUnder: merged.placedUnder, message: bits.join(' '),
  };
}

// ---- Contents -------------------------------------------------------------------------------------------------------

type Described = { table: string; id: string; label: string; depth: number };

function describe(payload: TrashPayload): Described[] {
  const t = payload.tables;
  const out: Described[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const reqs = t.requirement ?? [];
  const byId = new Map(reqs.map((r) => [String(r.id), r]));
  const depthOf = (r: Record<string, unknown>) => { let d = 0; let p = byId.get(str(r.parent_id)); while (p && d < 50) { d += 1; p = byId.get(str(p.parent_id)); } return d; };
  for (const r of t.framework ?? []) out.push({ table: 'framework', id: str(r.id), label: str(r.name), depth: 0 });
  for (const r of t.framework_version ?? []) out.push({ table: 'framework_version', id: str(r.id), label: `Version ${str(r.edition)}`, depth: 0 });
  for (const r of t.source_document ?? []) out.push({ table: 'source_document', id: str(r.id), label: str(r.title), depth: 1 });
  for (const r of t.import_document ?? []) out.push({ table: 'import_document', id: str(r.id), label: str(r.file_name), depth: 1 });
  if ((t.import_page ?? []).length) out.push({ table: 'import_page', id: 'import_pages', label: `${t.import_page!.length} pages of text`, depth: 2 });
  const pages = t.source_page ?? [];
  if (pages.length > 12) out.push({ table: 'source_page', id: 'pages', label: `${pages.length} pages of text`, depth: 2 });
  else for (const r of pages) out.push({ table: 'source_page', id: str(r.id), label: `Page ${String(r.page_no)}`, depth: 2 });
  // Requirements as a tree, each followed by its notes.
  const notesBy = new Map<string, Record<string, unknown>[]>();
  for (const n of t.requirement_note ?? []) notesBy.set(str(n.requirement_id), [...(notesBy.get(str(n.requirement_id)) ?? []), n]);
  const kids = new Map<string, Record<string, unknown>[]>();
  for (const r of reqs) if (byId.has(str(r.parent_id))) kids.set(str(r.parent_id), [...(kids.get(str(r.parent_id)) ?? []), r]);
  const walk = (r: Record<string, unknown>) => {
    const d = depthOf(r);
    out.push({ table: 'requirement', id: str(r.id), label: `${str(r.code)} · ${str(r.title)}`, depth: d });
    for (const n of notesBy.get(str(r.id)) ?? []) out.push({ table: 'requirement_note', id: str(n.id), label: `Note: ${str(n.text).replace(/\s+/g, ' ').slice(0, 80)}`, depth: d + 1 });
    for (const c of kids.get(str(r.id)) ?? []) walk(c);
  };
  for (const r of reqs.filter((x) => !byId.has(str(x.parent_id)))) walk(r);
  if (!reqs.length) for (const [rid, notes] of notesBy) for (const n of notes) out.push({ table: 'requirement_note', id: str(n.id), label: `Note on ${rid.slice(0, 8)}: ${str(n.text).replace(/\s+/g, ' ').slice(0, 80)}`, depth: 0 });
  for (const r of t.report_template ?? []) out.push({ table: 'report_template', id: str(r.id), label: str(r.name), depth: 1 });
  for (const r of t.requirement_mapping ?? []) out.push({ table: 'requirement_mapping', id: str(r.id), label: `${str(r.external_code)} → ${str(r.internal_code)} (${str(r.relation).replace('_', ' ')})`, depth: 1 });
  for (const r of t.evidence_link ?? []) out.push({ table: 'evidence_link', id: str(r.id), label: str(r.rationale).slice(0, 80), depth: 0 });
  for (const r of t.milestone ?? []) out.push({ table: 'milestone', id: str(r.id), label: str(r.name), depth: 0 });
  return out;
}

/** What one group holds, row by row (the subtree), for opening it in the Trash. */
export async function getTrashGroup(ctx: Ctx, groupId: string): Promise<{ group: TrashGroup; contents: TrashContent[] }> {
  const rows = await loadItems(ctx, { groupId });
  const list = await listTrash(ctx);
  const group = list.groups.find((g) => g.groupId === groupId);
  if (!group) throw new NotFoundError(`trash group ${groupId}`);
  return {
    group,
    contents: rows.map((r) => ({ itemId: r.id, kind: r.kind, label: r.label, rows: describe(r.payload as TrashPayload).slice(0, 2000) })),
  };
}

// ---- Removing for good ----------------------------------------------------------------------------------------------

function assertMayRemove(item: ItemRow, allowed: TrashKind[], userId: string | null) {
  if (allowed.includes(item.kind) || (userId && item.deletedBy === userId)) return;
  throw new ForbiddenError(`Missing permission ${KIND_PERMISSION[item.kind]}`);
}

/** Objects in storage to remove with some Trash rows, minus any a live source document still names. */
async function removableFiles(ctx: Ctx, rows: Pick<ItemRow, 'payload'>[]): Promise<string[]> {
  const keys = [...new Set(rows.flatMap((r) => (r.payload as TrashPayload).files ?? []))];
  if (!keys.length) return [];
  const used = await ctx.tx.select({ k: sourceDocument.filePath }).from(sourceDocument).where(inArray(sourceDocument.filePath, keys));
  const usedImport = await ctx.tx.select({ k: importDocument.filePath }).from(importDocument).where(inArray(importDocument.filePath, keys));
  const inUse = new Set([...used, ...usedImport].map((u) => u.k));
  return keys.filter((k) => !inUse.has(k));
}

/** "Delete forever": removes Trash rows now, and their stored files once the transaction commits. */
export async function deleteForever(ctx: Ctx, by: { groupId?: string; itemId?: string }): Promise<{ removed: number }> {
  assertHuman(ctx);
  const items = await loadItems(ctx, by);
  const allowed = await allowedKinds(ctx);
  for (const it of items) assertMayRemove(it, allowed, ctx.caller.userId);
  const files = await removableFiles(ctx, items);
  await ctx.tx.delete(trashItem).where(inArray(trashItem.id, items.map((i) => i.id)));
  scheduleFileRemoval(ctx, files);
  return { removed: items.length };
}

/** Empties everything in the Trash that the caller may remove. */
export async function emptyTrash(ctx: Ctx): Promise<{ removed: number }> {
  assertHuman(ctx);
  const allowed = await allowedKinds(ctx);
  const rows = await ctx.tx.select().from(trashItem).where(and(live, await visibleWhere(ctx)));
  const mine = rows.filter((r) => allowed.includes(r.kind) || (ctx.caller.userId && r.deletedBy === ctx.caller.userId));
  if (!mine.length) return { removed: 0 };
  const files = await removableFiles(ctx, mine);
  await ctx.tx.delete(trashItem).where(inArray(trashItem.id, mine.map((i) => i.id)));
  scheduleFileRemoval(ctx, files);
  return { removed: mine.length };
}

function scheduleFileRemoval(ctx: Ctx, keys: string[]) {
  const store = ctx.store;
  if (!store || !keys.length) return;
  ctx.afterCommit(async () => { for (const k of keys) await store.delete(k).catch((e: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'trash file not removed', key: k, err: String(e) }))); });
}

// ---- The purge ------------------------------------------------------------------------------------------------------

/**
 * Removes this tenant's expired Trash rows and the stored files they name (the worker calls it daily under a system
 * identity). A row whose file could not be removed is kept for the next run. The worker's database role can delete only
 * expired trash_item rows, so this is all it can do to data.
 */
export async function purgeExpiredTrash(ctx: Ctx): Promise<{ rows: number; files: number; failed: number }> {
  const expired = await ctx.tx.select().from(trashItem).where(sql`${trashItem.expiresAt} <= now()`);
  if (!expired.length) return { rows: 0, files: 0, failed: 0 };
  let files = 0;
  let failed = 0;
  const done: string[] = [];
  for (const row of expired) {
    const keys = await removableFiles(ctx, [row]);
    let ok = true;
    for (const k of keys) {
      try {
        if (!ctx.store) throw new Error('no object store configured');
        await ctx.store.delete(k);
        files += 1;
      } catch (e) {
        ok = false;
        console.error(JSON.stringify({ level: 'error', msg: 'trash purge: file not removed', key: k, err: String(e) }));
      }
    }
    if (ok) done.push(row.id); else failed += 1;
  }
  if (done.length) await ctx.tx.delete(trashItem).where(inArray(trashItem.id, done));
  return { rows: done.length, files, failed };
}
