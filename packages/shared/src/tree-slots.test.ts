import { describe, expect, it } from 'vitest';
import { childLists, limitsFor, listDropSlots, resolveDrop, topmostIds, treeOrder, type TreeRow } from './tree-move.js';

const T = (id: string, parentId: string | null, displayOrder: number): TreeRow => ({ id, parentId, displayOrder, code: id });
//  A(A1, A2(A2a), A3), B(B1), C
const rows = (): TreeRow[] => [T('A', null, 0), T('A1', 'A', 0), T('A2', 'A', 1), T('A2a', 'A2', 0), T('A3', 'A', 2), T('B', null, 1), T('B1', 'B', 0), T('C', null, 2)];

/** The slow way: ask resolveDrop about every candidate, in the same order, dropping repeats. */
function brute(all: TreeRow[], shown: string[], drag: string[], limits: ReturnType<typeof limitsFor>, shownChild: (id: string) => string | undefined) {
  const lists = childLists(all);
  const first = topmostIds(all, drag)[0]!;
  const par = all.find((r) => r.id === first)!.parentId ?? null;
  const taken = new Set(topmostIds(all, drag));
  const startKey = `${par}|${(lists.get(par) ?? []).slice(0, (lists.get(par) ?? []).indexOf(first)).filter((i) => !taken.has(i)).length}`;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of shown) {
    for (const position of ['before', 'inside', ...(shownChild(id) ? [] : ['after'])] as ('before' | 'inside' | 'after')[]) {
      const d = resolveDrop(all, drag, { id, position }, limits);
      if (!d.ok) continue;
      const key = d.noop ? startKey : `${d.parentId}|${d.moves[0]?.index ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`${position}:${id}`);
    }
  }
  return out;
}

describe('listDropSlots: the places the keyboard steps through', () => {
  it('gives the same places as asking resolveDrop about each, for single and multiple items, with and without a level limit', () => {
    const all = rows();
    const order = treeOrder(all);
    const shownChild = (id: string) => all.find((r) => r.parentId === id)?.id;
    for (const limits of [limitsFor({}), limitsFor({ internal: true, levelLabels: ['Standard', 'Sub-standard'] })]) {
      for (const drag of [['A1'], ['A2'], ['A'], ['C'], ['B1'], ['A2a'], ['A1', 'A3'], ['A1', 'C'], ['A', 'B']]) {
        const fast = listDropSlots(all, order, drag, limits, shownChild).slots.map((s) => `${s.position}:${s.rowId}`);
        expect(fast, `dragging ${drag.join('+')} with ${limits.maxLevels} levels`).toEqual(brute(all, order, drag, limits, shownChild));
      }
    }
  });

  it('starts on the place where the single item is now, and copes with a long list at once', () => {
    const all = rows();
    const { slots, start } = listDropSlots(all, treeOrder(all), ['A2'], limitsFor({}), (id) => all.find((r) => r.parentId === id)?.id);
    expect(slots[start]!.key).toBe('A|1');
    const big: TreeRow[] = [];
    for (let i = 0; i < 30; i += 1) { big.push(T(`T${i}`, null, i)); for (let j = 0; j < 19; j += 1) big.push(T(`T${i}.${j}`, `T${i}`, j)); }
    const children = new Map<string, string>();
    for (const r of big) if (r.parentId && !children.has(r.parentId)) children.set(r.parentId, r.id);
    const t = performance.now();
    const res = listDropSlots(big, treeOrder(big), ['T7.3'], limitsFor({}), (id) => children.get(id));
    expect(res.slots.length).toBeGreaterThan(600);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
