import { trashItem } from '@ams/db';
import { plural, TRASH_RETENTION_DAYS, type TrashKind, type UndoDescriptor } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { tableCounts, type TrashPayload } from './rows.js';

export { TRASH_RETENTION_DAYS };
const DAY_MS = 24 * 60 * 60 * 1000;

export interface NewTrashItem {
  kind: TrashKind;
  label: string;
  context: string | null;
  payload: TrashPayload;
  /** Counts for the list and the confirmation; defaults to the row counts of the payload. */
  counts?: Record<string, number>;
}

/** When something deleted now leaves the Trash for good. */
export const expiryFrom = (now: Date = new Date()) => new Date(now.getTime() + TRASH_RETENTION_DAYS * DAY_MS);

/** Writes the Trash rows of one action (they share a group id) and returns the group id. */
export async function writeTrash(ctx: Ctx, items: NewTrashItem[], groupId: string = crypto.randomUUID()): Promise<string> {
  const now = new Date();
  for (const it of items) {
    await ctx.tx.insert(trashItem).values({
      institutionId: ctx.caller.institutionId, groupId, kind: it.kind, label: it.label.slice(0, 300), context: it.context?.slice(0, 300) ?? null,
      payload: it.payload, counts: it.counts ?? tableCounts(it.payload.tables), deletedBy: ctx.caller.userId, deletedAt: now, expiresAt: expiryFrom(now),
    });
  }
  return groupId;
}

/** The descriptor that puts a whole action back. */
export const restoreUndo = (groupId: string, label: string, body: Record<string, unknown> = {}): UndoDescriptor =>
  ({ label, method: 'POST', path: `/api/trash/groups/${groupId}/restore`, body });

/** Reports how to undo, if the caller listens (the API does; jobs and most tests do not). */
export const reportUndo = (ctx: Ctx, d: UndoDescriptor) => ctx.undo?.(d);

/** "6 sub-items and 11 notes" (what is inside, for the question and the toast); empty when it is just the one thing. */
export function insideWords(c: { subItems?: number; notes?: number; mappings?: number; evidenceLinks?: number; pages?: number; versions?: number; documents?: number }): string[] {
  const out: string[] = [];
  if (c.versions) out.push(plural(c.versions, 'version'));
  if (c.subItems) out.push(plural(c.subItems, 'sub-item'));
  if (c.documents) out.push(plural(c.documents, 'source document'));
  if (c.pages) out.push(plural(c.pages, 'page'));
  if (c.notes) out.push(plural(c.notes, 'note'));
  if (c.mappings) out.push(plural(c.mappings, 'link to other standards', 'links to other standards'));
  if (c.evidenceLinks) out.push(plural(c.evidenceLinks, 'evidence link'));
  return out;
}

export const joinWords = (words: string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/** The calendar days left, rounded up (a row due in 3 hours has 1 day left). */
export const daysLeft = (expiresAt: Date, now: Date = new Date()) => Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS));
