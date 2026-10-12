import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, limitsFor, planMoves, type TreeRow } from '@ams/shared';
import { applyUpdates, codeHint, describePlace, dropSlots, droppedWords, normalizePlace, pointerY, zoneAt } from './tree-dnd';

const T = (id: string, parentId: string | null, displayOrder: number): TreeRow & { depth?: number } => ({ id, parentId, displayOrder, code: id });
//  A(A1, A2(A2a), A3), B(B1), C
const rows = [T('A', null, 0), T('A1', 'A', 0), T('A2', 'A', 1), T('A2a', 'A2', 0), T('A3', 'A', 2), T('B', null, 1), T('B1', 'B', 0), T('C', null, 2)];
const order = rows.map((r) => r.id);
const label = (id: string) => `Item ${id}`;
const shownChild = (id: string) => rows.find((r) => r.parentId === id)?.id;

describe('where on a row the pointer is', () => {
  const rect = { top: 100, height: 40 };
  it('top edge is before, bottom edge is after, the middle is inside', () => {
    expect(zoneAt(rect, 101)).toBe('before');
    expect(zoneAt(rect, 110)).toBe('before'); // 25%
    expect(zoneAt(rect, 120)).toBe('inside');
    expect(zoneAt(rect, 135)).toBe('after');
    expect(zoneAt({ top: 0, height: 0 }, 5)).toBe('inside');
  });
  it('the bottom edge of a row whose sub-items show means "before its first sub-item"', () => {
    expect(normalizePlace({ rowId: 'A', position: 'after' }, shownChild)).toEqual({ rowId: 'A1', position: 'before' });
    expect(normalizePlace({ rowId: 'C', position: 'after' }, shownChild)).toEqual({ rowId: 'C', position: 'after' });
    expect(normalizePlace({ rowId: 'A', position: 'before' }, shownChild)).toEqual({ rowId: 'A', position: 'before' });
  });
  it('reads the pointer or the first touch', () => {
    expect(pointerY({ clientY: 42 } as unknown as Event)).toBe(42);
    expect(pointerY({ touches: [{ clientY: 7 }] } as unknown as Event)).toBe(7);
    expect(pointerY(null)).toBeNull();
  });
});

describe('the places the keyboard steps through', () => {
  it('lists before / inside / after in order, without repeats, starting where the item is now', () => {
    const { slots, start } = dropSlots(rows, order, ['A2'], DEFAULT_LIMITS, shownChild);
    const names = slots.map((s) => `${s.position}:${s.rowId}`);
    // nowhere inside A2 or its sub-item; no place that is the same position twice
    expect(names.some((n) => n.endsWith(':A2a'))).toBe(false);
    expect(names).not.toContain('inside:A2');
    expect(new Set(slots.map((s) => s.key)).size).toBe(slots.length);
    expect(slots[start]!.key).toBe('A|1'); // where A2 is now: under A, second
    expect(names[0]).toBe('before:A'); // the first place offered is the very top
    expect(names).toContain('inside:C');
    expect(names).toContain('after:C'); // the very end
  });

  it('leaves out places the level model refuses', () => {
    const limits = limitsFor({ internal: true, levelLabels: ['Standard', 'Sub-standard'] });
    const { slots } = dropSlots(rows, order, ['C'], limits, shownChild);
    const names = slots.map((s) => `${s.position}:${s.rowId}`);
    expect(names).not.toContain('inside:A1'); // a third level
    expect(names).toContain('inside:A');
  });

  it('for several items, the places are for the group', () => {
    const { slots } = dropSlots(rows, order, ['A1', 'C'], DEFAULT_LIMITS, shownChild);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => s.rowId !== 'A1' || s.position === 'before')).toBe(true);
  });
});

describe('what a place means in words', () => {
  const say = (drag: string[], rowId: string, position: 'before' | 'after' | 'inside', limits = DEFAULT_LIMITS) => describePlace(rows, drag, { rowId, position }, label, limits);
  it('says it plainly, with the parent', () => {
    expect(say(['C'], 'A2', 'before')).toEqual({ ok: true, text: 'Put Item C before Item A2, under Item A.' });
    expect(say(['A1'], 'B', 'after')).toEqual({ ok: true, text: 'Put Item A1 after Item B, at the top level.' });
    expect(say(['C'], 'B', 'after')).toEqual({ ok: true, text: 'Item C: leave where it is.' });
    expect(say(['C'], 'B', 'inside')).toEqual({ ok: true, text: 'Put Item C inside Item B, as the last sub-item.' });
    expect(say(['A1', 'A3'], 'C', 'before').text).toBe('Put 2 items before Item C, at the top level.');
  });
  it('says why not, and what staying put means', () => {
    expect(say(['A'], 'A2a', 'inside')).toMatchObject({ ok: false, text: expect.stringMatching(/^Cannot drop here\. A requirement cannot be moved under itself/) });
    expect(say(['A2'], 'A2', 'before')).toEqual({ ok: true, text: 'Item A2: leave where it is.' });
    const limits = limitsFor({ internal: true, levelLabels: ['Standard', 'Sub-standard'] });
    expect(say(['C'], 'A1', 'inside', limits)).toMatchObject({ ok: false, text: expect.stringMatching(/more than 2 levels deep/) });
  });
});

describe('the tree right after a drop (the optimistic update)', () => {
  it('matches what the server will answer: new parents, gap-free orders, tree order, depths', () => {
    const plan = planMoves(rows, [{ id: 'A2', parentId: 'B', index: 0 }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = applyUpdates(rows, plan.updates);
    expect(next.map((r) => [r.id, r.depth])).toEqual([['A', 0], ['A1', 1], ['A3', 1], ['B', 0], ['A2', 1], ['A2a', 2], ['B1', 1], ['C', 0]]);
    expect(next.find((r) => r.id === 'A3')!.displayOrder).toBe(1);
    expect(rows.find((r) => r.id === 'A3')!.displayOrder).toBe(2); // the old rows are not mutated
  });
});

describe('words for the result', () => {
  it('says that codes are not renumbered', () => {
    expect(droppedWords('2.3', '2', false)).toBe('Moved 2.3 under 2. Codes are not renumbered.');
    expect(droppedWords('2.3', null, false)).toBe('Moved 2.3 to the top level. Codes are not renumbered.');
    expect(droppedWords('2.3', '2', true)).toBe('Moved 2.3 in its new position. Codes are not renumbered.');
  });
  it('points out a code the IQF would now read differently, and only then', () => {
    expect(codeHint('2.3', '1')).toMatch(/Its code is still 2\.3\. Edit the code/);
    expect(codeHint('2.3', null)).toMatch(/names a sub-standard/);
    expect(codeHint('2.3', '2')).toBeNull();
    expect(codeHint('S1.1', '1')).toBeNull();
    expect(codeHint('4', '1')).toBeNull();
  });
});
