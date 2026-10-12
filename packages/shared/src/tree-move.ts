// Moving requirements around a tree: the pure rules, shared by the server (which decides) and the screens (which only
// use it for feedback and for the optimistic update). Nothing here touches a database.
//
// The model: every parent (or the top level, `null`) has an ordered list of children. A move names an item, the parent
// it should end up under and a position in that parent's list. The positions are counted in the list with EVERY moved
// item taken out first; the items are then put in, in the order given. That makes one drop of several items (which keep
// their relative order) simple to write: base position, base + 1, base + 2 ...
//
// Codes are never touched here: moving an item changes where it sits, not what it is called (an accreditor's numbering
// is official; the institution's own is the person's).
import { z } from 'zod';

/** How many levels deep a tree may go: the same cap the structure of a standard is given (up to eight level names). */
export const MAX_TREE_DEPTH = 8;

export interface TreeRow {
  id: string;
  parentId: string | null;
  displayOrder: number;
  /** Only used to put equal display orders in a stable order, as the list the screens show does. */
  code?: string;
}

export const MoveSpecSchema = z.object({ id: z.uuid(), parentId: z.uuid().nullable(), index: z.number().int().min(0) });
export type MoveSpec = z.infer<typeof MoveSpecSchema>;

/**
 * A run of items to put back after a given sibling (or first, when `afterId` is null) under a parent, in order. This is
 * how a move is undone: it names what sat before them, which never moved, so it stays true however the list changed.
 */
export const PlacementRunSchema = z.object({ parentId: z.uuid().nullable(), afterId: z.uuid().nullable(), ids: z.array(z.uuid()).min(1) });
export type PlacementRun = z.infer<typeof PlacementRunSchema>;

export const MoveManyInputSchema = z.object({
  moves: z.array(MoveSpecSchema).min(1).max(2000).optional(),
  placements: z.array(PlacementRunSchema).min(1).max(2000).optional(),
}).strict();
export type MoveManyInput = z.infer<typeof MoveManyInputSchema>;

/** How deep a tree may go: `maxLevels` levels (the internal framework: as many as it names; an external standard: the general cap). */
export interface DepthLimits { maxLevels: number; levelNames?: readonly string[] }
export const DEFAULT_LIMITS: DepthLimits = { maxLevels: MAX_TREE_DEPTH };

/** The limit for a version: the internal framework allows the levels it names, an external standard the general cap. */
export function limitsFor(version: { internal?: boolean | undefined; levelLabels?: unknown }): DepthLimits {
  const names = Array.isArray(version.levelLabels) ? (version.levelLabels as unknown[]).filter((l): l is string => typeof l === 'string' && l.length > 0) : [];
  if (version.internal && names.length > 0) return { maxLevels: Math.min(names.length, MAX_TREE_DEPTH), levelNames: names };
  return DEFAULT_LIMITS;
}

export interface RowUpdate { id: string; parentId: string | null; displayOrder: number }

export type Plan =
  | { ok: true; updates: RowUpdate[]; undo: PlacementRun[]; movedIds: string[]; unchanged: boolean }
  | { ok: false; message: string; code: 'cycle' | 'depth' | 'unknown' | 'invalid' };

type Lists = Map<string | null, string[]>;

/** Children lists in the order the screens show: display order, then code, then id. */
export function childLists(rows: readonly TreeRow[]): Lists {
  const sorted = [...rows].sort((a, b) => a.displayOrder - b.displayOrder || (a.code ?? '').localeCompare(b.code ?? '') || a.id.localeCompare(b.id));
  const lists: Lists = new Map();
  for (const r of sorted) {
    const k = r.parentId ?? null;
    const l = lists.get(k);
    if (l) l.push(r.id); else lists.set(k, [r.id]);
  }
  return lists;
}

/** Ids in tree order (parents before children, siblings in order). */
export function treeOrder(rows: readonly TreeRow[]): string[] {
  const lists = childLists(rows);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (p: string | null) => { for (const id of lists.get(p) ?? []) { if (seen.has(id)) continue; seen.add(id); out.push(id); walk(id); } };
  walk(null);
  return out;
}

/** Every id below `id` (not `id` itself). */
export function descendantIds(rows: readonly TreeRow[], id: string): string[] {
  const lists = childLists(rows);
  const out: string[] = [];
  const stack = [...(lists.get(id) ?? [])];
  while (stack.length) { const x = stack.pop()!; out.push(x); stack.push(...(lists.get(x) ?? [])); }
  return out;
}

/** Drops the ids that sit under another id of the list (they travel with it), keeping tree order. */
export function topmostIds(rows: readonly TreeRow[], ids: readonly string[]): string[] {
  const want = new Set(ids);
  const parent = new Map(rows.map((r) => [r.id, r.parentId ?? null] as const));
  const hasSelectedAncestor = (id: string) => {
    for (let p = parent.get(id) ?? null, n = 0; p && n <= rows.length; p = parent.get(p) ?? null, n += 1) if (want.has(p)) return true;
    return false;
  };
  const kept = new Set(ids.filter((id) => parent.has(id) && !hasSelectedAncestor(id)));
  return treeOrder(rows).filter((id) => kept.has(id));
}

const fail = (code: 'cycle' | 'depth' | 'unknown' | 'invalid', message: string): Plan => ({ ok: false, code, message });

/** Checks the finished tree (no loops, not too deep below any moved item) and turns the lists into the rows that change. */
function finish(rows: readonly TreeRow[], lists: Lists, touched: Set<string | null>, moved: Set<string>, undo: PlacementRun[], label: (id: string) => string, limits: DepthLimits): Plan {
  const parentOf = new Map<string, string | null>();
  for (const [p, ids] of lists) for (const id of ids) parentOf.set(id, p);
  // Walk down from the top: anything not reached is in a loop.
  let reached = 0;
  const tooDeep: string[] = [];
  const stack: { id: string; depth: number; below: boolean }[] = (lists.get(null) ?? []).map((id) => ({ id, depth: 0, below: moved.has(id) }));
  while (stack.length) {
    const { id, depth, below } = stack.pop()!;
    reached += 1;
    if (below && depth >= limits.maxLevels) tooDeep.push(id);
    for (const c of lists.get(id) ?? []) stack.push({ id: c, depth: depth + 1, below: below || moved.has(c) });
  }
  if (reached < rows.length) return fail('cycle', 'A requirement cannot be moved under itself or one of its own sub-items.');
  if (tooDeep.length) {
    const n = limits.maxLevels;
    const named = limits.levelNames && limits.levelNames.length ? ` (${limits.levelNames.join(', ')})` : '';
    return fail('depth', `That would put ${label(tooDeep[0]!)} more than ${n} level${n === 1 ? '' : 's'} deep, which is the most ${limits.levelNames ? 'this framework has' : 'a standard can have'}${named}.`);
  }
  const before = new Map(rows.map((r) => [r.id, r] as const));
  const updates: RowUpdate[] = [];
  for (const p of touched) {
    (lists.get(p) ?? []).forEach((id, i) => {
      const r = before.get(id)!;
      if ((r.parentId ?? null) !== p || r.displayOrder !== i) updates.push({ id, parentId: p, displayOrder: i });
    });
  }
  return { ok: true, updates, undo, movedIds: [...moved], unchanged: updates.length === 0 };
}

/** The runs that put every moved item back where it was, taken from the lists before the move. */
function undoRuns(before: Lists, moved: ReadonlySet<string>): PlacementRun[] {
  const runs: PlacementRun[] = [];
  for (const [p, ids] of before) {
    let after: string | null = null;
    let run: PlacementRun | null = null;
    for (const id of ids) {
      if (moved.has(id)) {
        if (!run) { run = { parentId: p, afterId: after, ids: [] }; runs.push(run); }
        run.ids.push(id);
      } else { after = id; run = null; }
    }
  }
  return runs;
}

const copyLists = (l: Lists): Lists => new Map([...l].map(([k, v]) => [k, [...v]] as const));

function takeOut(lists: Lists, rows: readonly TreeRow[], ids: readonly string[], touched: Set<string | null>) {
  const parent = new Map(rows.map((r) => [r.id, r.parentId ?? null] as const));
  for (const id of ids) {
    const p = parent.get(id) ?? null;
    const l = lists.get(p);
    if (l) { const i = l.indexOf(id); if (i >= 0) l.splice(i, 1); }
    touched.add(p);
  }
}

/**
 * Applies a list of moves to a tree: all moved items are taken out of their lists, then put in, in order, each at its
 * position in the destination list (counted without any moved item, and clamped to the end). Refuses a move under itself
 * or its own sub-items, and one that goes too deep. Display orders of every list that changed come out 0, 1, 2 ... (no gaps).
 */
export function planMoves(rows: readonly TreeRow[], moves: readonly MoveSpec[], names: (id: string) => string = (id) => id, limits: DepthLimits = DEFAULT_LIMITS): Plan {
  if (moves.length === 0) return fail('invalid', 'Nothing to move.');
  const known = new Set(rows.map((r) => r.id));
  const seen = new Set<string>();
  for (const m of moves) {
    if (!known.has(m.id)) return fail('unknown', 'One of the items is not in this version any more.');
    if (m.parentId !== null && !known.has(m.parentId)) return fail('unknown', 'The place it was dropped on is not in this version any more.');
    if (seen.has(m.id)) return fail('invalid', 'The same item is in the list twice.');
    seen.add(m.id);
  }
  const before = childLists(rows);
  const lists = copyLists(before);
  const touched = new Set<string | null>();
  takeOut(lists, rows, moves.map((m) => m.id), touched);
  for (const m of moves) {
    const l = lists.get(m.parentId) ?? [];
    l.splice(Math.min(m.index, l.length), 0, m.id);
    lists.set(m.parentId, l);
    touched.add(m.parentId);
  }
  return finish(rows, lists, touched, seen, undoRuns(before, seen), names, limits);
}

/** Applies runs (see `PlacementRun`): the way a move is taken back. Refuses a run whose "after" item is not in that parent any more. */
export function planPlacements(rows: readonly TreeRow[], runs: readonly PlacementRun[], names: (id: string) => string = (id) => id, limits: DepthLimits = DEFAULT_LIMITS): Plan {
  const known = new Set(rows.map((r) => r.id));
  const moved = new Set<string>();
  for (const run of runs) {
    for (const id of [...run.ids, ...(run.afterId ? [run.afterId] : []), ...(run.parentId ? [run.parentId] : [])]) {
      if (!known.has(id)) return fail('unknown', 'Something it sat next to is not in this version any more.');
    }
    for (const id of run.ids) {
      if (moved.has(id)) return fail('invalid', 'The same item is in the list twice.');
      moved.add(id);
    }
  }
  const before = childLists(rows);
  const lists = copyLists(before);
  const touched = new Set<string | null>();
  takeOut(lists, rows, [...moved], touched);
  for (const run of runs) {
    const l = lists.get(run.parentId) ?? [];
    let at = 0;
    if (run.afterId) {
      const i = l.indexOf(run.afterId);
      if (i < 0) return fail('invalid', 'The item it sat after has been moved or deleted since, so it cannot be put back exactly.');
      at = i + 1;
    }
    l.splice(at, 0, ...run.ids);
    lists.set(run.parentId, l);
    touched.add(run.parentId);
  }
  return finish(rows, lists, touched, moved, undoRuns(before, moved), names, limits);
}

// ---- Where a drop lands ----------------------------------------------------------------------------------------------

export type DropPosition = 'before' | 'after' | 'inside';

export type Drop =
  | { ok: true; moves: MoveSpec[]; parentId: string | null; noop: boolean }
  | { ok: false; message: string };

/**
 * Turns "these items were dropped before / after / inside that one" into moves. Items that sit under another dragged item
 * travel with it; the rest keep their relative (tree) order. Dropping onto an item that is being dragged does nothing;
 * dropping into the dragged items' own sub-items is refused with a message. The server runs `planMoves` on the result and
 * has the last word (the depth rule); this is for the screens' feedback and the tests.
 */
export function resolveDrop(rows: readonly TreeRow[], dragIds: readonly string[], target: { id: string; position: DropPosition }, limits: DepthLimits = DEFAULT_LIMITS, names?: (id: string) => string): Drop {
  const ids = topmostIds(rows, dragIds);
  if (ids.length === 0) return { ok: false, message: 'Nothing to move.' };
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const over = byId.get(target.id);
  if (!over) return { ok: false, message: 'The place it was dropped on is not in this version any more.' };
  if (ids.includes(over.id)) return { ok: true, moves: [], parentId: over.parentId ?? null, noop: true };
  // Dropped into (or next to something inside) one of the dragged items' own subtrees.
  const inside = new Set(ids.flatMap((id) => descendantIds(rows, id)));
  if (inside.has(over.id)) return { ok: false, message: 'A requirement cannot be moved under itself or one of its own sub-items.' };
  const lists = childLists(rows);
  const taken = new Set(ids);
  const parentId = target.position === 'inside' ? over.id : (over.parentId ?? null);
  const siblings = (lists.get(parentId) ?? []).filter((id) => !taken.has(id));
  const base = target.position === 'inside' ? siblings.length : siblings.indexOf(over.id) + (target.position === 'after' ? 1 : 0);
  const moves = ids.map((id, k) => ({ id, parentId, index: base + k }));
  const plan = planMoves(rows, moves, names, limits);
  if (!plan.ok) return { ok: false, message: plan.message };
  return { ok: true, moves, parentId, noop: plan.unchanged };
}

/** Moves that put the items last under `parentId` (null: last at the top level), in tree order: what "Move to…" asks for. */
export function appendMoves(rows: readonly TreeRow[], ids: readonly string[], parentId: string | null): MoveSpec[] {
  const items = topmostIds(rows, ids);
  const taken = new Set(items);
  const base = (childLists(rows).get(parentId) ?? []).filter((id) => !taken.has(id)).length;
  return items.map((id, k) => ({ id, parentId, index: base + k }));
}

/** The depth (0 = top) an item would have under `parentId`. */
export function depthUnder(rows: readonly TreeRow[], parentId: string | null): number {
  if (parentId === null) return 0;
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  let d = 0;
  for (let p: string | null = parentId, n = 0; p && n <= rows.length; p = byId.get(p)?.parentId ?? null, n += 1) d += 1;
  return d;
}

// ---- The places a keyboard can step through ---------------------------------------------------------------------------

export interface DropSlot { rowId: string; position: DropPosition; key: string }

/**
 * The places the keyboard steps through, top to bottom: before and inside every row shown, and after every row that has no
 * sub-items showing (`shownChild` says whether it has). A place that comes to the same position as an earlier one is left
 * out, as is one the rules refuse (inside the dragged items' own sub-items, too deep): the same answers `resolveDrop` gives,
 * worked out for the whole list in one pass (a tree of hundreds of rows must not stall when an item is picked up). The place
 * where the items are now is kept, as the starting point.
 */
export function listDropSlots(
  rows: readonly TreeRow[], shown: readonly string[], dragIds: readonly string[], limits: DepthLimits, shownChild: (id: string) => string | undefined,
): { slots: DropSlot[]; start: number } {
  const ids = topmostIds(rows, dragIds);
  if (ids.length === 0) return { slots: [], start: 0 };
  const lists = childLists(rows);
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId ?? null] as const));
  const taken = new Set(ids);
  const below = new Set<string>();
  let height = 0;
  for (const root of ids) {
    const stack: { id: string; d: number }[] = [{ id: root, d: 0 }];
    while (stack.length) {
      const { id, d } = stack.pop()!;
      height = Math.max(height, d);
      for (const c of lists.get(id) ?? []) { below.add(c); stack.push({ id: c, d: d + 1 }); }
    }
  }
  const depth = new Map<string, number>();
  const walk: { id: string; d: number }[] = (lists.get(null) ?? []).map((id) => ({ id, d: 0 }));
  while (walk.length) { const { id, d } = walk.pop()!; depth.set(id, d); for (const c of lists.get(id) ?? []) walk.push({ id: c, d: d + 1 }); }
  const without = new Map<string | null, string[]>();
  const siblings = (p: string | null) => { let l = without.get(p); if (!l) { l = (lists.get(p) ?? []).filter((id) => !taken.has(id)); without.set(p, l); } return l; };
  const first = ids[0]!;
  const firstParent = parentOf.get(first) ?? null;
  const startKey = `${firstParent}|${(lists.get(firstParent) ?? []).slice(0, (lists.get(firstParent) ?? []).indexOf(first)).filter((id) => !taken.has(id)).length}`;
  const seen = new Set<string>();
  const slots: DropSlot[] = [];
  const consider = (rowId: string, position: DropPosition) => {
    if (taken.has(rowId)) {
      if (position === 'before' && !seen.has(startKey)) { seen.add(startKey); slots.push({ rowId, position, key: startKey }); }
      return;
    }
    if (below.has(rowId)) return;
    const parent = position === 'inside' ? rowId : (parentOf.get(rowId) ?? null);
    if ((parent === null ? 0 : (depth.get(parent) ?? 0) + 1) + height >= limits.maxLevels) return;
    const base = position === 'inside' ? siblings(rowId).length : siblings(parent).indexOf(rowId) + (position === 'after' ? 1 : 0);
    const key = `${parent}|${base}`;
    if (seen.has(key)) return;
    seen.add(key);
    slots.push({ rowId, position, key });
  };
  for (const id of shown) {
    consider(id, 'before');
    consider(id, 'inside');
    if (!shownChild(id)) consider(id, 'after');
  }
  return { slots, start: Math.max(0, slots.findIndex((s) => s.key === startKey)) };
}
