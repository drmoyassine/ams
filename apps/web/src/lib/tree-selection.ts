// Selecting rows of a requirement tree: the pure rules (click, ctrl/cmd-click, shift-click ranges, select all, what a
// selection means for delete and move). The screens keep the state in a TreeStore; nothing here touches React.
import { descendantIds, topmostIds, type TreeRow } from '@ams/shared';

export interface Sel { ids: ReadonlySet<string>; anchor: string | null }
export const EMPTY_SEL: Sel = { ids: new Set(), anchor: null };

/** The ids from `a` to `b` in the order shown, both included (either way round). Empty when one is not shown. */
export function rangeIds(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

export interface ClickMods { shift?: boolean; ctrl?: boolean }

/**
 * A click on a row (or its checkbox):
 * - shift: every row between the anchor and this one is added (the anchor stays; with no anchor this row becomes it);
 * - ctrl / cmd, or a plain click on a checkbox: this row is toggled and becomes the anchor.
 */
export function clickSelect(sel: Sel, order: readonly string[], id: string, mods: ClickMods = {}): Sel {
  if (mods.shift && sel.anchor && order.includes(sel.anchor)) {
    return { ids: new Set([...sel.ids, ...rangeIds(order, sel.anchor, id)]), anchor: sel.anchor };
  }
  const next = new Set(sel.ids);
  if (next.has(id)) next.delete(id); else next.add(id);
  return { ids: next, anchor: id };
}

/** Shift+arrow: the row focus moved from `from` to `to`; the range from the anchor (or from `from`) to `to` is selected. */
export function extendSelect(sel: Sel, order: readonly string[], from: string, to: string): Sel {
  const anchor = sel.anchor && order.includes(sel.anchor) ? sel.anchor : from;
  return { ids: new Set([...sel.ids, ...rangeIds(order, anchor, from), ...rangeIds(order, anchor, to)]), anchor };
}

export const selectAll = (order: readonly string[]): Sel => ({ ids: new Set(order), anchor: order[0] ?? null });

/** Drops ids that no longer exist (after a delete or a reload). Returns the same object when nothing changed. */
export function prune(sel: Sel, exists: ReadonlySet<string>): Sel {
  let changed = false;
  const ids = new Set<string>();
  for (const id of sel.ids) { if (exists.has(id)) ids.add(id); else changed = true; }
  if (!changed && (sel.anchor === null || exists.has(sel.anchor))) return sel;
  return { ids, anchor: sel.anchor && exists.has(sel.anchor) ? sel.anchor : null };
}

export interface SelectionSummary {
  /** Rows ticked. */
  selected: number;
  /** Rows that do not sit under another ticked row: the ones a delete or a move acts on (with everything under them). */
  roots: string[];
  /** Everything under those roots: delete removes, and move carries, these too. */
  subItems: number;
}

export function summarize(rows: readonly TreeRow[], selected: ReadonlySet<string>): SelectionSummary {
  const roots = topmostIds(rows, [...selected]);
  const subItems = roots.reduce((n, id) => n + descendantIds(rows, id).length, 0);
  return { selected: selected.size, roots, subItems };
}

/** "3 selected" or "3 selected, with 14 sub-items": the count says plainly that a delete takes the sub-items too. */
export function selectionWords(s: SelectionSummary): string {
  const sub = s.subItems > 0 ? `, with ${s.subItems} ${s.subItems === 1 ? 'sub-item' : 'sub-items'}` : '';
  return `${s.selected} selected${sub}`;
}

/** The label a screen reader hears for a row's checkbox: what it is and what comes with it. */
export function checkboxLabel(code: string, subItems: number, selected: boolean): string {
  return `${selected ? 'Deselect' : 'Select'} ${code}${subItems > 0 ? `, with its ${subItems} ${subItems === 1 ? 'sub-item' : 'sub-items'}` : ''}`;
}
