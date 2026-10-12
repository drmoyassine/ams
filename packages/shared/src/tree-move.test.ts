import { describe, expect, it } from 'vitest';
import { MAX_TREE_DEPTH, appendMoves, childLists, limitsFor, planMoves, planPlacements, resolveDrop, topmostIds, treeOrder, type TreeRow } from './tree-move.js';

// ids are readable strings here; the pure rules do not care about their shape
//   A
//     A1
//     A2
//       A2a
//     A3
//   B
//     B1
//   C
const T = (id: string, parentId: string | null, displayOrder: number): TreeRow => ({ id, parentId, displayOrder, code: id });
const rows = (): TreeRow[] => [T('A', null, 0), T('A1', 'A', 0), T('A2', 'A', 1), T('A2a', 'A2', 0), T('A3', 'A', 2), T('B', null, 1), T('B1', 'B', 0), T('C', null, 2)];

/** Applies a plan's updates to rows and reads the tree back as "parent: children" text. */
function apply(base: TreeRow[], updates: { id: string; parentId: string | null; displayOrder: number }[]): string {
  const next = base.map((r) => ({ ...r, ...(updates.find((u) => u.id === r.id) ?? {}) }));
  const lists = childLists(next);
  return [...lists].sort(([a], [b]) => (a ?? '').localeCompare(b ?? '')).map(([p, ids]) => `${p ?? '-'}:${ids.join(',')}`).join(' | ');
}
const must = <T extends { ok: boolean }>(p: T): Extract<T, { ok: true }> => { expect(p.ok).toBe(true); return p as Extract<T, { ok: true }>; };

describe('planMoves', () => {
  it('re-parents and renumbers both lists without gaps', () => {
    const p = must(planMoves(rows(), [{ id: 'A2', parentId: 'B', index: 0 }]));
    expect(apply(rows(), p.updates)).toBe('-:A,B,C | A:A1,A3 | A2:A2a | B:A2,B1');
    expect(p.updates.filter((u) => u.parentId === 'A').map((u) => u.displayOrder).sort()).toEqual([1]); // only A3 shifted; A1 stays
  });

  it('reorders inside one parent and leaves lists it did not touch alone', () => {
    const p = must(planMoves(rows(), [{ id: 'A3', parentId: 'A', index: 0 }]));
    expect(apply(rows(), p.updates)).toBe('-:A,B,C | A:A3,A1,A2 | A2:A2a | B:B1');
    expect(p.updates.map((u) => u.id).sort()).toEqual(['A1', 'A2', 'A3']);
  });

  it('moves several together, keeping their given order, positions counted without any moved item', () => {
    const p = must(planMoves(rows(), [{ id: 'A1', parentId: 'C', index: 0 }, { id: 'A3', parentId: 'C', index: 1 }]));
    expect(apply(rows(), p.updates)).toBe('-:A,B,C | A:A2 | A2:A2a | B:B1 | C:A1,A3');
    // dropping two items of one list after the last of that same list
    const q = must(planMoves(rows(), [{ id: 'A1', parentId: 'A', index: 1 }, { id: 'A2', parentId: 'A', index: 2 }]));
    expect(apply(rows(), q.updates)).toBe('-:A,B,C | A:A3,A1,A2 | A2:A2a | B:B1');
  });

  it('clamps an index past the end and moves to the top level', () => {
    const p = must(planMoves(rows(), [{ id: 'A2', parentId: null, index: 99 }]));
    expect(apply(rows(), p.updates)).toBe('-:A,B,C,A2 | A:A1,A3 | A2:A2a | B:B1');
  });

  it('refuses a move under itself or its own sub-items, naming nothing as moved', () => {
    for (const [id, parent] of [['A', 'A'], ['A', 'A2a'], ['A2', 'A2a']] as const) {
      const p = planMoves(rows(), [{ id, parentId: parent, index: 0 }]);
      expect(p).toMatchObject({ ok: false, code: 'cycle' });
    }
    // a cycle made of two moves in one request
    expect(planMoves(rows(), [{ id: 'B', parentId: 'C', index: 0 }, { id: 'C', parentId: 'B', index: 0 }])).toMatchObject({ ok: false, code: 'cycle' });
  });

  it('refuses a subtree that would go deeper than the most a standard can have', () => {
    let chain: TreeRow[] = [T('n0', null, 0)];
    for (let i = 1; i < MAX_TREE_DEPTH; i += 1) chain = [...chain, T(`n${i}`, `n${i - 1}`, 0)]; // depths 0..7
    const all = [...chain, T('X', null, 1), T('Y', 'X', 0)];
    expect(planMoves(all, [{ id: 'X', parentId: `n${MAX_TREE_DEPTH - 1}`, index: 0 }])).toMatchObject({ ok: false, code: 'depth' });
    expect(planMoves(all, [{ id: 'Y', parentId: `n${MAX_TREE_DEPTH - 2}`, index: 0 }]).ok).toBe(true); // lands at depth 7, the last allowed
    expect(planMoves(all, [{ id: 'Y', parentId: `n${MAX_TREE_DEPTH - 1}`, index: 0 }])).toMatchObject({ ok: false, code: 'depth' });
  });

  it('refuses unknown ids, duplicates and an empty list', () => {
    expect(planMoves(rows(), [{ id: 'nope', parentId: null, index: 0 }])).toMatchObject({ ok: false, code: 'unknown' });
    expect(planMoves(rows(), [{ id: 'A1', parentId: 'nope', index: 0 }])).toMatchObject({ ok: false, code: 'unknown' });
    expect(planMoves(rows(), [{ id: 'A1', parentId: null, index: 0 }, { id: 'A1', parentId: null, index: 1 }])).toMatchObject({ ok: false, code: 'invalid' });
    expect(planMoves(rows(), [])).toMatchObject({ ok: false });
  });

  it('says so when nothing changes, and renumbers a list that had gaps and ties', () => {
    expect(must(planMoves(rows(), [{ id: 'A2', parentId: 'A', index: 1 }])).unchanged).toBe(true);
    const messy = [T('P', null, 0), T('a', 'P', 5), T('b', 'P', 5), T('c', 'P', 9), T('z', null, 1)];
    const p = must(planMoves(messy, [{ id: 'z', parentId: 'P', index: 0 }]));
    expect(apply(messy, p.updates)).toBe('-:P | P:z,a,b,c');
    expect(p.updates.map((u) => u.displayOrder).sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('undo runs', () => {
  const roundTrip = (moves: Parameters<typeof planMoves>[1]) => {
    const p = must(planMoves(rows(), moves));
    const after = rows().map((r) => ({ ...r, ...(p.updates.find((u) => u.id === r.id) ?? {}) }));
    const back = must(planPlacements(after, p.undo));
    const restored = after.map((r) => ({ ...r, ...(back.updates.find((u) => u.id === r.id) ?? {}) }));
    return { before: apply(rows(), []), restored: apply(restored, []) };
  };

  it('restores a re-parent, a reorder, a multi-move and moves that cross', () => {
    for (const moves of [
      [{ id: 'A2', parentId: 'B', index: 0 }],
      [{ id: 'A3', parentId: 'A', index: 0 }],
      [{ id: 'A1', parentId: 'C', index: 0 }, { id: 'A3', parentId: 'C', index: 1 }],
      [{ id: 'A1', parentId: 'B', index: 1 }, { id: 'B1', parentId: 'A', index: 0 }, { id: 'C', parentId: 'A2', index: 0 }],
      [{ id: 'A', parentId: 'C', index: 0 }, { id: 'B', parentId: 'A', index: 0 }],
    ]) {
      const { before, restored } = roundTrip(moves);
      expect(restored).toBe(before);
    }
  });

  it('is one compact run per stretch of moved siblings', () => {
    const p = must(planMoves(rows(), [{ id: 'A1', parentId: 'C', index: 0 }, { id: 'A2', parentId: 'C', index: 1 }, { id: 'A3', parentId: 'C', index: 2 }]));
    expect(p.undo).toEqual([{ parentId: 'A', afterId: null, ids: ['A1', 'A2', 'A3'] }]);
  });

  it('is refused, not guessed, when the item it sat after is gone', () => {
    const p = must(planMoves(rows(), [{ id: 'A3', parentId: 'C', index: 0 }]));
    const gone = rows().filter((r) => r.id !== 'A2');
    expect(planPlacements(gone, p.undo)).toMatchObject({ ok: false });
  });
});

describe('selection helpers', () => {
  it('lists tree order and drops items that sit under another selected item', () => {
    expect(treeOrder(rows())).toEqual(['A', 'A1', 'A2', 'A2a', 'A3', 'B', 'B1', 'C']);
    expect(topmostIds(rows(), ['A2a', 'B1', 'A', 'A3'])).toEqual(['A', 'B1']);
    expect(topmostIds(rows(), ['C', 'ghost'])).toEqual(['C']);
  });
});

describe('resolveDrop: which parent and index a drop means', () => {
  const at = (drag: string[], id: string, position: 'before' | 'after' | 'inside') => resolveDrop(rows(), drag, { id, position });
  const only = (d: ReturnType<typeof at>) => { expect(d.ok).toBe(true); return d as Extract<typeof d, { ok: true }>; };

  it('before and after a sibling name the target parent and the index next to it', () => {
    expect(only(at(['C'], 'A2', 'before')).moves).toEqual([{ id: 'C', parentId: 'A', index: 1 }]);
    expect(only(at(['C'], 'A2', 'after')).moves).toEqual([{ id: 'C', parentId: 'A', index: 2 }]);
    expect(only(at(['A2a'], 'B', 'before')).moves).toEqual([{ id: 'A2a', parentId: null, index: 1 }]);
    expect(only(at(['A2a'], 'B', 'after')).moves).toEqual([{ id: 'A2a', parentId: null, index: 2 }]);
  });

  it('inside appends as the last child', () => {
    expect(only(at(['C'], 'B', 'inside')).moves).toEqual([{ id: 'C', parentId: 'B', index: 1 }]);
    expect(only(at(['C'], 'A2a', 'inside')).moves).toEqual([{ id: 'C', parentId: 'A2a', index: 0 }]);
  });

  it('counts the target list without the dragged items (dragging down inside one list)', () => {
    // A1 dropped after A2: without A1 the list is [A2, A3]; after A2 is index 1
    expect(only(at(['A1'], 'A2', 'after')).moves).toEqual([{ id: 'A1', parentId: 'A', index: 1 }]);
    expect(only(at(['A3'], 'A1', 'before')).moves).toEqual([{ id: 'A3', parentId: 'A', index: 0 }]);
  });

  it('a multi-drag keeps the tree order of the items and gives them consecutive positions', () => {
    const d = only(at(['A3', 'A1'], 'C', 'before'));
    expect(d.moves).toEqual([{ id: 'A1', parentId: null, index: 2 }, { id: 'A3', parentId: null, index: 3 }]);
    // a selected parent and its child: only the parent moves
    expect(only(at(['A2', 'A2a'], 'C', 'inside')).moves).toEqual([{ id: 'A2', parentId: 'C', index: 0 }]);
  });

  it('refuses a drop into the dragged item\'s own subtree and treats a drop on itself as nothing', () => {
    expect(at(['A'], 'A2a', 'inside')).toMatchObject({ ok: false });
    expect(at(['A'], 'A1', 'before')).toMatchObject({ ok: false });
    expect(at(['A2'], 'A2a', 'after')).toMatchObject({ ok: false });
    expect(only(at(['A2'], 'A2', 'inside')).noop).toBe(true);
    expect(only(at(['A2'], 'A2', 'before')).moves).toEqual([]);
  });

  it('knows a drop that changes nothing', () => {
    expect(only(at(['A2'], 'A1', 'after')).noop).toBe(true);
    expect(only(at(['A2'], 'A3', 'before')).noop).toBe(true);
    expect(only(at(['A2'], 'B', 'inside')).noop).toBe(false);
  });

  it('every resolved drop is accepted by planMoves (or refused for depth only)', () => {
    for (const drag of ['A', 'A1', 'A2', 'A2a', 'B', 'C']) {
      for (const over of ['A', 'A1', 'A2', 'A2a', 'A3', 'B', 'B1', 'C']) {
        for (const position of ['before', 'after', 'inside'] as const) {
          const d = resolveDrop(rows(), [drag], { id: over, position });
          if (!d.ok || d.moves.length === 0) continue;
          expect(planMoves(rows(), d.moves).ok).toBe(true);
        }
      }
    }
  });
});

describe('level limits', () => {
  it('limits the internal framework to the levels it names and an external standard to the general cap', () => {
    expect(limitsFor({ internal: true, levelLabels: ['Standard', 'Sub-standard'] })).toEqual({ maxLevels: 2, levelNames: ['Standard', 'Sub-standard'] });
    expect(limitsFor({ internal: false, levelLabels: ['Standard'] }).maxLevels).toBe(MAX_TREE_DEPTH);
    expect(limitsFor({ internal: true, levelLabels: [] }).maxLevels).toBe(MAX_TREE_DEPTH);
  });

  it('refuses a third level under a two-level model, in resolveDrop too, with the level names', () => {
    const limits = limitsFor({ internal: true, levelLabels: ['Standard', 'Sub-standard'] });
    expect(planMoves(rows(), [{ id: 'A2', parentId: 'B1', index: 0 }], undefined, limits)).toMatchObject({ ok: false, code: 'depth' });
    const d = resolveDrop(rows(), ['C'], { id: 'A1', position: 'inside' }, limits);
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.message).toMatch(/more than 2 levels deep.*Standard, Sub-standard/);
    // A2 carries A2a (a third level already): moving it anywhere keeps it too deep
    expect(resolveDrop(rows(), ['A2'], { id: 'B', position: 'inside' }, limits).ok).toBe(false);
    expect(resolveDrop(rows(), ['A2'], { id: 'C', position: 'after' }, limits).ok).toBe(true); // at the top level it keeps its two levels
  });

  it('appendMoves puts items last under a parent, in tree order, counting without themselves', () => {
    expect(appendMoves(rows(), ['A3', 'A1', 'A2a'], 'B')).toEqual([{ id: 'A1', parentId: 'B', index: 1 }, { id: 'A2a', parentId: 'B', index: 2 }, { id: 'A3', parentId: 'B', index: 3 }]);
    expect(appendMoves(rows(), ['B'], null)).toEqual([{ id: 'B', parentId: null, index: 2 }]);
  });
});
