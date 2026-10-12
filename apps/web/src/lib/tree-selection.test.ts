import { describe, expect, it } from 'vitest';
import type { TreeRow } from '@ams/shared';
import { EMPTY_SEL, checkboxLabel, clickSelect, extendSelect, prune, rangeIds, selectAll, selectionWords, summarize } from './tree-selection';
import { TreeStore, parseRowKey } from './tree-store';

const T = (id: string, parentId: string | null, displayOrder: number): TreeRow => ({ id, parentId, displayOrder, code: id });
//  A(A1, A2(A2a)), B(B1), C
const rows = [T('A', null, 0), T('A1', 'A', 0), T('A2', 'A', 1), T('A2a', 'A2', 0), T('B', null, 1), T('B1', 'B', 0), T('C', null, 2)];
const order = ['A', 'A1', 'A2', 'A2a', 'B', 'B1', 'C'];
const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort();

describe('selection rules', () => {
  it('a plain checkbox click and a ctrl/cmd-click toggle one row and move the anchor', () => {
    let s = clickSelect(EMPTY_SEL, order, 'A1');
    expect(ids(s)).toEqual(['A1']);
    expect(s.anchor).toBe('A1');
    s = clickSelect(s, order, 'B', { ctrl: true });
    expect(ids(s)).toEqual(['A1', 'B']);
    s = clickSelect(s, order, 'A1', { ctrl: true });
    expect(ids(s)).toEqual(['B']);
    expect(s.anchor).toBe('A1');
  });

  it('shift-click selects the range from the anchor, either direction, keeping what was selected', () => {
    let s = clickSelect(EMPTY_SEL, order, 'A2');
    s = clickSelect(s, order, 'B', { shift: true });
    expect(ids(s)).toEqual(['A2', 'A2a', 'B']);
    expect(s.anchor).toBe('A2');
    s = clickSelect(s, order, 'A', { shift: true });
    expect(ids(s)).toEqual(['A', 'A1', 'A2', 'A2a', 'B']);
    // shift with no anchor acts as a plain click
    expect(ids(clickSelect(EMPTY_SEL, order, 'C', { shift: true }))).toEqual(['C']);
    // the range only covers what is shown
    expect(rangeIds(['A', 'B', 'C'], 'A', 'C')).toEqual(['A', 'B', 'C']);
    expect(rangeIds(['A', 'C'], 'A', 'B')).toEqual([]);
  });

  it('shift+arrow extends from the anchor as the focus moves', () => {
    let s = clickSelect(EMPTY_SEL, order, 'A1');
    s = extendSelect(s, order, 'A1', 'A2');
    s = extendSelect(s, order, 'A2', 'A2a');
    expect(ids(s)).toEqual(['A1', 'A2', 'A2a']);
    // with nothing selected, the row focus was on becomes the anchor
    expect(ids(extendSelect(EMPTY_SEL, order, 'B', 'B1'))).toEqual(['B', 'B1']);
  });

  it('select all takes what is shown; prune forgets rows that are gone', () => {
    const all = selectAll(['A', 'B']);
    expect(ids(all)).toEqual(['A', 'B']);
    const p = prune(all, new Set(['B']));
    expect(ids(p)).toEqual(['B']);
    expect(prune(p, new Set(['B', 'X']))).toBe(p); // nothing changed: the same object
  });

  it('a selected parent and its selected child count once for delete and move, and the count says what comes with them', () => {
    const s = summarize(rows, new Set(['A', 'A2', 'A2a', 'C']));
    expect(s.selected).toBe(4);
    expect(s.roots).toEqual(['A', 'C']);
    expect(s.subItems).toBe(3); // A1, A2, A2a come with A
    expect(selectionWords(s)).toBe('4 selected, with 3 sub-items');
    expect(selectionWords(summarize(rows, new Set(['C'])))).toBe('1 selected');
    expect(selectionWords(summarize(rows, new Set(['A1', 'B1'])))).toBe('2 selected');
    expect(selectionWords(summarize(rows, new Set(['A2'])))).toBe('1 selected, with 1 sub-item');
  });

  it('labels a checkbox with what it is and what comes with it', () => {
    expect(checkboxLabel('2.1', 6, false)).toBe('Select 2.1, with its 6 sub-items');
    expect(checkboxLabel('2.1', 1, true)).toBe('Deselect 2.1, with its 1 sub-item');
    expect(checkboxLabel('2.1.1', 0, false)).toBe('Select 2.1.1');
  });
});

describe('the interaction store', () => {
  it('gives each row its own slice, so a change elsewhere does not change it', () => {
    const store = new TreeStore();
    store.setMode(true);
    const before = store.rowKey('A');
    store.setSelection(clickSelect(store.selection, order, 'B'));
    expect(store.rowKey('A')).toBe(before); // A is unaffected by B being ticked
    expect(parseRowKey(store.rowKey('B')).selected).toBe(true);
    expect(store.mode).toBe(true); // Select mode is only what the person turned on
    store.startDrag(['B'], false);
    store.setTarget({ rowId: 'C', position: 'before', ok: true, text: 'x' });
    expect(parseRowKey(store.rowKey('C')).indicator).toEqual({ position: 'before', ok: true });
    expect(parseRowKey(store.rowKey('A')).indicator).toBeNull();
    expect(parseRowKey(store.rowKey('B')).dragged).toBe(true);
    store.endDrag();
    expect(parseRowKey(store.rowKey('C')).indicator).toBeNull();
    store.setMode(false);
    expect(store.selected.size).toBe(0); // leaving Select mode clears the selection
    store.setSelection(clickSelect(store.selection, order, 'C'));
    expect(store.mode).toBe(false); // ticking a row (a checkbox, ctrl-click) does not switch it on
    expect(store.selected.size).toBe(1);
  });
});
