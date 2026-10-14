// The interaction layer shared by every requirement tree (the institution's quality framework, an external standard's
// requirements, the version page's list): multi-select with bulk delete and "Move to…", drag and drop to re-parent and
// re-order (@dnd-kit: mouse, touch and keyboard), a roving-tabindex keyboard model, and branch collapse.
//
//   <TreeProvider api version rows shown editable …>
//     <TreeToolbar />  <BulkBar />
//     {rows.map((r) => <TreeRow id={r.id}> … <RowGutter id label /> … </TreeRow>)}
//   </TreeProvider>
//
// The rules live elsewhere: where a drop lands and what is refused is @ams/shared's `resolveDrop` / `planMoves` (the server
// runs the same code and has the last word); deleting is the server's `previewDelete` / `deleteMany`. This file is the
// behaviour on top of them, and keeps its per-row state in a TreeStore so that ticking a row or dragging over the next one
// re-renders a row or two, not the list.
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragMoveEvent, type DragStartEvent, type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react';
import { appendMoves, limitsFor, planMoves, resolveDrop, topmostIds, type DepthLimits, type DropPosition, type MoveSpec, type RowUpdate } from '@ams/shared';
import { ApiError, type FrameworkApi, type Requirement, type Version } from '../../lib/framework-api';
import type { ConfirmOptions } from '../confirm-dialog';
import { confirmAndDelete } from '../../lib/delete-requirements';
import { checkboxLabel, clickSelect, extendSelect, prune, selectAll, summarize, selectionWords, type ClickMods } from '../../lib/tree-selection';
import { applyUpdates, codeHint, describePlace, dropSlots, droppedWords, normalizePlace, pointerY, zoneAt, type Slot } from '../../lib/tree-dnd';
import { publishScreen } from '../../lib/assistant-screen';
import { TreeStore, useRowState, useStoreVersion } from '../../lib/tree-store';
import { useConfirm } from '../confirm-dialog';
import { ContentText } from '../content-text';
import { Button } from '../ui/button';
import { BulkMoveDialog } from '../../pages/version/review-dialogs';

/** Tests set this to count how often a row renders (the point of the store is that a selection or a drag move re-renders few). */
export const treeProbe: { row: ((id: string) => void) | null; card: ((id: string) => void) | null } = { row: null, card: null };

/**
 * What the tree needs to know about a row: where it sits and how to say what it is. A requirement is one (its code and
 * title); so is an org unit (its English name as `code`, its Arabic name as `title`).
 */
export interface TreeItem { id: string; parentId: string | null; displayOrder: number; code: string; title?: string | null | undefined }

/**
 * What differs between the trees that use this layer: the cache key of the rows, the depth rules, how a move and a delete are
 * sent to the server, how the cached rows look right after a drop, and the words. The requirement trees get theirs from
 * `api` and `version`; another tree (the org chart) passes its own `adapter`.
 */
export interface TreeAdapter {
  queryKey: readonly unknown[];
  limits: DepthLimits;
  moveMany: (moves: MoveSpec[]) => Promise<unknown>;
  /** Asks the person and deletes; resolves true when deleted, false when they said no. */
  deleteIds: (ids: string[], title: string, confirm: (o: ConfirmOptions) => Promise<boolean>) => Promise<boolean>;
  /** Shows the result of a drop at once; returns the function that puts the cache back if the server refuses. */
  applyOptimistic: (qc: ReturnType<typeof useQueryClient>, rows: readonly TreeItem[], updates: readonly RowUpdate[]) => () => void;
  /** A note after a single move (the quality framework's codes say where an item belongs). */
  hint?: (row: TreeItem | undefined, parent: TreeItem | undefined) => string | null;
  /** Whether "Move to…" (a requirement picker) is offered; default yes. */
  moveTo?: boolean;
  /** The words in the keyboard instructions ("requirement"). */
  noun?: string;
}

export interface RowInfo {
  row: TreeItem;
  /** Direct children, in order. */
  childIds: string[];
  /** Everything below it. */
  descendants: number;
}

export interface TreeCtx {
  store: TreeStore;
  editable: boolean;
  /** Why selecting and moving are off (a published version, no permission), for tooltips. */
  reason: string;
  noun: { one: string; many: string };
  info: (id: string) => RowInfo | undefined;
  isCollapsed: (id: string) => boolean;
  setCollapsed: (id: string, collapsed: boolean) => void;
  /** Returns true when the click was a selection click (the row must not also open). */
  rowClick: (e: ReactMouseEvent | MouseEvent, id: string) => boolean;
  toggleSelect: (id: string, mods?: ClickMods) => void;
  rowKeyDown: (e: ReactKeyboardEvent, id: string) => void;
  rowKeyUp: (e: ReactKeyboardEvent, id: string) => void;
  selectAllShown: () => void;
  clearSelection: () => void;
  deleteSelected: () => Promise<void>;
  openMove: () => void;
  /** Whether the bulk bar offers "Move to…". */
  canMoveTo: boolean;
  count: { shown: number };
}

const Ctx = createContext<TreeCtx | null>(null);
export function useTree(): TreeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTree: no <TreeProvider> above');
  return c;
}

/** The requirement trees (quality framework, external standard, version list): moves and deletes go through the framework API. */
export function requirementAdapter(api: NonNullable<TreeProviderProps['api']>, version: NonNullable<TreeProviderProps['version']>): TreeAdapter {
  const key = ['requirements', version.id] as const;
  return {
    queryKey: key,
    limits: limitsFor({ internal: version.internal, levelLabels: version.levelLabels }),
    moveMany: (moves) => api.moveMany(version.id, { moves }),
    deleteIds: (ids, title, confirm) => confirmAndDelete(api, confirm, ids, title),
    applyOptimistic: (qc, rows, updates) => {
      const before = qc.getQueryData<Requirement[]>([...key]);
      qc.setQueryData([...key], applyUpdates(rows as Requirement[], updates));
      return () => { qc.setQueryData([...key], before); };
    },
    ...(version.internal ? { hint: (row: TreeItem | undefined, parent: TreeItem | undefined) => codeHint(row?.code ?? '', parent?.code ?? null) } : {}),
  };
}

export interface TreeProviderProps {
  api?: Pick<FrameworkApi, 'moveMany' | 'previewDelete' | 'deleteMany'>;
  version?: Pick<Version, 'id' | 'levelLabels'> & { internal?: boolean | undefined };
  /** For a tree that is not a version's requirements (see TreeAdapter); given, `api` and `version` are not needed. */
  adapter?: TreeAdapter;
  /** Every row, in tree order. */
  rows: TreeItem[];
  /** The ids on screen, in order (after any filter, and with the contents of collapsed branches left out). */
  shown: string[];
  editable: boolean;
  reason: string;
  /** What a row is called in words ("Standard 2.1"). */
  label: { bivarianceHack(r: any): string }['bivarianceHack']; // eslint-disable-line @typescript-eslint/no-explicit-any
  noun?: { one: string; many: string };
  collapsed: ReadonlySet<string>;
  onCollapse: (id: string, collapsed: boolean) => void;
  /** After a move or delete: refresh whatever else shows the tree (review items). */
  onChanged?: () => unknown;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
  /** Extra Move-to… exclusions or wording are not needed; the screen only supplies the children. */
  children: ReactNode;
}

const instructions = (noun: string) => `To move a ${noun}, press space on its move handle. Use the up and down arrow keys to choose a place: before it, inside it or after it. Press space to drop, or escape to cancel.`;
/**
 * dnd-kit's own live region (a role=status element) is kept out of the accessibility tree: the tree speaks through its own
 * (TreeLiveRegion), so a screen reader hears each thing once, and there is a single status element for the toast to be.
 * The hidden instructions it also renders stay reachable through aria-describedby.
 */
function useHiddenContainer(): HTMLElement | undefined {
  const [el] = useState(() => {
    if (typeof document === 'undefined') return undefined;
    const d = document.createElement('div');
    d.setAttribute('aria-hidden', 'true');
    d.setAttribute('data-dnd-a11y', '');
    document.body.appendChild(d);
    return d;
  });
  useEffect(() => () => { el?.remove(); }, [el]);
  return el;
}
const focusEl = (id: string) => document.querySelector<HTMLElement>(`[data-tree-focus="${id}"]`);

function buildInfo(rows: readonly TreeItem[]): Map<string, RowInfo> {
  const m = new Map<string, RowInfo>();
  for (const r of rows) m.set(r.id, { row: r, childIds: [], descendants: 0 });
  for (const r of rows) if (r.parentId) m.get(r.parentId)?.childIds.push(r.id);
  // Rows come parents-first, so walking backwards sums each branch before its parent needs it.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]!;
    const me = m.get(r.id)!;
    if (r.parentId) { const p = m.get(r.parentId); if (p) p.descendants += 1 + me.descendants; }
  }
  return m;
}

export function TreeProvider(props: TreeProviderProps) {
  const { rows, shown, editable } = props;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const store = useMemo(() => new TreeStore(), []);
  // The assistant's "N selected" chip follows what is ticked here (published outside React state: ticking stays cheap).
  useEffect(() => {
    let last = '';
    const publish = () => {
      const ids = [...store.selected];
      const key = ids.join(',');
      if (key === last) return;
      last = key;
      publishScreen('tree-selection', ids.length ? { selectedIds: ids } : null);
    };
    const off = store.subscribe(publish);
    return () => { off(); publishScreen('tree-selection', null); };
  }, [store]);
  const info = useMemo(() => buildInfo(rows), [rows]);
  const { api: reqApi, version: reqVersion } = props;
  const adapter = useMemo<TreeAdapter>(() => props.adapter ?? requirementAdapter(reqApi!, reqVersion!), [props.adapter, reqApi, reqVersion]);
  const live = useRef({ ...props, info, confirm, qc, adapter });
  live.current = { ...props, info, confirm, qc, adapter };
  const hidden = useHiddenContainer();
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveError, setMoveError] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const kb = useRef<{ slots: Slot[]; index: number } | null>(null);
  const expandTimer = useRef<{ id: string; t: ReturnType<typeof setTimeout> } | null>(null);

  const limits = adapter.limits;
  const labelOf = useCallback((id: string) => { const i = live.current.info.get(id); return i ? live.current.label(i.row) : 'an item'; }, []);
  const shownChild = useCallback((id: string) => {
    const l = live.current;
    if (l.collapsed.has(id)) return undefined;
    const set = new Set(l.shown);
    return l.info.get(id)?.childIds.find((c) => set.has(c));
  }, []);

  // Keep the selection to rows that still exist and the keyboard position on a row that is shown.
  useEffect(() => {
    const exists = new Set(rows.map((r) => r.id));
    store.setSelection(prune(store.selection, exists));
  }, [rows, store]);
  useEffect(() => {
    if (store.current === null || !shown.includes(store.current)) store.setCurrent(shown[0] ?? null);
  }, [shown, store]);
  useEffect(() => () => { if (expandTimer.current) clearTimeout(expandTimer.current.t); }, []);

  const announce = useCallback((text: string) => store.setAnnouncement(text), [store]);

  // ---- selection ----
  const toggleSelect = useCallback((id: string, mods: ClickMods = {}) => {
    store.setSelection(clickSelect(store.selection, live.current.shown, id, mods));
    store.setCurrent(id);
  }, [store]);
  const rowClick = useCallback((e: ReactMouseEvent | MouseEvent, id: string) => {
    if (!live.current.editable) return false;
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    if (!mods.shift && !mods.ctrl && !store.mode) return false;
    toggleSelect(id, mods);
    return true;
  }, [store, toggleSelect]);
  const selectAllShown = useCallback(() => store.setSelection(selectAll(live.current.shown)), [store]);
  const clearSelection = useCallback(() => store.clear(), [store]);

  // ---- delete ----
  const deleteSelected = useCallback(async () => {
    const l = live.current;
    if (!l.editable || store.selected.size === 0) return;
    const ids = [...store.selected];
    const { roots } = summarize(l.rows, store.selected);
    const noun = l.noun ?? { one: 'standard', many: 'standards' };
    const title = roots.length === 1 ? `Delete ${labelOf(roots[0]!)}?` : `Delete ${roots.length} ${noun.many}?`;
    try {
      const done = await l.adapter.deleteIds(ids, title, l.confirm);
      if (!done) return;
      store.clear();
      await l.qc.invalidateQueries({ queryKey: [...l.adapter.queryKey] });
      await l.onChanged?.();
    } catch (e) {
      l.onError(e instanceof ApiError ? e.message : 'Could not delete. Nothing was changed.');
    }
  }, [store, labelOf]);

  // ---- moving (drag and drop, Move to…) ----
  /** Applies the moves; resolves null when done, or the reason it was refused (nothing is changed then). */
  const commit = useCallback(async (moves: MoveSpec[]): Promise<string | null> => {
    const l = live.current;
    const plan = planMoves(l.rows, moves, labelOf, limits);
    if (!plan.ok) { l.onError(plan.message); announce(plan.message); return plan.message; }
    if (plan.unchanged) { l.onNotice('Nothing changed: it is already there.'); return null; }
    const key = [...l.adapter.queryKey];
    l.onError('');
    // Show the result at once; put it back if the server refuses.
    const rollback = l.adapter.applyOptimistic(l.qc, l.rows, plan.updates);
    try {
      await l.adapter.moveMany(moves);
    } catch (e) {
      rollback();
      const text = e instanceof ApiError ? e.message : 'Could not move that. Nothing was changed.';
      l.onError(text);
      announce(text);
      return text;
    }
    await l.qc.invalidateQueries({ queryKey: key });
    await l.onChanged?.();
    const first = moves[0]!;
    const parent = first.parentId ? labelOf(first.parentId) : null;
    const same = moves.every((m) => (l.info.get(m.id)?.row.parentId ?? null) === (m.parentId ?? null));
    const what = moves.length === 1 ? labelOf(first.id) : `${moves.length} items`;
    const hint = moves.length === 1 ? (l.adapter.hint?.(l.info.get(first.id)?.row, first.parentId ? l.info.get(first.parentId)?.row : undefined) ?? null) : null;
    const text = `${droppedWords(what, parent, same)}${hint ? ` ${hint}` : ''}`;
    l.onNotice(text);
    announce(text);
    return null;
  }, [labelOf, limits, announce]);

  const moveSelectedTo = useCallback(async (parentId: string | null) => {
    const l = live.current;
    const moves = appendMoves(l.rows, [...store.selected], parentId);
    if (moves.length === 0) return;
    const refusal = await commit(moves);
    if (refusal === null) setMoveOpen(false); else setMoveError(refusal);
  }, [store, commit]);

  // ---- drag and drop ----
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: ((event, { currentCoordinates, context }) => {
        const k = kb.current;
        if (!k || k.slots.length === 0) return undefined;
        const last = k.slots.length - 1;
        const next = event.code === 'ArrowDown' ? k.index + 1 : event.code === 'ArrowUp' ? k.index - 1 : event.code === 'Home' ? 0 : event.code === 'End' ? last : null;
        if (next === null) return undefined;
        event.preventDefault();
        k.index = Math.max(0, Math.min(last, next));
        const slot = k.slots[k.index]!;
        const l = live.current;
        const d = describePlace(l.rows, [...store.dragging], slot, labelOf, limits);
        store.setTarget({ rowId: slot.rowId, position: slot.position, ok: d.ok, text: d.text });
        announce(`${d.text} (${k.index + 1} of ${k.slots.length})`);
        const rect = context.droppableRects.get(slot.rowId);
        if (!rect) return currentCoordinates;
        const f = slot.position === 'before' ? 0.1 : slot.position === 'after' ? 0.9 : 0.5;
        return { x: currentCoordinates.x, y: rect.top + rect.height * f };
      }) as KeyboardCoordinateGetter,
    }),
  );

  const collisions: CollisionDetection = useCallback(({ droppableContainers, droppableRects, pointerCoordinates }) => {
    if (store.isKeyboardDrag) {
      const t = store.target;
      const c = t && droppableContainers.find((x) => x.id === t.rowId);
      return c ? [{ id: c.id, data: { droppableContainer: c, value: 0 } }] : [];
    }
    if (!pointerCoordinates) return [];
    const { x, y } = pointerCoordinates;
    let best: (typeof droppableContainers)[number] | null = null;
    let bestD = Infinity;
    for (const c of droppableContainers) {
      if (c.disabled) continue;
      const r = droppableRects.get(c.id);
      if (!r) continue;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const d = dy * 10000 + dx;
      if (d < bestD) { best = c; bestD = d; if (d === 0) break; }
    }
    return best ? [{ id: best.id, data: { droppableContainer: best, value: bestD } }] : [];
  }, [store]);

  const startExpand = useCallback((id: string | null) => {
    const cur = expandTimer.current;
    if (cur && cur.id === id) return;
    if (cur) clearTimeout(cur.t);
    expandTimer.current = null;
    if (!id) return;
    expandTimer.current = { id, t: setTimeout(() => { live.current.onCollapse(id, false); expandTimer.current = null; }, 600) };
  }, []);

  const onDragStart = useCallback((event: DragStartEvent) => {
    const l = live.current;
    const id = String(event.active.id);
    const ids = topmostIds(l.rows, store.selected.has(id) ? [...store.selected] : [id]);
    const keyboard = typeof KeyboardEvent !== 'undefined' && event.activatorEvent instanceof KeyboardEvent;
    store.startDrag(ids, keyboard);
    setActiveId(id);
    if (keyboard) {
      const { slots, start } = dropSlots(l.rows, l.shown, ids, limits, shownChild);
      kb.current = { slots, index: start };
      const what = ids.length === 1 ? labelOf(ids[0]!) : `${ids.length} items`;
      announce(`Picked up ${what}. ${slots.length ? `${slots.length} places to choose from. Use the up and down arrow keys, space to drop, escape to cancel.` : 'There is nowhere else to put it.'}`);
      const s = slots[start];
      if (s) store.setTarget({ rowId: s.rowId, position: s.position, ok: true, text: `${what}: leave where it is.` });
    } else {
      kb.current = null;
      announce(`Picked up ${ids.length === 1 ? labelOf(ids[0]!) : `${ids.length} items`}.`);
    }
  }, [store, limits, shownChild, labelOf, announce]);

  const onDragMove = useCallback((event: DragMoveEvent) => {
    if (store.isKeyboardDrag) return;
    const over = event.over;
    if (!over) { store.setTarget(null); startExpand(null); return; }
    const y0 = pointerY(event.activatorEvent);
    const y = (y0 ?? over.rect.top + over.rect.height / 2) + event.delta.y;
    const raw = { rowId: String(over.id), position: zoneAt(over.rect, y) as DropPosition };
    const place = normalizePlace(raw, shownChild);
    const l = live.current;
    const d = describePlace(l.rows, [...store.dragging], place, labelOf, limits);
    store.setTarget({ rowId: place.rowId, position: place.position, ok: d.ok, text: d.text });
    const i = l.info.get(place.rowId);
    startExpand(place.position === 'inside' && i && i.childIds.length > 0 && l.collapsed.has(place.rowId) ? place.rowId : null);
  }, [store, shownChild, labelOf, limits, startExpand]);

  const finish = useCallback(() => { startExpand(null); store.endDrag(); setActiveId(null); kb.current = null; }, [store, startExpand]);

  const onDragEnd = useCallback(() => {
    const t = store.target;
    const ids = [...store.dragging];
    finish();
    const l = live.current;
    if (!t) { announce('Not moved: it was not dropped on a place.'); return; }
    if (!t.ok) { l.onError(t.text.replace(/^Cannot drop here\. /, '')); announce(t.text); return; }
    const d = resolveDrop(l.rows, ids, { id: t.rowId, position: t.position }, limits, labelOf);
    if (!d.ok) { l.onError(d.message); announce(d.message); return; }
    if (d.noop) { announce('Nothing changed: it was dropped where it already is.'); return; }
    void commit(d.moves);
  }, [store, finish, limits, labelOf, commit, announce]);

  const onDragCancel = useCallback(() => {
    const ids = [...store.dragging];
    finish();
    announce(`Move cancelled. ${ids.length === 1 ? labelOf(ids[0]!) : `${ids.length} items`} stayed where ${ids.length === 1 ? 'it' : 'they'} ${ids.length === 1 ? 'was' : 'were'}.`);
  }, [store, finish, labelOf, announce]);

  // ---- keyboard on a row (roving tabindex) ----
  const goTo = useCallback((id: string, mods: { shift: boolean }, from: string) => {
    const l = live.current;
    if (mods.shift && l.editable) store.setSelection(extendSelect(store.selection, l.shown, from, id));
    store.setCurrent(id);
    focusEl(id)?.focus();
  }, [store]);

  const rowKeyDown = useCallback((e: ReactKeyboardEvent, id: string) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute('data-tree-focus') !== id) return; // keys inside the row (its menu, handle, checkbox) are theirs
    const l = live.current;
    const order = l.shown;
    const at = order.indexOf(id);
    const mods = { shift: e.shiftKey };
    switch (e.key) {
      case 'ArrowDown': if (at >= 0 && at < order.length - 1) { e.preventDefault(); goTo(order[at + 1]!, mods, id); } break;
      case 'ArrowUp': if (at > 0) { e.preventDefault(); goTo(order[at - 1]!, mods, id); } break;
      case 'Home': if (order.length) { e.preventDefault(); goTo(order[0]!, mods, id); } break;
      case 'End': if (order.length) { e.preventDefault(); goTo(order[order.length - 1]!, mods, id); } break;
      case 'ArrowRight': {
        const i = l.info.get(id);
        if (i && i.childIds.length > 0 && l.collapsed.has(id)) { e.preventDefault(); l.onCollapse(id, false); }
        break;
      }
      case 'ArrowLeft': {
        const i = l.info.get(id);
        if (i && i.childIds.length > 0 && !l.collapsed.has(id)) { e.preventDefault(); l.onCollapse(id, true); break; }
        const parent = i?.row.parentId;
        if (parent && order.includes(parent)) { e.preventDefault(); goTo(parent, { shift: false }, id); }
        break;
      }
      case ' ':
        if (l.editable) { e.preventDefault(); toggleSelect(id); }
        break;
      case 'Delete': case 'Backspace':
        if (l.editable && store.selected.size > 0) { e.preventDefault(); void deleteSelected(); }
        break;
      case 'Escape':
        if (store.selected.size > 0 || store.mode) { e.preventDefault(); store.setMode(false); store.clear(); }
        break;
      case 'a': case 'A':
        if (l.editable && (e.ctrlKey || e.metaKey)) { e.preventDefault(); selectAllShown(); }
        break;
      default:
    }
  }, [store, goTo, toggleSelect, deleteSelected, selectAllShown]);
  // A button is "clicked" when space is released: the space that ticks a row must not also open it.
  const rowKeyUp = useCallback((e: ReactKeyboardEvent, id: string) => {
    if (e.key === ' ' && live.current.editable && (e.target as HTMLElement).getAttribute('data-tree-focus') === id) e.preventDefault();
  }, []);

  const ctx = useMemo<TreeCtx>(() => ({
    store, editable, reason: props.reason, noun: props.noun ?? { one: 'standard', many: 'standards' },
    info: (id) => live.current.info.get(id),
    isCollapsed: (id) => live.current.collapsed.has(id),
    setCollapsed: (id, c) => live.current.onCollapse(id, c),
    rowClick, toggleSelect, rowKeyDown, rowKeyUp, selectAllShown, clearSelection, deleteSelected,
    openMove: () => { setMoveError(''); setMoveOpen(true); },
    canMoveTo: adapter.moveTo !== false,
    count: { shown: shown.length },
  }), [store, editable, adapter.moveTo, props.reason, props.noun?.many, shown.length, rowClick, toggleSelect, rowKeyDown, rowKeyUp, selectAllShown, clearSelection, deleteSelected]);

  const active = activeId ? info.get(activeId) : undefined;
  const selectedRows = [...store.selected].map((id) => info.get(id)?.row).filter((r): r is Requirement => !!r) as unknown as Requirement[];
  return (
    <Ctx.Provider value={ctx}>
      <DndContext sensors={sensors} collisionDetection={collisions} autoScroll={{ threshold: { x: 0.1, y: 0.18 }, acceleration: 14 }}
        accessibility={{ ...(hidden ? { container: hidden } : {}), screenReaderInstructions: { draggable: instructions(adapter.noun ?? 'requirement') }, announcements: { onDragStart: () => undefined, onDragOver: () => undefined, onDragMove: () => undefined, onDragEnd: () => undefined, onDragCancel: () => undefined } }}
        onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
        {props.children}
        <DragOverlay dropAnimation={null}>{active ? <DragPreview row={active.row} label={labelOf(active.row.id)} more={Math.max(0, store.dragging.size - 1)} /> : null}</DragOverlay>
      </DndContext>
      <TreeLiveRegion store={store} />
      {moveOpen && adapter.moveTo !== false && (
        <BulkMoveDialog items={selectedRows} rows={rows as unknown as Requirement[]} error={moveError} onClose={() => setMoveOpen(false)} onMove={moveSelectedTo} />
      )}
    </Ctx.Provider>
  );
}

function DragPreview({ row, label, more }: { row: TreeItem; label: string; more: number }) {
  return (
    <div className="pointer-events-none flex max-w-sm items-center gap-2 rounded-lg border border-primary bg-background px-3 py-2 text-sm shadow-xl" data-testid="drag-overlay">
      <span className="min-w-0 truncate" dir="auto"><span className="font-medium"><ContentText>{label}</ContentText></span>{row.title && row.title !== row.code ? <span className="text-muted-foreground"> · <ContentText>{row.title}</ContentText></span> : null}</span>
      {more > 0 && <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">+{more} more</span>}
    </div>
  );
}

/** Says, in words, where the dragged items would land and what happened (for screen readers; also useful on screen as a hint). */
function TreeLiveRegion({ store }: { store: TreeStore }) {
  useStoreVersion(store);
  return <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="tree-live">{store.announcement}</div>;
}

// ---- Row parts -----------------------------------------------------------------------------------------------------------

/** Wraps one row's header: the drop target, the selection and keyboard handlers, and the lines that show where a drop lands. */
export function TreeRow({ id, children, className = '' }: { id: string; children: ReactNode; className?: string }) {
  const t = useTree();
  const st = useRowState(t.store, id);
  const { setNodeRef } = useDroppable({ id, disabled: !t.editable });
  treeProbe.row?.(id);
  const ind = st.indicator;
  const tone = ind ? (ind.ok ? 'bg-primary' : 'bg-red-600') : '';
  return (
    <div ref={setNodeRef} data-tree-row={id} data-selected={st.selected ? 'true' : undefined} data-dragged={st.dragged ? 'true' : undefined}
      className={`group/row relative rounded-lg ${st.selected ? 'outline-2 outline-primary/70 outline bg-primary/5' : ''} ${st.dragged ? 'opacity-40' : ''} ${ind?.position === 'inside' ? `ring-2 ${ind.ok ? 'ring-primary bg-primary/10' : 'ring-red-600 bg-red-50'}` : ''} ${className}`}
      onClickCapture={(e) => {
        if (!(e.target as HTMLElement).closest('[data-tree-focus]')) return;
        if (t.rowClick(e, id)) { e.preventDefault(); e.stopPropagation(); }
      }}
      onKeyDown={(e) => t.rowKeyDown(e, id)} onKeyUp={(e) => t.rowKeyUp(e, id)}
      onFocusCapture={(e) => { if ((e.target as HTMLElement).hasAttribute('data-tree-focus')) t.store.setCurrent(id); }}>
      {children}
      {ind?.position === 'before' && <span aria-hidden="true" data-testid="drop-before" className={`pointer-events-none absolute inset-x-0 -top-1.5 z-20 h-1 rounded ${tone}`} />}
      {ind?.position === 'after' && <span aria-hidden="true" data-testid="drop-after" className={`pointer-events-none absolute inset-x-0 -bottom-1.5 z-20 h-1 rounded ${tone}`} />}
      {ind?.position === 'inside' && <span aria-hidden="true" data-testid="drop-inside" className="sr-only" />}
    </div>
  );
}

/** Props for the row's main button (the one that opens it): the keyboard stop of the tree (roving tabindex). */
export function useRowFocus(id: string): { tabIndex: number; 'data-tree-focus': string } {
  const t = useTree();
  treeProbe.card?.(id);
  // Only this: ticking a row must not re-render the card that holds the button.
  const isCurrent = useSyncExternalStore(t.store.subscribe, () => t.store.current === id, () => t.store.current === id);
  return { tabIndex: isCurrent ? 0 : -1, 'data-tree-focus': id };
}

/** Left of a row: the checkbox, the move handle and the branch toggle. */
export function RowGutter({ id }: { id: string }) {
  const t = useTree();
  const st = useRowState(t.store, id);
  const i = t.info(id);
  const draggable = useDraggable({ id, disabled: !t.editable });
  if (!i) return null;
  const code = i.row.code;
  const collapsed = t.isCollapsed(id);
  const show = st.selected || st.selectMode;
  return (
    <div className="flex shrink-0 items-center gap-0.5 ps-1.5" data-testid="row-gutter">
      {i.childIds.length > 0 && (
        <button type="button" aria-label={`${collapsed ? 'Show' : 'Hide'} the ${i.descendants} sub-${i.descendants === 1 ? 'item' : 'items'} of ${code}`} aria-expanded={!collapsed} tabIndex={-1} title={collapsed ? 'Show sub-items' : 'Hide sub-items'}
          onClick={() => t.setCollapsed(id, !collapsed)} className="inline-flex h-7 min-w-7 items-center justify-center rounded px-1 text-xs text-muted-foreground hover:bg-muted">
          <span aria-hidden="true" className={`inline-block transition-transform ${collapsed ? '' : 'rotate-90'}`}>▸</span>
          {collapsed && <span className="ms-0.5" data-testid="collapsed-count">{i.descendants}</span>}
        </button>
      )}
      {t.editable && (
        <>
          <input type="checkbox" checked={st.selected} aria-label={checkboxLabel(code, i.descendants, st.selected)} tabIndex={st.current ? 0 : -1} data-testid="row-checkbox"
            onChange={() => undefined} onClick={(e) => { e.stopPropagation(); t.toggleSelect(id, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }); }}
            className={`h-4 w-4 shrink-0 accent-[var(--color-primary,theme(colors.blue.600))] ${show ? '' : 'opacity-0 focus:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:hidden'}`} />
          <button type="button" ref={draggable.setNodeRef} {...draggable.attributes} {...draggable.listeners} aria-label={`Move ${code}`} tabIndex={st.current ? 0 : -1} data-testid="drag-handle"
            title="Drag to move. With the keyboard: space to pick up, arrow keys to choose a place, space to drop."
            className="inline-flex h-7 w-6 cursor-grab touch-none items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100 focus:opacity-100 active:cursor-grabbing">
            <span aria-hidden="true" className="text-base leading-none select-none">⋮⋮</span>
          </button>
        </>
      )}
    </div>
  );
}

// ---- Toolbar and bulk bar -------------------------------------------------------------------------------------------------

/** "Select" toggle with select all / clear; disabled, with the reason, when the version cannot be changed. */
export function TreeToolbar() {
  const t = useTree();
  useStoreVersion(t.store);
  if (t.count.shown === 0) return null;
  if (!t.editable) {
    return <Button type="button" variant="ghost" className="px-2 py-1" disabled title={t.reason} aria-disabled="true">Select</Button>;
  }
  const mode = t.store.mode;
  return (
    <>
      <Button type="button" variant={mode ? 'outline' : 'ghost'} className="px-2 py-1" aria-pressed={mode} onClick={() => t.store.setMode(!mode)}>Select</Button>
      {(mode || t.store.selected.size > 0) && <Button type="button" variant="ghost" className="px-2 py-1" onClick={t.selectAllShown}>Select all ({t.count.shown})</Button>}
    </>
  );
}

/** Appears when something is selected: "3 selected, with 14 sub-items · Delete · Move to… · Clear". */
export function BulkBar({ rows }: { rows: readonly TreeItem[] }) {
  const t = useTree();
  useStoreVersion(t.store);
  const sel = t.store.selected;
  const summary = useMemo(() => (sel.size ? summarize(rows, sel) : null), [rows, sel]);
  if (!t.editable || !summary || sel.size === 0) return null;
  return (
    <div role="region" aria-label="Selection" data-testid="bulk-bar" className="sticky top-0 z-30 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 shadow-md">
      <span className="min-w-0 text-sm font-medium" data-testid="bulk-count">{selectionWords(summary)}</span>
      <span className="ms-auto flex flex-wrap items-center gap-2">
        <Button type="button" className="bg-red-700 px-3 py-1 text-white hover:bg-red-800" onClick={() => void t.deleteSelected()}>Delete</Button>
        {t.canMoveTo && <Button type="button" variant="outline" className="px-3 py-1" onClick={t.openMove}>Move to…</Button>}
        <Button type="button" variant="ghost" className="px-3 py-1" onClick={t.clearSelection}>Clear</Button>
      </span>
      {summary.subItems > 0 && <span className="basis-full text-xs text-muted-foreground">Deleting or moving a {t.noun.one} takes its sub-items with it.</span>}
    </div>
  );
}

