// The Chart view of the org chart (TASK-072): the same units as the tree, drawn top-down (layout: `layoutOrgChart` in
// @ams/shared, pure and tested). Zoom and pan with the wheel, a pinch, a drag, the +/- buttons or the keyboard; a box opens its
// unit; a branch collapses from its box. The drawing is an SVG with inline presentation attributes only, so the same markup
// is exported as SVG or PNG (chart-export.ts). Right-to-left interfaces get the mirrored chart; every name carries its own text
// direction.
//
// People who can edit the organization also edit on the chart: drag a box onto another to move it under that unit (or, with
// the box focused, Space picks it up, the arrow keys choose the unit, Space drops); double-click or F2 renames in place; the ＋
// on a box adds a sub-unit; Delete or Backspace sends the focused box to the Trash. These use the same calls as the Tree and the
// drawer (move-many, create, update, delete with the server's question), so every change has its Undo toast. The edit chrome
// (＋ buttons, the drop highlight, the dragged box) is marked `data-export-skip` or lives outside the SVG, so exports leave it out.
import { forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fitView, layoutOrgChart, panBy, planMoves, zoomAt, type ChartLayout, type MoveSpec, type OrgUnit, type OrgUnitType, type View } from '@ams/shared';
import { useConfirm } from '../../../components/confirm-dialog';
import { Button } from '../../../components/ui/button';
import { ApiError } from '../../../lib/framework-api';
import type { SettingsApi } from '../../../lib/settings-api';
import { boxAt, boxModel, chartDrop, defaultChildType, headLabel, isRtlText, lockedReason, type BoxModel } from './chart-model';
import { pageFontCss, serializeChartSvg } from './chart-export';
import { orgTreeAdapter } from './org-tree-view';

const INK = '#0f172a';
const MUTED = '#475569';
const LINE = '#94a3b8';
const BRAND = '#1f3b66';
const OK = '#16a34a';
const NO = '#dc2626';
const FONT = 'system-ui, -apple-system, "Segoe UI", "Noto Naskh Arabic", "Noto Sans Arabic", sans-serif';
/** How long a click on a box waits before opening it, so a double-click can rename instead (editors only). */
const OPEN_DELAY_MS = 250;

export interface ChartHandle {
  /** The whole chart as a standalone SVG document, with its size. */
  exportSvg: () => Promise<{ svg: string; width: number; height: number }>;
  fit: () => void;
  /** Layout size and box count (for tests and the performance run). */
  stats: () => { width: number; height: number; boxes: number; scale: number };
}

/** What editing on the chart needs; absent for people who cannot edit the organization (the chart is read-only then). */
export interface ChartEditing {
  api: SettingsApi;
  /** Shows (or with '' clears) the reason something was refused. */
  onError: (text: string) => void;
  /** Opens a collapsed branch (a sub-unit was just added under it). */
  onExpand: (id: string) => void;
  /** Reads the chart again after a change. */
  onChanged: () => Promise<unknown>;
}

interface ContentProps {
  layout: ChartLayout;
  byId: ReadonlyMap<string, OrgUnit>;
  models: ReadonlyMap<string, BoxModel>;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  /** Whether a drag just ended (the click that follows it must not open a box). */
  dragged: { current: boolean };
  editable: boolean;
  rtl: boolean;
  onRename: (id: string) => void;
  onAdd: (id: string) => void;
  onBoxKey: (e: ReactKeyboardEvent<SVGGElement>, id: string) => void;
  onBoxBlur: (id: string) => void;
  /** The id of the words that say how to edit a box (editors). */
  helpId: string;
}

/** A drag in progress (pointer or keyboard): the unit, where it would go, and what that means. */
interface Drag {
  id: string;
  keyboard: boolean;
  targetId: string | null;
  ok: boolean;
  text: string;
  /** The pointer, in chart coordinates (pointer drags). */
  x: number;
  y: number;
  /** Keyboard drags: the boxes to choose from, in order, and which one is chosen. */
  order: string[];
  index: number;
}

type Editing = { kind: 'rename'; id: string } | { kind: 'add'; parentId: string };

const Lock = ({ x, y }: { x: number; y: number }) => (
  <g transform={`translate(${x} ${y})`} aria-hidden="true">
    <rect x="0" y="5" width="10" height="7" rx="1.5" fill={MUTED} />
    <path d="M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5" fill="none" stroke={MUTED} strokeWidth="1.5" />
  </g>
);

const activate = (fn: () => void) => (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fn(); } };

/** The boxes and connectors. Memoised: panning, zooming and dragging change only what is around it, so 300 boxes are not redrawn. */
const ChartContents = memo(function ChartContents({ layout, byId, models, selectedId, onOpen, onToggle, dragged, editable, rtl, onRename, onAdd, onBoxKey, onBoxBlur, helpId }: ContentProps) {
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (openTimer.current) clearTimeout(openTimer.current); }, []);
  return (
    <>
      <g fill="none" stroke={LINE} strokeWidth="1.5" aria-hidden="true">
        {layout.links.map((l) => <path key={`${l.from}-${l.to}`} d={l.d} />)}
      </g>
      {layout.boxes.map((b) => {
        const u = byId.get(b.id);
        const m = models.get(b.id);
        if (!u || !m) return null;
        const head = headLabel(u);
        const label = `${u.nameEn}${u.nameAr ? `, ${u.nameAr}` : ''}, ${m.type}${head ? `, head ${head}` : ''}${b.hasChildren ? (b.collapsed ? `, collapsed, ${b.hiddenCount} units hidden` : ', expanded') : ''}${u.locked ? ', locked' : ''}`;
        const open = () => {
          if (dragged.current) return;
          if (!editable) { onOpen(b.id); return; }
          // Editors: wait a moment, so the second click of a double-click renames instead of opening the drawer.
          if (openTimer.current) clearTimeout(openTimer.current);
          openTimer.current = setTimeout(() => { openTimer.current = null; onOpen(b.id); }, OPEN_DELAY_MS);
        };
        const rename = () => { if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; } onRename(b.id); };
        return (
          <g key={b.id} transform={`translate(${b.x} ${b.y})`} className="org-chart-box" data-testid="chart-box" data-unit={b.id} role="button" tabIndex={0} aria-label={label}
            aria-describedby={editable ? helpId : undefined} aria-keyshortcuts={editable ? 'Enter Space F2 Delete' : undefined}
            style={{ cursor: 'pointer', outline: 'none' }} onClick={open} onDoubleClick={editable ? rename : undefined}
            onKeyDown={(e) => onBoxKey(e, b.id)} onBlur={editable ? () => onBoxBlur(b.id) : undefined}>
            <rect className="org-chart-frame" width={b.w} height={b.h} rx="8" fill="#ffffff" stroke={selectedId === b.id ? '#2563eb' : LINE} strokeWidth={selectedId === b.id ? 3 : 1.5} />
            <path d={`M0 8a8 8 0 0 1 8-8h${b.w - 16}a8 8 0 0 1 8 8v2H0z`} fill={u.active ? BRAND : LINE} />
            <text x={b.w / 2} y={m.y.type} textAnchor="middle" fontFamily={FONT} fontSize="10" fill={MUTED} style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>{m.type}</text>
            {m.en.map((line, i) => (
              <text key={`e${i}`} x={b.w / 2} y={m.y.en + i * 16} textAnchor="middle" fontFamily={FONT} fontSize="13" fontWeight="600" fill={u.active ? INK : MUTED}
                direction={isRtlText(line) ? 'rtl' : 'ltr'} unicodeBidi="plaintext">{line}</text>
            ))}
            {m.ar.map((line, i) => (
              <text key={`a${i}`} x={b.w / 2} y={m.y.ar + i * 15} textAnchor="middle" fontFamily={FONT} fontSize="12" fill={MUTED} direction="rtl" unicodeBidi="plaintext">{line}</text>
            ))}
            {m.head && <text x={b.w / 2} y={m.y.head} textAnchor="middle" fontFamily={FONT} fontSize="11" fill={MUTED} direction={isRtlText(m.head) ? 'rtl' : 'ltr'} unicodeBidi="plaintext">{m.head}</text>}
            {u.locked && <Lock x={b.w - 16} y={12} />}
            {u.source !== 'manual' && <text x="8" y="22" fontFamily={FONT} fontSize="9" fill={MUTED} fontStyle="italic">{u.source}</text>}
            {b.hasChildren && (
              <g transform={`translate(${b.w / 2} ${b.h})`} role="button" tabIndex={0} data-testid="chart-toggle" data-chart-control="" aria-expanded={!b.collapsed} style={{ cursor: 'pointer', outline: 'none' }}
                aria-label={`${b.collapsed ? 'Expand' : 'Collapse'} ${u.nameEn}`}
                onClick={(e) => { e.stopPropagation(); onToggle(b.id); }}
                onKeyDown={activate(() => onToggle(b.id))}>
                <circle className="org-chart-toggle" r="12" fill="#ffffff" stroke={LINE} strokeWidth="1.5" />
                <text y="4" textAnchor="middle" fontFamily={FONT} fontSize={b.collapsed ? 10 : 14} fill={INK}>{b.collapsed ? `+${b.hiddenCount}` : '−'}</text>
              </g>
            )}
            {editable && (
              <g transform={`translate(${rtl ? 16 : b.w - 16} ${b.h})`} className="org-chart-add" role="button" tabIndex={0} data-testid="chart-add" data-chart-control="" data-export-skip=""
                aria-label={`Add a unit under ${u.nameEn}`} style={{ cursor: 'pointer', outline: 'none' }}
                onClick={(e) => { e.stopPropagation(); onAdd(b.id); }} onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={activate(() => onAdd(b.id))}>
                <circle r="11" fill={BRAND} stroke="#ffffff" strokeWidth="2" />
                <path d="M-5 0h10M0 -5v10" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
              </g>
            )}
          </g>
        );
      })}
    </>
  );
});

export const OrgChartView = forwardRef<ChartHandle, {
  units: OrgUnit[]; types: OrgUnitType[]; collapsed: ReadonlySet<string>; onToggle: (id: string) => void; onOpen: (id: string) => void; selectedId: string | null; rtl: boolean;
  /** Given: the chart can be edited (see ChartEditing). */
  editing?: ChartEditing | null;
}>(function OrgChartView({ units, types, collapsed, onToggle, onOpen, selectedId, rtl, editing = null }, ref) {
  const editable = editing !== null;
  const helpId = useId();
  const typeLabel = useMemo(() => new Map(types.map((t) => [t.key, t.labelEn] as const)), [types]);
  const byId = useMemo(() => new Map(units.map((u) => [u.id, u] as const)), [units]);
  const models = useMemo(() => new Map(units.map((u) => [u.id, boxModel(u, typeLabel.get(u.type) ?? u.type)] as const)), [units, typeLabel]);
  const layout = useMemo(
    () => layoutOrgChart(units.map((u) => ({ id: u.id, parentId: u.parentId, displayOrder: u.displayOrder, code: u.nameEn })), {
      collapsed, rtl, measure: (id) => { const m = models.get(id); return m ? { w: m.w, h: m.h } : { w: 208, h: 72 }; },
    }),
    [units, collapsed, rtl, models],
  );

  const viewport = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitted = useRef(false);
  const dragged = useRef(false);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const commit = useCallback((v: View) => { viewRef.current = v; setView(v); }, []);
  const fit = useCallback(() => {
    const s = sizeRef.current;
    if (s.width > 0) commit(fitView(layoutRef.current, s));
  }, [commit]);

  // The viewport's size (a resize observer where there is one; the first fit waits for a real size).
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const read = () => { const r = el.getBoundingClientRect(); setSize((p) => (p.width === Math.round(r.width) && p.height === Math.round(r.height) ? p : { width: Math.round(r.width), height: Math.round(r.height) })); };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!fitted.current && size.width > 0) { fitted.current = true; fit(); }
  }, [size, fit]);

  // The wheel zooms around the pointer (a listener of its own: React's is passive and could not stop the page from scrolling).
  useEffect(() => {
    const el = viewport.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      commit(zoomAt(viewRef.current, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [commit]);

  // ---- editing ----
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = useCallback((d: Drag | null) => { dragRef.current = d; setDragState(d); }, []);
  const [editingBox, setEditingBox] = useState<Editing | null>(null);
  const [announcement, setAnnouncement] = useState('');
  /** A box to focus once it is drawn (after a move, an add, a rename or a delete). */
  const focusAfter = useRef<string | null>(null);
  const live = useRef({ units, byId, editing, types, collapsed });
  live.current = { units, byId, editing, types, collapsed };

  const boxEl = (id: string) => svgRef.current?.querySelector<SVGGElement>(`[data-unit="${CSS.escape(id)}"]`) ?? null;
  /** Pans just enough to bring a box into the viewport (the zoom stays). */
  const reveal = useCallback((id: string) => {
    const b = layoutRef.current.boxes.find((x) => x.id === id);
    const s = sizeRef.current;
    if (!b || s.width <= 0) return;
    const v = viewRef.current;
    const pad = 24;
    const left = v.tx + b.x * v.scale;
    const top = v.ty + b.y * v.scale;
    const right = left + b.w * v.scale;
    const bottom = top + b.h * v.scale;
    const dx = left < pad ? pad - left : right > s.width - pad ? s.width - pad - right : 0;
    const dy = top < pad ? pad - top : bottom > s.height - pad ? s.height - pad - bottom : 0;
    if (dx || dy) commit(panBy(v, dx, dy));
  }, [commit]);
  useEffect(() => {
    const id = focusAfter.current;
    if (!id || !layout.boxes.some((b) => b.id === id)) return;
    focusAfter.current = null;
    reveal(id);
    boxEl(id)?.focus();
  }, [layout, reveal]);

  const fail = useCallback((text: string) => { live.current.editing?.onError(text); setAnnouncement(text); }, []);

  const moveTo = useCallback(async (id: string, targetId: string) => {
    const l = live.current;
    if (!l.editing) return;
    const d = chartDrop(l.units, id, targetId);
    if (!d.ok) { fail(d.text.replace(/^Cannot drop here\. /, '')); return; }
    if (d.noop) { setAnnouncement(d.text); return; }
    l.editing.onError('');
    const rows = l.units.map((u) => ({ id: u.id, parentId: u.parentId, displayOrder: u.displayOrder, code: u.nameEn }));
    const plan = planMoves(rows, d.moves as MoveSpec[]);
    const adapter = orgTreeAdapter(l.editing.api);
    const rollback = plan.ok ? adapter.applyOptimistic(qc, [], plan.updates) : () => undefined;
    if (l.collapsed.has(targetId)) l.editing.onExpand(targetId);
    focusAfter.current = id;
    try {
      await l.editing.api.moveOrgUnits({ moves: d.moves });
    } catch (e) {
      rollback();
      fail(e instanceof ApiError ? e.message : 'Could not move that. Nothing was changed.');
      return;
    }
    setAnnouncement(`Moved ${l.byId.get(id)?.nameEn ?? 'the unit'} under ${l.byId.get(targetId)?.nameEn ?? 'the unit'}.`);
    await l.editing.onChanged();
  }, [qc, fail]);

  const removeBox = useCallback(async (id: string) => {
    const l = live.current;
    const u = l.byId.get(id);
    if (!l.editing || !u) return;
    l.editing.onError('');
    try {
      const done = await orgTreeAdapter(l.editing.api).deleteIds([id], `Delete ${u.nameEn}?`, confirm);
      if (!done) { boxEl(id)?.focus(); return; }
    } catch (e) {
      fail(e instanceof ApiError ? e.message : 'Could not delete. Nothing was changed.');
      boxEl(id)?.focus();
      return;
    }
    setAnnouncement(`Deleted ${u.nameEn}. It is in the Trash.`);
    if (u.parentId) focusAfter.current = u.parentId; else viewport.current?.focus();
    await l.editing.onChanged();
  }, [confirm, fail]);

  const editRef = useRef<Editing | null>(null);
  const beginEdit = useCallback((ed: Editing) => { if (live.current.editing && !saving.current) { setDrag(null); editRef.current = ed; setEditingBox(ed); } }, [setDrag]);
  const startRename = useCallback((id: string) => beginEdit({ kind: 'rename', id }), [beginEdit]);
  const startAdd = useCallback((parentId: string) => beginEdit({ kind: 'add', parentId }), [beginEdit]);

  const saving = useRef(false);
  const finishEdit = useCallback(async (text: string | null) => {
    const ed = editRef.current;
    const l = live.current;
    if (!ed || !l.editing || saving.current) return;
    const name = text?.trim() ?? '';
    const backTo = ed.kind === 'rename' ? ed.id : ed.parentId;
    const unit = l.byId.get(backTo);
    if (text === null || !name || (ed.kind === 'rename' && name === unit?.nameEn)) {
      // Cancelled (or nothing to save). Cleared first: focusing the box blurs the field, and that blur must not save.
      editRef.current = null;
      setEditingBox(null);
      boxEl(backTo)?.focus();
      return;
    }
    saving.current = true;
    l.editing.onError('');
    try {
      if (ed.kind === 'rename') {
        await l.editing.api.updateOrgUnit(ed.id, { nameEn: name });
        focusAfter.current = ed.id;
        setAnnouncement(`Renamed to ${name}.`);
      } else {
        const created = await l.editing.api.createOrgUnit({ parentId: ed.parentId, type: defaultChildType(unit?.type ?? null, l.types), nameEn: name });
        if (l.collapsed.has(ed.parentId)) l.editing.onExpand(ed.parentId);
        focusAfter.current = created.id;
        setAnnouncement(`Added ${name} under ${unit?.nameEn ?? 'the unit'}.`);
      }
      editRef.current = null;
      setEditingBox(null);
      await l.editing.onChanged();
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      fail(e.issues.length ? `${e.message}: ${e.issues.map((i) => i.message).join('; ')}` : e.message);
    } finally { saving.current = false; }
  }, [fail]);

  // Keyboard on a box: Enter opens; Space picks up / drops; arrows choose while picked up; F2 renames; Delete trashes.
  const pickUp = useCallback((id: string) => {
    const l = live.current;
    const u = l.byId.get(id);
    if (!u) return;
    const why = lockedReason(u);
    if (why) { fail(why); return; }
    l.editing?.onError('');
    const order = layoutRef.current.boxes.map((b) => b.id).filter((x) => x !== id);
    if (order.length === 0) { setAnnouncement('There is no other unit to put it under.'); return; }
    const start = Math.max(0, u.parentId ? order.indexOf(u.parentId) : 0);
    const d = chartDrop(l.units, id, order[start]!);
    setDrag({ id, keyboard: true, targetId: order[start]!, ok: d.ok, text: d.text, x: 0, y: 0, order, index: start });
    reveal(order[start]!);
    setAnnouncement(`Picked up ${u.nameEn}. Use the arrow keys to choose the unit to put it under, space to drop, escape to cancel. ${d.text}`);
  }, [fail, setDrag, reveal]);
  const cancelDrag = useCallback((words = true) => {
    const d = dragRef.current;
    if (!d) return;
    setDrag(null);
    if (words) setAnnouncement(`Move cancelled. ${live.current.byId.get(d.id)?.nameEn ?? 'The unit'} stayed where it was.`);
  }, [setDrag]);
  const onBoxKey = useCallback((e: ReactKeyboardEvent<SVGGElement>, id: string) => {
    if (e.target !== e.currentTarget) return; // the box's own buttons handle their keys
    const k = e.key;
    const d = dragRef.current;
    if (!live.current.editing) {
      if (k === 'Enter' || k === ' ') { e.preventDefault(); onOpen(id); }
      return;
    }
    if (d?.keyboard) {
      e.preventDefault();
      if (k === 'Escape') cancelDrag();
      else if (k === ' ' || k === 'Enter') { setDrag(null); if (d.targetId) void moveTo(d.id, d.targetId); }
      else if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(k)) {
        const last = d.order.length - 1;
        const index = k === 'Home' ? 0 : k === 'End' ? last : Math.max(0, Math.min(last, d.index + (k === 'ArrowDown' || k === 'ArrowRight' ? 1 : -1)));
        const target = d.order[index]!;
        const r = chartDrop(live.current.units, d.id, target);
        setDrag({ ...d, index, targetId: target, ok: r.ok, text: r.text });
        reveal(target);
        setAnnouncement(`${r.text} (${index + 1} of ${d.order.length})`);
      }
      return;
    }
    if (k === 'Enter') { e.preventDefault(); onOpen(id); }
    else if (k === ' ') { e.preventDefault(); pickUp(id); }
    else if (k === 'F2') { e.preventDefault(); startRename(id); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); void removeBox(id); }
  }, [onOpen, cancelDrag, setDrag, moveTo, reveal, pickUp, startRename, removeBox]);
  const onBoxBlur = useCallback((id: string) => { if (dragRef.current?.keyboard && dragRef.current.id === id) cancelDrag(); }, [cancelDrag]);

  // ---- pointer: drag the background to pan, two fingers to pinch, drag a box (editors) to move it ----
  // A drag starts after a few pixels, so a click on a box still opens it.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; view: View; moved: boolean; boxId?: string | null; refused?: boolean; pinch?: { dist: number; view: View; cx: number; cy: number } } | null>(null);
  const toChart = (clientX: number, clientY: number) => {
    const r = viewport.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.tx) / v.scale, y: (clientY - r.top - v.ty) / v.scale };
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest?.('[data-chart-edit]')) return; // typing a name
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      const box = editable && !t.closest?.('[data-chart-control]') ? t.closest?.('[data-unit]')?.getAttribute('data-unit') ?? null : null;
      gesture.current = { x: e.clientX, y: e.clientY, view: viewRef.current, moved: false, boxId: box };
    }
    if (pointers.current.size === 2) {
      if (dragRef.current && !dragRef.current.keyboard) setDrag(null);
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const r = viewport.current!.getBoundingClientRect();
      gesture.current = { x: 0, y: 0, view: viewRef.current, moved: true, pinch: { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, view: viewRef.current, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top } };
      dragged.current = true;
    }
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      commit(zoomAt(g.pinch.view, (Math.hypot(a.x - b.x, a.y - b.y) || 1) / g.pinch.dist, g.pinch.cx, g.pinch.cy));
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 5) return;
    if (!g.moved) {
      g.moved = true; dragged.current = true; viewport.current?.setPointerCapture?.(e.pointerId);
      if (g.boxId) {
        const u = live.current.byId.get(g.boxId);
        const why = u ? lockedReason(u) : null;
        if (why) { g.refused = true; fail(why); return; }
        live.current.editing?.onError('');
        setAnnouncement(`Picked up ${u?.nameEn ?? 'the unit'}. Drop it on the unit to put it under.`);
      }
    }
    if (g.refused) return;
    if (g.boxId) {
      const p = toChart(e.clientX, e.clientY);
      const target = boxAt(layoutRef.current.boxes, p.x, p.y);
      const prev = dragRef.current;
      if (prev && prev.targetId === target) { setDrag({ ...prev, x: p.x, y: p.y }); return; }
      const r = target ? chartDrop(live.current.units, g.boxId, target) : { ok: false, text: 'Drop it on a unit to put it under that unit; anywhere else cancels.' };
      setDrag({ id: g.boxId, keyboard: false, targetId: target, ok: r.ok, text: r.text, x: p.x, y: p.y, order: [], index: 0 });
      return;
    }
    commit({ ...g.view, tx: g.view.tx + dx, ty: g.view.ty + dy });
  };
  const onPointerEnd = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      const g = gesture.current;
      gesture.current = null;
      const d = dragRef.current;
      if (g?.boxId && d && !d.keyboard) {
        setDrag(null);
        if (e.type === 'pointercancel' || !d.targetId) setAnnouncement(`Move cancelled. ${live.current.byId.get(d.id)?.nameEn ?? 'The unit'} stayed where it was.`);
        else void moveTo(d.id, d.targetId);
      }
      // The click that ends a drag arrives right after this; it must not open a box.
      if (dragged.current) setTimeout(() => { dragged.current = false; }, 0);
    } else if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()] as [{ x: number; y: number }];
      gesture.current = { x: p.x, y: p.y, view: viewRef.current, moved: true };
    }
  };

  const zoomBy = (f: number) => commit(zoomAt(viewRef.current, f, sizeRef.current.width / 2, sizeRef.current.height / 2));
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // keys inside a box are the box's
    const step = e.shiftKey ? 160 : 60;
    const k = e.key;
    if (k === 'ArrowLeft') commit(panBy(viewRef.current, step, 0));
    else if (k === 'ArrowRight') commit(panBy(viewRef.current, -step, 0));
    else if (k === 'ArrowUp') commit(panBy(viewRef.current, 0, step));
    else if (k === 'ArrowDown') commit(panBy(viewRef.current, 0, -step));
    else if (k === '+' || k === '=') zoomBy(1.25);
    else if (k === '-' || k === '_') zoomBy(0.8);
    else if (k === '0') fit();
    else return;
    e.preventDefault();
  };

  useImperativeHandle(ref, () => ({
    fit,
    stats: () => ({ width: layoutRef.current.width, height: layoutRef.current.height, boxes: layoutRef.current.boxes.length, scale: viewRef.current.scale }),
    exportSvg: async () => {
      const el = svgRef.current;
      if (!el) throw new Error('The chart is not showing.');
      const { width, height } = layoutRef.current;
      const fontCss = await pageFontCss().catch(() => '');
      return { svg: serializeChartSvg(el, { width, height }, { fontCss, title: 'Org chart' }), width, height };
    },
  }), [fit]);

  // The drag's chrome, drawn over the boxes (never exported): the dragged box dimmed and following the pointer, the drop target outlined.
  const boxOf = (id: string | null) => (id ? layout.boxes.find((b) => b.id === id) ?? null : null);
  const src = drag ? boxOf(drag.id) : null;
  const tgt = drag ? boxOf(drag.targetId) : null;
  const overlay = drag && (
    <g data-export-skip="" pointerEvents="none" aria-hidden="true" data-testid="chart-drag">
      {src && <rect x={src.x} y={src.y} width={src.w} height={src.h} rx="8" fill="#ffffff" fillOpacity="0.65" stroke={BRAND} strokeDasharray="4 3" strokeWidth="1.5" />}
      {tgt && <rect data-testid="chart-drop-target" data-ok={drag.ok ? 'true' : 'false'} data-target={tgt.id} x={tgt.x - 5} y={tgt.y - 5} width={tgt.w + 10} height={tgt.h + 10} rx="11"
        fill={drag.ok ? OK : NO} fillOpacity="0.08" stroke={drag.ok ? OK : NO} strokeWidth="3" strokeDasharray={drag.ok ? undefined : '6 4'} />}
      {src && !drag.keyboard && (
        <g transform={`translate(${drag.x - src.w / 2} ${drag.y - 18})`} opacity="0.9">
          <rect width={src.w} height="36" rx="8" fill="#ffffff" stroke={BRAND} strokeWidth="2" />
          <text x={src.w / 2} y="23" textAnchor="middle" fontFamily={FONT} fontSize="13" fontWeight="600" fill={INK} unicodeBidi="plaintext">{byId.get(drag.id)?.nameEn}</text>
        </g>
      )}
    </g>
  );

  // The name field over a box (rename) or under it (a new sub-unit), placed with the zoom and pan.
  const editBox = editingBox ? boxOf(editingBox.kind === 'rename' ? editingBox.id : editingBox.parentId) : null;
  const editUnit = editingBox ? byId.get(editingBox.kind === 'rename' ? editingBox.id : editingBox.parentId) : undefined;
  const editField = editingBox && editBox && editUnit && (() => {
    const s = view.scale;
    const room = size.width > 0 ? size.width - 8 : Infinity;
    const w = Math.min(room, Math.max(190, editBox.w * s));
    // Kept inside the viewport, even for a box at its edge.
    const cx = Math.min(Math.max(view.tx + (editBox.x + editBox.w / 2) * s, 4 + w / 2), size.width > 0 ? size.width - 4 - w / 2 : Infinity);
    const rawTop = editingBox.kind === 'rename' ? view.ty + (editBox.y + 24) * s : view.ty + (editBox.y + editBox.h) * s + 30;
    const top = size.height > 0 ? Math.min(Math.max(rawTop, 4), size.height - 72) : rawTop;
    const label = editingBox.kind === 'rename' ? `Rename ${editUnit.nameEn}` : `Name of the new unit under ${editUnit.nameEn}`;
    return (
      <div data-chart-edit="" className="absolute z-10 select-text" style={{ left: cx - w / 2, top, width: w }} data-testid={editingBox.kind === 'rename' ? 'chart-rename' : 'chart-add-field'}>
        <input key={`${editingBox.kind}-${editBox.id}`} autoFocus dir="auto" aria-label={label} placeholder={editingBox.kind === 'add' ? 'New unit name (English)' : undefined}
          defaultValue={editingBox.kind === 'rename' ? editUnit.nameEn : ''} maxLength={300}
          className="w-full rounded-md border-2 border-primary bg-background px-2 py-1 text-center text-sm font-semibold shadow-lg focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void finishEdit(e.currentTarget.value); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void finishEdit(null); }
          }}
          onBlur={(e) => { void finishEdit(e.currentTarget.value); }} />
        <p className="mt-1 rounded bg-background/90 px-1 text-center text-xs text-muted-foreground">
          {editingBox.kind === 'add' ? `${typeLabel.get(defaultChildType(editUnit.type, types)) ?? ''} · ` : ''}Enter saves, Escape cancels{editingBox.kind === 'rename' ? '. The Arabic name is in the details.' : ''}
        </p>
      </div>
    );
  })();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Chart zoom">
        <Button type="button" variant="outline" className="px-3 py-1" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>−</Button>
        <Button type="button" variant="outline" className="px-3 py-1" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</Button>
        <Button type="button" variant="outline" className="px-3 py-1" onClick={fit}>Fit</Button>
        <span className="text-xs text-muted-foreground" data-testid="chart-zoom" aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <span className="ms-auto hidden text-xs text-muted-foreground sm:inline">Scroll or pinch to zoom, drag to move; arrow keys move, + and − zoom, 0 fits.</span>
      </div>
      {editable && <p id={helpId} className="text-xs text-muted-foreground" data-testid="chart-edit-help">Drag a box onto another to move it under that unit. Double-click or F2 renames, ＋ adds a sub-unit, Delete sends the focused box to the Trash. With a box focused, Space picks it up to move it with the arrow keys.</p>}
      <p className="text-xs text-muted-foreground sm:hidden">Pinch to zoom, drag to move. Tap a box to open it.</p>
      <div ref={viewport} tabIndex={0} role="group" aria-roledescription="org chart" aria-label="Org chart. Arrow keys move the chart, plus and minus zoom, zero fits it to the screen." data-testid="chart-viewport"
        data-editable={editable ? 'true' : 'false'}
        onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        // Names in the boxes are not selectable: a selected word would start the browser's own drag (and cancel this one).
        onDragStart={(e) => e.preventDefault()}
        className="relative h-[60vh] min-h-[320px] w-full touch-none select-none overflow-hidden rounded-lg border border-border bg-white focus-visible:outline-2 focus-visible:outline-primary"
        style={{ cursor: drag && !drag.keyboard ? 'grabbing' : 'grab' }}>
        <svg ref={svgRef} width="100%" height="100%" role="presentation" data-testid="chart-svg" fontFamily={FONT}>
          <g data-view="" transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
            <ChartContents layout={layout} byId={byId} models={models} selectedId={selectedId} onOpen={onOpen} onToggle={onToggle} dragged={dragged}
              editable={editable} rtl={rtl} onRename={startRename} onAdd={startAdd} onBoxKey={onBoxKey} onBoxBlur={onBoxBlur} helpId={helpId} />
            {overlay}
          </g>
        </svg>
        {editField}
        {drag && <p data-testid="chart-drop-hint" aria-hidden="true" className={`pointer-events-none absolute inset-x-2 top-2 mx-auto w-fit max-w-full rounded-md border px-2 py-1 text-center text-xs shadow ${drag.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-red-300 bg-red-50 text-red-900'}`}>{drag.text}</p>}
        {layout.boxes.length === 0 && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">No units yet.</p>}
      </div>
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="chart-live">{announcement}</div>
    </div>
  );
});
