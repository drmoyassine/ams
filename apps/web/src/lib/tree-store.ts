// The interaction state of a requirement tree (what is ticked, which row has the keyboard, what is being dragged and where
// it would land) lives in a small store outside React state, and each row reads only its own slice. That is what keeps a
// tree of hundreds of rows smooth: ticking a row, or moving the pointer over the next row while dragging, re-renders the
// one or two rows whose slice changed, not the whole list.
import { useSyncExternalStore } from 'react';
import type { DropPosition } from '@ams/shared';
import { EMPTY_SEL, type Sel } from './tree-selection';

export interface DropTarget { rowId: string; position: DropPosition; ok: boolean; text: string }

const NONE: ReadonlySet<string> = new Set();

export class TreeStore {
  private sel: Sel = EMPTY_SEL;
  private selectMode = false;
  private currentId: string | null = null;
  private drag: ReadonlySet<string> = NONE;
  private over: DropTarget | null = null;
  private keyboardDrag = false;
  private said = '';
  private tick = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  /** Changes whenever anything does: for the few components (toolbar, bar, live region) that show several things. */
  version = () => this.tick;
  private emit() { this.tick += 1; for (const l of this.listeners) l(); }

  // ---- selection ----
  get selection(): Sel { return this.sel; }
  get selected(): ReadonlySet<string> { return this.sel.ids; }
  setSelection(next: Sel) {
    if (next === this.sel) return;
    this.sel = next;
    this.emit();
  }
  clear() { if (this.sel.ids.size === 0 && this.sel.anchor === null) return; this.sel = EMPTY_SEL; this.emit(); }
  get mode(): boolean { return this.selectMode; }
  setMode(on: boolean) { if (this.selectMode === on) return; this.selectMode = on; if (!on) this.sel = EMPTY_SEL; this.emit(); }

  // ---- keyboard position (roving tabindex) ----
  get current(): string | null { return this.currentId; }
  setCurrent(id: string | null) { if (this.currentId === id) return; this.currentId = id; this.emit(); }

  // ---- drag ----
  get dragging(): ReadonlySet<string> { return this.drag; }
  get isKeyboardDrag(): boolean { return this.keyboardDrag; }
  startDrag(ids: readonly string[], keyboard: boolean) { this.drag = new Set(ids); this.keyboardDrag = keyboard; this.over = null; this.emit(); }
  get target(): DropTarget | null { return this.over; }
  setTarget(t: DropTarget | null) {
    const o = this.over;
    if (o === t || (o && t && o.rowId === t.rowId && o.position === t.position && o.ok === t.ok && o.text === t.text)) return;
    this.over = t;
    this.emit();
  }
  endDrag() { this.drag = NONE; this.over = null; this.keyboardDrag = false; this.emit(); }

  /** What the live region says: where the dragged items would land, what happened. */
  get announcement(): string { return this.said; }
  setAnnouncement(text: string) { if (text === this.said) return; this.said = text; this.emit(); }

  /** One row's slice as a short string, so React can tell cheaply whether that row has anything new to show. */
  rowKey(id: string): string {
    const t = this.over && this.over.rowId === id ? `${this.over.position[0]}${this.over.ok ? '+' : '-'}` : '';
    return `${this.sel.ids.has(id) ? 1 : 0}${this.currentId === id ? 1 : 0}${this.drag.has(id) ? 1 : 0}${this.selectMode ? 1 : 0}${this.drag.size > 0 ? 1 : 0}${t}`;
  }
}

export interface RowState {
  selected: boolean; current: boolean; dragged: boolean; selectMode: boolean; dragging: boolean;
  /** Where the dragged items would land relative to this row, if on it. */
  indicator: { position: DropPosition; ok: boolean } | null;
}
const POSITIONS: Record<string, DropPosition> = { b: 'before', a: 'after', i: 'inside' };

export function parseRowKey(key: string): RowState {
  return {
    selected: key[0] === '1', current: key[1] === '1', dragged: key[2] === '1', selectMode: key[3] === '1', dragging: key[4] === '1',
    indicator: key.length > 5 ? { position: POSITIONS[key[5]!]!, ok: key[6] === '+' } : null,
  };
}

/** Subscribes one row to its own slice of the store. */
export function useRowState(store: TreeStore, id: string): RowState {
  const key = useSyncExternalStore(store.subscribe, () => store.rowKey(id), () => store.rowKey(id));
  return parseRowKey(key);
}

/** Re-renders on any change of the store (for the toolbar, the bulk bar and the live region only). */
export function useStoreVersion(store: TreeStore): number {
  return useSyncExternalStore(store.subscribe, store.version, store.version);
}
