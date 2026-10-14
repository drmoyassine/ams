// The org chart drawn as a top-down tree (TASK-072): a pure, deterministic layout. Nothing here touches a DOM, a clock or a
// random number, so the chart, the export (SVG and PNG) and the tests all see the same coordinates.
//
// Approach: a "tidy tree" without the contour compaction of Reingold-Tilford. Every subtree gets the width it needs (its
// children's widths side by side, never less than its own box), a parent is centred over the span of its children, and
// several roots stand side by side as a forest. That is simple, stable (adding a unit moves only the units on its own
// level and above it) and cannot overlap. Rows are aligned: all boxes of one level share a top and the height of the
// tallest, so connectors are neat elbows. Right-to-left charts are the left-to-right chart mirrored, children keeping
// their order (the first child is at the right).
//
// The caller supplies the size of each box (names wrap, so a box's height depends on its text); `wrapText` is the
// word-wrapper the chart view and the SVG export both use.
import { childLists, type TreeRow } from './tree-move.js';

export interface ChartBox {
  id: string;
  parentId: string | null;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Has sub-units (whether or not they are shown). */
  hasChildren: boolean;
  collapsed: boolean;
  /** Units under it that are not drawn because it is collapsed. */
  hiddenCount: number;
}
export interface ChartLink {
  from: string;
  to: string;
  /** An SVG path: down from the parent, across, down to the child. */
  d: string;
}
export interface ChartLayout {
  boxes: ChartBox[];
  links: ChartLink[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** Units whose sub-units are not drawn. */
  collapsed?: ReadonlySet<string>;
  /** Mirror the chart for a right-to-left interface. */
  rtl?: boolean;
  /** The size of a box; default 200 x 84. */
  measure?: (id: string) => { w: number; h: number };
  /** Space between boxes of one level. */
  gapX?: number;
  /** Space between levels. */
  gapY?: number;
  /** Stack sub-units that are all leaves in one column under their unit (default on; at least `hangMin`, default 3). */
  hangLeaves?: boolean;
  hangMin?: number;
  hangIndent?: number;
  hangGapY?: number;
  /** Extra space between separate trees (several roots). */
  rootGap?: number;
  /** Space around the whole chart. */
  margin?: number;
}

export const DEFAULT_BOX = { w: 200, h: 84 } as const;

/** Units to leave collapsed when the chart opens: those at `depth` or deeper that have sub-units. Small charts open fully. */
export function defaultCollapsed(rows: readonly TreeRow[], opts: { depth?: number; threshold?: number } = {}): Set<string> {
  const depthLimit = opts.depth ?? 3;
  if (rows.length <= (opts.threshold ?? 60)) return new Set();
  const lists = childLists(rows);
  const out = new Set<string>();
  const stack: { id: string; d: number }[] = (lists.get(null) ?? []).map((id) => ({ id, d: 0 }));
  while (stack.length) {
    const { id, d } = stack.pop()!;
    const kids = lists.get(id) ?? [];
    if (kids.length && d >= depthLimit) out.add(id);
    for (const k of kids) stack.push({ id: k, d: d + 1 });
  }
  return out;
}

/** How many units are under each unit (all levels). */
export function descendantCounts(rows: readonly TreeRow[]): Map<string, number> {
  const lists = childLists(rows);
  const out = new Map<string, number>();
  const count = (id: string): number => {
    let n = 0;
    for (const c of lists.get(id) ?? []) n += 1 + count(c);
    out.set(id, n);
    return n;
  };
  for (const r of lists.get(null) ?? []) count(r);
  return out;
}

/**
 * Lays the rows out. Rows are `{ id, parentId, displayOrder }`; sibling order is display order, then id (as everywhere).
 *
 * A unit with three or more sub-units that are all leaves (nothing shown under them) "hangs" them: they are stacked in one
 * column under it, indented, instead of spread side by side. That is how org charts stay readable when a department has a
 * dozen sections: the chart grows downwards, not 3000 pixels wide.
 */
export function layoutOrgChart(rows: readonly TreeRow[], options: LayoutOptions = {}): ChartLayout {
  const gapX = options.gapX ?? 24;
  const gapY = options.gapY ?? 48;
  const rootGap = options.rootGap ?? 48;
  const margin = options.margin ?? 24;
  const hangMin = options.hangMin ?? 3;
  const indent = options.hangIndent ?? 28;
  const hangGapY = options.hangGapY ?? 28;
  const collapsed = options.collapsed ?? new Set<string>();
  const measure = options.measure ?? (() => DEFAULT_BOX);
  const lists = childLists(rows);
  const hidden = descendantCounts(rows);
  const shownKids = (id: string): string[] => (collapsed.has(id) ? [] : (lists.get(id) ?? []));
  const hangs = (id: string): boolean => {
    if (options.hangLeaves === false) return false;
    const kids = shownKids(id);
    return kids.length >= hangMin && kids.every((k) => shownKids(k).length === 0);
  };
  /** The children that are placed in the flow of levels (all of them, except those hung under their parent). */
  const flowKids = (id: string): string[] => (hangs(id) ? [] : shownKids(id));

  // Pass 1: subtree widths (iterative post-order, so a deep chart cannot overflow the stack).
  const size = new Map<string, { w: number; h: number }>();
  const depthOf = new Map<string, number>();
  const order: string[] = [];
  const stack: { id: string; d: number }[] = [...(lists.get(null) ?? [])].reverse().map((id) => ({ id, d: 0 }));
  while (stack.length) {
    const { id, d } = stack.pop()!;
    depthOf.set(id, d);
    order.push(id);
    size.set(id, measure(id));
    if (hangs(id)) for (const k of shownKids(id)) { depthOf.set(k, d + 1); size.set(k, measure(k)); }
    for (const k of [...flowKids(id)].reverse()) stack.push({ id: k, d: d + 1 });
  }
  const span = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i]!;
    const own = size.get(id)!.w;
    if (hangs(id)) {
      span.set(id, Math.max(own, indent + Math.max(...shownKids(id).map((k) => size.get(k)!.w))));
      continue;
    }
    const kids = flowKids(id);
    const kidsW = kids.reduce((n, k, j) => n + span.get(k)! + (j > 0 ? gapX : 0), 0);
    span.set(id, Math.max(own, kidsW));
  }

  // Level tops: every level is as tall as its tallest box (hung boxes are not part of a level).
  const levelH: number[] = [];
  for (const id of order) { const d = depthOf.get(id)!; levelH[d] = Math.max(levelH[d] ?? 0, size.get(id)!.h); }
  const levelTop: number[] = [];
  levelH.forEach((h, d) => { levelTop[d] = d === 0 ? margin : levelTop[d - 1]! + levelH[d - 1]! + gapY; });

  // Pass 2: x positions. A node's slot starts at `left`; its box is centred over its children (or, when they hang, sits at the
  // start of the slot with the column indented under it).
  const boxes = new Map<string, ChartBox>();
  const hung = new Set<string>();
  let bottom = 0;
  const put = (id: string, x: number, y: number) => {
    const { w, h } = size.get(id)!;
    const d = depthOf.get(id)!;
    const all = lists.get(id) ?? [];
    boxes.set(id, {
      id, parentId: null, depth: d, x: Math.round(x), y: Math.round(y), w, h,
      hasChildren: all.length > 0, collapsed: collapsed.has(id) && all.length > 0, hiddenCount: collapsed.has(id) ? (hidden.get(id) ?? 0) : 0,
    });
    bottom = Math.max(bottom, Math.round(y) + h);
  };
  const place = (id: string, left: number) => {
    const { w, h } = size.get(id)!;
    const slot = span.get(id)!;
    if (hangs(id)) {
      put(id, left, levelTop[depthOf.get(id)!]!);
      let y = levelTop[depthOf.get(id)!]! + h + hangGapY;
      for (const k of shownKids(id)) { put(k, left + indent, y); hung.add(k); y += size.get(k)!.h + hangGapY; }
      return;
    }
    const kids = flowKids(id);
    const kidsW = kids.reduce((n, k, j) => n + span.get(k)! + (j > 0 ? gapX : 0), 0);
    let cx = left + slot / 2;
    let at = left + (slot - kidsW) / 2;
    const centres: number[] = [];
    for (const k of kids) { place(k, at); const b = boxes.get(k)!; centres.push(b.x + b.w / 2); at += span.get(k)! + gapX; }
    if (centres.length) cx = (centres[0]! + centres[centres.length - 1]!) / 2;
    put(id, cx - w / 2, levelTop[depthOf.get(id)!]!);
  };
  // `place` recurses once per level of depth; a chart is at most a dozen levels deep (ORG_MAX_DEPTH).
  let left = margin;
  const roots = lists.get(null) ?? [];
  roots.forEach((r, i) => { place(r, left); left += span.get(r)! + (i < roots.length - 1 ? rootGap : 0); });
  const rawWidth = Math.max(0, left) + margin;
  const rawHeight = boxes.size ? bottom + margin : 2 * margin;

  const parentOf = new Map(rows.map((r) => [r.id, r.parentId ?? null] as const));
  const out: ChartBox[] = [];
  for (const [id, b] of boxes) {
    const x = options.rtl ? Math.round(rawWidth - b.x - b.w) : b.x;
    out.push({ ...b, parentId: parentOf.get(id) ?? null, x });
  }
  const byId = new Map(out.map((b) => [b.id, b] as const));
  const links: ChartLink[] = [];
  for (const b of out) {
    if (!b.parentId) continue;
    const p = byId.get(b.parentId);
    if (!p) continue;
    if (hung.has(b.id)) {
      // A hung child: a stem down the parent's start edge, then across to the child's near edge at its middle.
      const stem = options.rtl ? p.x + p.w - 14 : p.x + 14;
      const edge = options.rtl ? b.x + b.w : b.x;
      links.push({ from: p.id, to: b.id, d: `M${stem} ${p.y + p.h}V${b.y + Math.round(b.h / 2)}H${edge}` });
      continue;
    }
    const px = p.x + p.w / 2;
    const py = p.y + p.h;
    const cx = b.x + b.w / 2;
    const midY = Math.round(b.y - gapY / 2);
    links.push({ from: p.id, to: b.id, d: `M${px} ${py}V${midY}H${cx}V${b.y}` });
  }
  // Boxes in tree order (parents before children), as the rows came.
  const rank = new Map<string, number>();
  [...treeOrderIds(rows)].forEach((id, i) => rank.set(id, i));
  out.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  links.sort((a, b) => (rank.get(a.to) ?? 0) - (rank.get(b.to) ?? 0));
  return { boxes: out, links, width: Math.ceil(rawWidth), height: Math.ceil(rawHeight) };
}

function treeOrderIds(rows: readonly TreeRow[]): string[] {
  const lists = childLists(rows);
  const out: string[] = [];
  const walk = (p: string | null) => { for (const id of lists.get(p) ?? []) { out.push(id); walk(id); } };
  walk(null);
  return out;
}

// ---- Text wrapping (the boxes and the exported SVG) -----------------------------------------------------------------------

/**
 * Wraps text into lines of at most `maxChars` characters, breaking at spaces (a longer word is cut), and ends the last
 * line with an ellipsis when there is more than `maxLines`. Counts code points, so Arabic and emoji are not split in the
 * middle of a character. Pure; the same words in the box and in the export.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.normalize('NFC').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  const push = () => { if (cur) { lines.push(cur); cur = ''; } };
  for (let word of words) {
    while ([...word].length > maxChars) {
      const chars = [...word];
      if (cur) push();
      lines.push(chars.slice(0, maxChars).join(''));
      word = chars.slice(maxChars).join('');
    }
    if (!cur) cur = word;
    else if ([...cur].length + 1 + [...word].length <= maxChars) cur = `${cur} ${word}`;
    else { push(); cur = word; }
  }
  push();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = [...kept[maxLines - 1]!];
  kept[maxLines - 1] = `${last.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`;
  return kept;
}

// ---- Zoom and pan (the viewport maths) -----------------------------------------------------------------------------------

export interface View { scale: number; tx: number; ty: number }
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 3;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** The view that shows the whole chart centred in the viewport (never enlarged beyond 1:1). */
export function fitView(chart: { width: number; height: number }, viewport: { width: number; height: number }, padding = 16): View {
  if (chart.width <= 0 || chart.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { scale: 1, tx: 0, ty: 0 };
  const scale = clampScale(Math.min(1, (viewport.width - 2 * padding) / chart.width, (viewport.height - 2 * padding) / chart.height));
  return { scale, tx: Math.round((viewport.width - chart.width * scale) / 2), ty: Math.round(Math.max(padding, (viewport.height - chart.height * scale) / 2)) };
}

/** Zooms by `factor` keeping the point (px, py) of the viewport where it is (the wheel, a pinch, the +/- buttons from the centre). */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { scale, tx: px - (px - view.tx) * k, ty: py - (py - view.ty) * k };
}

export const panBy = (view: View, dx: number, dy: number): View => ({ ...view, tx: view.tx + dx, ty: view.ty + dy });

/** Centres a box of the chart in the viewport at the current scale (to bring a unit into view). */
export function centreOn(view: View, box: { x: number; y: number; w: number; h: number }, viewport: { width: number; height: number }): View {
  return { ...view, tx: viewport.width / 2 - (box.x + box.w / 2) * view.scale, ty: viewport.height / 2 - (box.y + box.h / 2) * view.scale };
}
