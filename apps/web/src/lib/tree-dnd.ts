// Drag and drop in a requirement tree: the pure parts. Where on a row the pointer is (before / inside / after), which
// places the keyboard can step through, what each place means in plain words, and how the tree looks right after a drop
// (the optimistic update). The rules (cycles, depth, positions) are @ams/shared's `resolveDrop` / `planMoves`, the same code
// the server runs; the server has the last word.
import { childLists, listDropSlots, resolveDrop, type DepthLimits, type DropPosition, type DropSlot, type RowUpdate, type TreeRow } from '@ams/shared';

/** Which third of a row the pointer is on: the top edge puts the item before it, the bottom edge after it, the middle inside it. */
export function zoneAt(rect: { top: number; height: number }, y: number): DropPosition {
  if (rect.height <= 0) return 'inside';
  const f = (y - rect.top) / rect.height;
  return f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'inside';
}

export interface Place { rowId: string; position: DropPosition }

/**
 * The bottom edge of a row whose sub-items are showing means "first among them", not "after the whole branch": that is
 * where the line is drawn, so it is also what is dropped on.
 */
export function normalizePlace(place: Place, firstShownChild: (id: string) => string | undefined): Place {
  if (place.position !== 'after') return place;
  const child = firstShownChild(place.rowId);
  return child ? { rowId: child, position: 'before' } : place;
}

export type Slot = DropSlot;
export { listDropSlots as dropSlots };

/** What a place means, in plain words, for the live region and the drop indicator's label. */
export function describePlace(
  rows: readonly TreeRow[], dragIds: readonly string[], place: Place, label: (id: string) => string, limits: DepthLimits,
): { ok: boolean; text: string } {
  const what = dragIds.length === 1 ? label(dragIds[0]!) : `${dragIds.length} items`;
  const d = resolveDrop(rows, dragIds, { id: place.rowId, position: place.position }, limits, label);
  if (!d.ok) return { ok: false, text: `Cannot drop here. ${d.message}` };
  if (d.noop) return { ok: true, text: `${what}: leave where it is.` };
  const parent = d.parentId ? label(d.parentId) : null;
  const where = place.position === 'inside' ? `inside ${label(place.rowId)}, as the last sub-item`
    : `${place.position} ${label(place.rowId)}${parent ? `, under ${parent}` : ', at the top level'}`;
  return { ok: true, text: `Put ${what} ${where}.` };
}

/** The tree as it will look once `updates` are applied: parents' lists renumbered, rows back in tree order with their depth. */
export function applyUpdates<T extends TreeRow & { depth?: number | undefined }>(rows: readonly T[], updates: readonly RowUpdate[]): T[] {
  const by = new Map(updates.map((u) => [u.id, u] as const));
  const next = rows.map((r) => { const u = by.get(r.id); return u ? { ...r, parentId: u.parentId, displayOrder: u.displayOrder } : r; });
  const lists = childLists(next);
  const byId = new Map(next.map((r) => [r.id, r] as const));
  const out: T[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const id of lists.get(parent) ?? []) {
      const r = byId.get(id)!;
      out.push(r.depth === depth ? r : { ...r, depth });
      walk(id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Where a pointer or touch event is, in the page's coordinates before any scrolling. */
export function pointerY(event: Event | null | undefined): number | null {
  const e = event as { clientY?: number; touches?: ArrayLike<{ clientY: number }>; changedTouches?: ArrayLike<{ clientY: number }> } | null | undefined;
  if (!e) return null;
  if (typeof e.clientY === 'number') return e.clientY;
  const t = e.touches?.[0] ?? e.changedTouches?.[0];
  return t ? t.clientY : null;
}

/** Plain words for what a drop did, including that the codes were not touched. */
export function droppedWords(label: string, parent: string | null, sameParent: boolean): string {
  const where = sameParent ? 'in its new position' : parent ? `under ${parent}` : 'to the top level';
  return `Moved ${label} ${where}. Codes are not renumbered.`;
}

/** The IQF's codes say where an item belongs (2.3 is the third item of Standard 2.0): says so when a move left a code out of step. */
export function codeHint(code: string, parentCode: string | null): string | null {
  const m = /^(\d+)\.(\d+)$/.exec(code.trim());
  if (m && parentCode !== null && parentCode !== m[1]) return `Its code is still ${code}. Edit the code if you want it to match its new place (editing a code moves the item to the standard the code names).`;
  if (m && parentCode === null) return `Its code is still ${code}, which names a sub-standard. Edit the code if you want it to match.`;
  return null;
}
