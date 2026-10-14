// The Chart view of the org chart (TASK-072): the same units as the tree, drawn top-down (layout: `layoutOrgChart` in
// @ams/shared, pure and tested). Zoom and pan with the wheel, a pinch, a drag, the +/- buttons or the keyboard; a box opens its
// unit; a branch collapses from its box. The drawing is an SVG with inline presentation attributes only, so the same markup
// is exported as SVG or PNG (chart-export.ts). Right-to-left interfaces get the mirrored chart; every name carries its own text
// direction.
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { fitView, layoutOrgChart, panBy, zoomAt, type ChartLayout, type OrgUnit, type OrgUnitType, type View } from '@ams/shared';
import { Button } from '../../../components/ui/button';
import { boxModel, headLabel, isRtlText, type BoxModel } from './chart-model';
import { pageFontCss, serializeChartSvg } from './chart-export';

const INK = '#0f172a';
const MUTED = '#475569';
const LINE = '#94a3b8';
const BRAND = '#1f3b66';
const FONT = 'system-ui, -apple-system, "Segoe UI", "Noto Naskh Arabic", "Noto Sans Arabic", sans-serif';

export interface ChartHandle {
  /** The whole chart as a standalone SVG document, with its size. */
  exportSvg: () => Promise<{ svg: string; width: number; height: number }>;
  fit: () => void;
  /** Layout size and box count (for tests and the performance run). */
  stats: () => { width: number; height: number; boxes: number; scale: number };
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
}

const Lock = ({ x, y }: { x: number; y: number }) => (
  <g transform={`translate(${x} ${y})`} aria-hidden="true">
    <rect x="0" y="5" width="10" height="7" rx="1.5" fill={MUTED} />
    <path d="M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5" fill="none" stroke={MUTED} strokeWidth="1.5" />
  </g>
);

/** The boxes and connectors. Memoised: panning and zooming change only the transform around it, so 300 boxes are not redrawn. */
const ChartContents = memo(function ChartContents({ layout, byId, models, selectedId, onOpen, onToggle, dragged }: ContentProps) {
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
        const label = `${u.nameEn}${u.nameAr ? `, ${u.nameAr}` : ''}, ${m.type}${head ? `, head ${head}` : ''}${b.hasChildren ? (b.collapsed ? `, collapsed, ${b.hiddenCount} units hidden` : ', expanded') : ''}`;
        const open = () => { if (!dragged.current) onOpen(b.id); };
        return (
          <g key={b.id} transform={`translate(${b.x} ${b.y})`} className="org-chart-box" data-testid="chart-box" data-unit={b.id} role="button" tabIndex={0} aria-label={label}
            style={{ cursor: 'pointer', outline: 'none' }} onClick={open}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(b.id); } }}>
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
              <g transform={`translate(${b.w / 2} ${b.h})`} role="button" tabIndex={0} data-testid="chart-toggle" aria-expanded={!b.collapsed} style={{ cursor: 'pointer', outline: 'none' }}
                aria-label={`${b.collapsed ? 'Expand' : 'Collapse'} ${u.nameEn}`}
                onClick={(e) => { e.stopPropagation(); onToggle(b.id); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggle(b.id); } }}>
                <circle className="org-chart-toggle" r="12" fill="#ffffff" stroke={LINE} strokeWidth="1.5" />
                <text y="4" textAnchor="middle" fontFamily={FONT} fontSize={b.collapsed ? 10 : 14} fill={INK}>{b.collapsed ? `+${b.hiddenCount}` : '−'}</text>
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
}>(function OrgChartView({ units, types, collapsed, onToggle, onOpen, selectedId, rtl }, ref) {
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

  // Drag to pan, two fingers to pinch. A drag starts after a few pixels, so a click on a box still opens it.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; view: View; moved: boolean; pinch?: { dist: number; view: View; cx: number; cy: number } } | null>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { x: e.clientX, y: e.clientY, view: viewRef.current, moved: false };
    if (pointers.current.size === 2) {
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
    if (!g.moved) { g.moved = true; dragged.current = true; viewport.current?.setPointerCapture?.(e.pointerId); }
    commit({ ...g.view, tx: g.view.tx + dx, ty: g.view.ty + dy });
  };
  const onPointerEnd = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
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

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Chart zoom">
        <Button type="button" variant="outline" className="px-3 py-1" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>−</Button>
        <Button type="button" variant="outline" className="px-3 py-1" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</Button>
        <Button type="button" variant="outline" className="px-3 py-1" onClick={fit}>Fit</Button>
        <span className="text-xs text-muted-foreground" data-testid="chart-zoom" aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <span className="ms-auto hidden text-xs text-muted-foreground sm:inline">Scroll or pinch to zoom, drag to move; arrow keys move, + and − zoom, 0 fits.</span>
      </div>
      <p className="text-xs text-muted-foreground sm:hidden">Pinch to zoom, drag to move. Tap a box to open it.</p>
      <div ref={viewport} tabIndex={0} role="group" aria-roledescription="org chart" aria-label="Org chart. Arrow keys move the chart, plus and minus zoom, zero fits it to the screen." data-testid="chart-viewport"
        onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        className="relative h-[60vh] min-h-[320px] w-full touch-none overflow-hidden rounded-lg border border-border bg-white focus-visible:outline-2 focus-visible:outline-primary"
        style={{ cursor: 'grab' }}>
        <svg ref={svgRef} width="100%" height="100%" role="presentation" data-testid="chart-svg" fontFamily={FONT}>
          <g data-view="" transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
            <ChartContents layout={layout} byId={byId} models={models} selectedId={selectedId} onOpen={onOpen} onToggle={onToggle} dragged={dragged} />
          </g>
        </svg>
        {layout.boxes.length === 0 && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">No units yet.</p>}
      </div>
    </div>
  );
});
