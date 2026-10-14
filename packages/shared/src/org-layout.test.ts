import { describe, expect, it } from 'vitest';
import { centreOn, defaultCollapsed, descendantCounts, fitView, layoutOrgChart, MAX_SCALE, MIN_SCALE, panBy, wrapText, zoomAt } from './org-layout.js';
import type { TreeRow } from './tree-move.js';

const row = (id: string, parentId: string | null, displayOrder = 0): TreeRow => ({ id, parentId, displayOrder });
const box = (l: ReturnType<typeof layoutOrgChart>, id: string) => l.boxes.find((b) => b.id === id)!;
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('layoutOrgChart', () => {
  it('draws a single root alone, centred in its own margin', () => {
    const l = layoutOrgChart([row('a', null)], { margin: 10 });
    expect(l.boxes).toHaveLength(1);
    expect(l.links).toEqual([]);
    expect(box(l, 'a')).toMatchObject({ x: 10, y: 10, w: 200, h: 84, depth: 0, hasChildren: false, collapsed: false, hiddenCount: 0 });
    expect(l.width).toBe(220);
    expect(l.height).toBe(104);
  });

  it('centres a parent over its children and joins them with elbows', () => {
    const l = layoutOrgChart([row('p', null), row('a', 'p', 0), row('b', 'p', 1)], { margin: 0, gapX: 20, gapY: 40 });
    const [p, a, b] = [box(l, 'p'), box(l, 'a'), box(l, 'b')];
    expect(a.x).toBe(0);
    expect(b.x).toBe(220);
    expect(p.x + p.w / 2).toBe((a.x + a.w / 2 + b.x + b.w / 2) / 2);
    expect(a.y).toBe(p.y + p.h + 40);
    expect(l.links).toHaveLength(2);
    expect(l.links[0]).toEqual({ from: 'p', to: 'a', d: `M${p.x + 100} ${p.y + p.h}V${a.y - 20}H${a.x + 100}V${a.y}` });
  });

  it('keeps several roots side by side in display order', () => {
    const l = layoutOrgChart([row('b', null, 1), row('a', null, 0), row('a1', 'a'), row('b1', 'b')], { margin: 0, rootGap: 60 });
    expect(box(l, 'a').x).toBeLessThan(box(l, 'b').x);
    expect(box(l, 'b').x - (box(l, 'a').x + 200)).toBeGreaterThanOrEqual(60);
    expect(l.links.map((k) => `${k.from}>${k.to}`)).toEqual(['a>a1', 'b>b1']);
  });

  it('gives a wide level the room it needs, with no two boxes overlapping', () => {
    const rows: TreeRow[] = [row('root', null)];
    for (let i = 0; i < 25; i += 1) { rows.push(row(`c${i}`, 'root', i)); rows.push(row(`g${i}`, `c${i}`)); }
    const l = layoutOrgChart(rows);
    expect(l.width).toBeGreaterThan(25 * 200);
    for (let i = 0; i < l.boxes.length; i += 1) for (let j = i + 1; j < l.boxes.length; j += 1) expect(overlap(l.boxes[i]!, l.boxes[j]!)).toBe(false);
    // The root is centred over its first and last child.
    const first = box(l, 'c0');
    const last = box(l, 'c24');
    expect(box(l, 'root').x + 100).toBe(Math.round((first.x + 100 + last.x + 100) / 2));
  });

  it('does not draw what is under a collapsed unit, and says how many are hidden', () => {
    const rows = [row('r', null), row('a', 'r', 0), row('a1', 'a'), row('a2', 'a', 1), row('a11', 'a1'), row('b', 'r', 1)];
    const l = layoutOrgChart(rows, { collapsed: new Set(['a']) });
    expect(l.boxes.map((b) => b.id).sort()).toEqual(['a', 'b', 'r']);
    expect(box(l, 'a')).toMatchObject({ collapsed: true, hasChildren: true, hiddenCount: 3 });
    expect(box(l, 'r')).toMatchObject({ collapsed: false, hiddenCount: 0 });
    expect(l.links).toHaveLength(2);
  });

  it('mirrors for right-to-left: the same chart, the first child at the right', () => {
    const rows = [row('p', null), row('a', 'p', 0), row('b', 'p', 1), row('b1', 'b')];
    const ltr = layoutOrgChart(rows);
    const rtl = layoutOrgChart(rows, { rtl: true });
    expect(rtl.width).toBe(ltr.width);
    expect(rtl.height).toBe(ltr.height);
    for (const b of ltr.boxes) {
      const m = box(rtl, b.id);
      expect(m.y).toBe(b.y);
      expect(m.x).toBe(ltr.width - b.x - b.w);
    }
    expect(box(rtl, 'a').x).toBeGreaterThan(box(rtl, 'b').x);
    // The connector of a mirrored link starts at the mirrored parent centre.
    const p = box(rtl, 'p');
    expect(rtl.links[0]!.d.startsWith(`M${p.x + p.w / 2} `)).toBe(true);
  });

  it('is deterministic: the same input gives the same output, whatever order the rows come in', () => {
    const rows = [row('r', null), row('a', 'r', 0), row('b', 'r', 1), row('c', 'r', 2), row('a1', 'a')];
    const one = layoutOrgChart(rows);
    const two = layoutOrgChart([...rows].reverse());
    const sorted = (l: typeof one) => [...l.boxes].sort((x, y) => x.id.localeCompare(y.id));
    expect(sorted(two)).toEqual(sorted(one));
    expect(layoutOrgChart(rows)).toEqual(one);
  });

  it('aligns each level and uses the tallest box of it; honours the measured sizes', () => {
    const rows = [row('r', null), row('a', 'r', 0), row('b', 'r', 1), row('a1', 'a')];
    const heights: Record<string, number> = { r: 60, a: 140, b: 70, a1: 90 };
    const l = layoutOrgChart(rows, { measure: (id) => ({ w: 180, h: heights[id]! }), gapY: 30, margin: 0 });
    expect(box(l, 'a').y).toBe(box(l, 'b').y);
    expect(box(l, 'a').y).toBe(60 + 30);
    expect(box(l, 'a1').y).toBe(60 + 30 + 140 + 30);
    expect(box(l, 'a').w).toBe(180);
    expect(l.height).toBe(60 + 30 + 140 + 30 + 90);
  });

  it('hangs three or more leaf sub-units in one column under their unit instead of spreading them out', () => {
    const rows = [row('d', null), ...[0, 1, 2, 3, 4, 5].map((i) => row(`s${i}`, 'd', i))];
    const l = layoutOrgChart(rows, { margin: 0 });
    const flat = layoutOrgChart(rows, { margin: 0, hangLeaves: false });
    expect(l.width).toBeLessThan(flat.width / 3);
    const xs = new Set(rows.slice(1).map((r) => box(l, r.id).x));
    expect(xs.size).toBe(1);
    expect(box(l, 's0').x).toBe(box(l, 'd').x + 28);
    for (let i = 1; i < 6; i += 1) expect(box(l, `s${i}`).y).toBeGreaterThan(box(l, `s${i - 1}`).y + 84);
    for (let i = 0; i < l.boxes.length; i += 1) for (let j = i + 1; j < l.boxes.length; j += 1) expect(overlap(l.boxes[i]!, l.boxes[j]!)).toBe(false);
    expect(l.height).toBe(box(l, 's5').y + 84 + 24 - 24);
    // The link runs down a stem at the parent's start edge and across to the child's near edge.
    expect(l.links[0]!.d).toBe(`M${box(l, 'd').x + 14} ${box(l, 'd').y + 84}V${box(l, 's0').y + 42}H${box(l, 's0').x}`);
    // Mirrored: the column hangs from the right edge and links reach the child's right edge.
    const r = layoutOrgChart(rows, { margin: 0, rtl: true });
    expect(box(r, 's0').x + 200).toBe(r.width - (box(l, 's0').x));
    expect(r.links[0]!.d.endsWith(`H${box(r, 's0').x + 200}`)).toBe(true);
    // Fewer than three, or children with children of their own, are drawn in the ordinary way.
    const two = layoutOrgChart([row('p', null), row('a', 'p', 0), row('b', 'p', 1)]);
    expect(box(two, 'a').y).toBe(box(two, 'b').y);
    const deep = layoutOrgChart([row('p', null), row('a', 'p', 0), row('b', 'p', 1), row('c', 'p', 2), row('c1', 'c')]);
    expect(box(deep, 'a').y).toBe(box(deep, 'b').y);
  });

  it('copes with an empty chart and with a very deep one', () => {
    expect(layoutOrgChart([])).toMatchObject({ boxes: [], links: [], width: 48, height: 48 });
    const rows: TreeRow[] = [row('n0', null)];
    for (let i = 1; i < 200; i += 1) rows.push(row(`n${i}`, `n${i - 1}`));
    expect(layoutOrgChart(rows).boxes).toHaveLength(200);
  });

  it('lays out 300 units quickly', () => {
    const rows: TreeRow[] = [row('u', null)];
    for (let c = 0; c < 10; c += 1) {
      rows.push(row(`c${c}`, 'u', c));
      for (let d = 0; d < 6; d += 1) { rows.push(row(`d${c}-${d}`, `c${c}`, d)); for (let s = 0; s < 4; s += 1) rows.push(row(`s${c}-${d}-${s}`, `d${c}-${d}`, s)); }
    }
    expect(rows.length).toBeGreaterThanOrEqual(300);
    const t = Date.now();
    const l = layoutOrgChart(rows);
    expect(Date.now() - t).toBeLessThan(500);
    expect(l.boxes).toHaveLength(rows.length);
  });
});

describe('defaultCollapsed', () => {
  const big = () => {
    const rows: TreeRow[] = [row('u', null), row('c', 'u'), row('d', 'c'), row('s', 'd'), row('t', 's'), row('x', 't')];
    for (let i = 0; i < 70; i += 1) rows.push(row(`f${i}`, 'u', i + 1));
    return rows;
  };
  it('leaves a small chart open', () => {
    expect(defaultCollapsed([row('a', null), row('b', 'a')])).toEqual(new Set());
  });
  it('collapses units at depth 3 and below that have sub-units, in a big chart', () => {
    // u(0) c(1) d(2) s(3) t(4) x(5): s and t have children and sit at depth 3 and 4.
    expect([...defaultCollapsed(big())].sort()).toEqual(['s', 't']);
    expect([...defaultCollapsed(big(), { depth: 1 })].sort()).toEqual(['c', 'd', 's', 't']);
  });
});

describe('descendantCounts', () => {
  it('counts every level below a unit', () => {
    const m = descendantCounts([row('r', null), row('a', 'r'), row('b', 'a'), row('c', 'a')]);
    expect(m.get('r')).toBe(3);
    expect(m.get('a')).toBe(2);
    expect(m.get('b')).toBe(0);
  });
});

describe('wrapText', () => {
  it('wraps at spaces and never exceeds the width', () => {
    expect(wrapText('College of Engineering and Petroleum', 16, 3)).toEqual(['College of', 'Engineering and', 'Petroleum']);
  });
  it('cuts a word that is longer than a line, and ends with an ellipsis when it runs out of lines', () => {
    expect(wrapText('Supercalifragilisticexpialidocious', 10, 5)).toEqual(['Supercalif', 'ragilistic', 'expialidoc', 'ious']);
    const cut = wrapText('one two three four five six seven', 8, 2);
    expect(cut).toHaveLength(2);
    expect(cut[1]!.endsWith('…')).toBe(true);
    expect([...cut[1]!].length).toBeLessThanOrEqual(8);
  });
  it('counts characters, not bytes, so Arabic text wraps like any other and is normalised', () => {
    const lines = wrapText('كلية الهندسة والبترول والعلوم التطبيقية', 14, 4);
    expect(lines.every((l) => [...l].length <= 14)).toBe(true);
    expect(lines.join(' ')).toBe('كلية الهندسة والبترول والعلوم التطبيقية');
    expect(wrapText('Café', 10, 1)).toEqual(['Café']);
  });
  it('returns nothing for empty text', () => {
    expect(wrapText('   ', 10, 2)).toEqual([]);
  });
});

describe('viewport maths', () => {
  it('fits the whole chart into the viewport, centred, and never enlarges past 1:1', () => {
    const v = fitView({ width: 2000, height: 1000 }, { width: 1000, height: 600 });
    expect(v.scale).toBeCloseTo((1000 - 32) / 2000);
    expect(v.tx).toBeGreaterThanOrEqual(0);
    const small = fitView({ width: 300, height: 200 }, { width: 1000, height: 600 });
    expect(small.scale).toBe(1);
    expect(small.tx).toBe(350);
    expect(fitView({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({ scale: 1, tx: 0, ty: 0 });
  });
  it('zooms around a point so that point stays put, within the limits', () => {
    const v0 = { scale: 1, tx: 0, ty: 0 };
    const v1 = zoomAt(v0, 2, 100, 50);
    expect(v1.scale).toBe(2);
    // The chart point under (100, 50) before is under (100, 50) after.
    expect((100 - v1.tx) / v1.scale).toBeCloseTo(100);
    expect((50 - v1.ty) / v1.scale).toBeCloseTo(50);
    expect(zoomAt(v0, 1000, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAt(v0, 0.0001, 0, 0).scale).toBe(MIN_SCALE);
  });
  it('pans and centres on a box', () => {
    expect(panBy({ scale: 1, tx: 5, ty: 5 }, 10, -5)).toEqual({ scale: 1, tx: 15, ty: 0 });
    const v = centreOn({ scale: 2, tx: 0, ty: 0 }, { x: 100, y: 100, w: 200, h: 80 }, { width: 800, height: 600 });
    expect(v.tx + (100 + 100) * 2).toBe(400);
    expect(v.ty + (100 + 40) * 2).toBe(300);
  });
});
