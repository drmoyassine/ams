// Effective scope and champion (TASK-086): own, else mapped IQF items (union of scopes, champion only when they agree), else the
// parent's; each with its source; overrides and "Back to inherited"; the same codes in a new version resolve the same.
import { describe, expect, it } from 'vitest';
import { resolveTree, unionScopes, type MappedNode, type Own, type Resolved, type TreeNode } from './resolve.js';

const own = (o: Partial<Own> = {}): Own => ({ scope: null, champions: [], ...o });
const tree = (pairs: [string, string | null][]): TreeNode[] => pairs.map(([code, parentCode]) => ({ code, parentCode }));
const owns = (o: Record<string, Own>) => new Map(Object.entries(o));
const champ = (r: Resolved, key: string | null = null) => r.champions.find((c) => c.itemKey === key);

// A standard 4 with 4.1 and 4.2 (4.2 has an item 4.2.1).
const IQF = tree([['4', null], ['4.1', '4'], ['4.2', '4'], ['4.2.1', '4.2'], ['5', null]]);

describe('inheritance inside one standard', () => {
  it('takes the scope and champion of the nearest ancestor that has one, and says where from', () => {
    const r = resolveTree(IQF, owns({
      '4': own({ scope: { levelKey: 'program', itemIds: [] }, champions: [{ itemKey: null, userId: 'ann' }] }),
      '4.2': own({ scope: { levelKey: 'unit', itemIds: ['u1'] } }),
    }));
    expect(r.get('4')!.effective.scope).toEqual({ levels: [{ levelKey: 'program', itemIds: [] }], sources: [{ kind: 'own', code: null }] });
    // 4.1 has nothing: it takes 4's. 4.2 has its own scope but takes 4's champion. 4.2.1 takes 4.2's scope (nearest) and 4's champion.
    expect(r.get('4.1')!.effective.scope).toMatchObject({ levels: [{ levelKey: 'program' }], sources: [{ kind: 'parent', code: '4' }] });
    expect(r.get('4.2')!.effective.scope).toMatchObject({ levels: [{ levelKey: 'unit', itemIds: ['u1'] }], sources: [{ kind: 'own' }] });
    expect(r.get('4.2')!.effective.champions).toEqual([{ itemKey: null, userId: 'ann', needsOne: false, sources: [{ kind: 'parent', code: '4' }] }]);
    expect(r.get('4.2.1')!.effective.scope).toMatchObject({ levels: [{ levelKey: 'unit' }], sources: [{ kind: 'parent', code: '4.2' }] });
    expect(champ(r.get('4.2.1')!.effective)).toMatchObject({ userId: 'ann', sources: [{ kind: 'parent', code: '4.2' }] });
  });

  it('has nothing where nothing is set above (a sibling standard is not an ancestor)', () => {
    const r = resolveTree(IQF, owns({ '4': own({ scope: { levelKey: 'program', itemIds: [] } }) }));
    expect(r.get('5')!.effective).toEqual({ scope: null, champions: [] });
  });

  it('lets a node override the champion for itself and below, and "Back to inherited" shows what it would take instead', () => {
    const r = resolveTree(IQF, owns({
      '4': own({ champions: [{ itemKey: null, userId: 'ann' }] }),
      '4.2': own({ champions: [{ itemKey: null, userId: 'bob' }] }),
    }));
    expect(champ(r.get('4.2')!.effective)).toMatchObject({ userId: 'bob', sources: [{ kind: 'own' }] });
    expect(champ(r.get('4.2')!.inherited)).toMatchObject({ userId: 'ann', sources: [{ kind: 'parent', code: '4' }] });
    expect(champ(r.get('4.2.1')!.effective)).toMatchObject({ userId: 'bob', sources: [{ kind: 'parent', code: '4.2' }] });
    // Without an override the two views are the same.
    expect(r.get('4.1')!.inherited).toEqual(r.get('4.1')!.effective);
  });

  it('resolves per scoped item: a unit\'s own champion beats the overall one only for that unit', () => {
    const r = resolveTree(IQF, owns({
      '4': own({ champions: [{ itemKey: null, userId: 'ann' }, { itemKey: 'program:p1', userId: 'cy' }] }),
      '4.1': own({ champions: [{ itemKey: 'program:p1', userId: 'dee' }] }),
    }));
    const c41 = r.get('4.1')!.effective;
    expect(champ(c41)).toMatchObject({ userId: 'ann', sources: [{ kind: 'parent', code: '4' }] });
    expect(champ(c41, 'program:p1')).toMatchObject({ userId: 'dee', sources: [{ kind: 'own' }] });
    expect(champ(r.get('4.2')!.effective, 'program:p1')).toMatchObject({ userId: 'cy', sources: [{ kind: 'parent', code: '4' }] });
    expect(r.get('4.1')!.effective.champions.map((c) => c.itemKey)).toEqual([null, 'program:p1']);
  });

  it('ignores a value kept for a code this version does not have, and survives a changed tree (same codes, new shape)', () => {
    const own1 = owns({ '4': own({ scope: { levelKey: 'unit', itemIds: [] } }), '9.9': own({ scope: { levelKey: 'program', itemIds: [] } }) });
    const v1 = resolveTree(IQF, own1);
    expect([...v1.keys()]).not.toContain('9.9');
    // Version 2 moves 4.2.1 directly under 4 and adds 4.3: what is set on "4" still reaches them.
    const v2 = resolveTree(tree([['4', null], ['4.1', '4'], ['4.2', '4'], ['4.2.1', '4'], ['4.3', '4']]), own1);
    expect(v2.get('4.3')!.effective.scope).toMatchObject({ levels: [{ levelKey: 'unit' }], sources: [{ kind: 'parent', code: '4' }] });
    expect(v2.get('4.2.1')!.effective.scope).toMatchObject({ sources: [{ kind: 'parent', code: '4' }] });
  });
});

// ---- External requirements through approved mappings --------------------------------------------------------------------------

const EXT = tree([['A', null], ['A.1', 'A'], ['A.1.1', 'A.1'], ['B', null]]);
const iqf = (code: string, o: Own, nodes = IQF) => ({ code, effective: resolveTree(nodes, owns({ [code]: o })).get(code)!.effective } satisfies MappedNode);

describe('an external requirement mapped to IQF nodes', () => {
  it('takes the mapped node\'s scope and champion, labelled with the IQF code', () => {
    const m = iqf('4.2', own({ scope: { levelKey: 'program', itemIds: ['p1'] }, champions: [{ itemKey: null, userId: 'ann' }] }));
    const r = resolveTree(EXT, owns({}), new Map([['A.1', [m]]]));
    expect(r.get('A.1')!.effective.scope).toEqual({ levels: [{ levelKey: 'program', itemIds: ['p1'] }], sources: [{ kind: 'iqf', code: '4.2' }] });
    expect(champ(r.get('A.1')!.effective)).toEqual({ itemKey: null, userId: 'ann', needsOne: false, sources: [{ kind: 'iqf', code: '4.2' }] });
    // The child with no mapping takes its parent's (which came through the mapping); the sibling standard has nothing.
    expect(r.get('A.1.1')!.effective.scope).toMatchObject({ sources: [{ kind: 'parent', code: 'A.1' }] });
    expect(r.get('B')!.effective.scope).toBeNull();
  });

  it('unites the scopes of several mapped nodes: all beats a list, lists are merged, other levels are kept', () => {
    const a = iqf('4.1', own({ scope: { levelKey: 'program', itemIds: ['p1', 'p2'] } }));
    const b = iqf('4.2', own({ scope: { levelKey: 'program', itemIds: ['p2', 'p3'] } }));
    const c = iqf('5', own({ scope: { levelKey: 'unit', itemIds: [] } }));
    const r = resolveTree(EXT, owns({}), new Map([['A', [a, b, c]]]));
    expect(r.get('A')!.effective.scope).toEqual({
      levels: [{ levelKey: 'program', itemIds: ['p1', 'p2', 'p3'] }, { levelKey: 'unit', itemIds: [] }],
      sources: [{ kind: 'iqf', code: '4.1' }, { kind: 'iqf', code: '4.2' }, { kind: 'iqf', code: '5' }],
    });
    expect(unionScopes([{ levelKey: 'program', itemIds: ['p1'] }, { levelKey: 'program', itemIds: [] }])).toEqual([{ levelKey: 'program', itemIds: [] }]);
  });

  it('a mapped node with no scope adds nothing to the union', () => {
    const a = iqf('4.1', own({ scope: { levelKey: 'program', itemIds: ['p1'] } }));
    const none = iqf('5', own());
    const r = resolveTree(EXT, owns({}), new Map([['A', [a, none]]]));
    expect(r.get('A')!.effective.scope).toMatchObject({ levels: [{ levelKey: 'program', itemIds: ['p1'] }], sources: [{ kind: 'iqf', code: '4.1' }] });
  });

  it('takes a champion only when the mapped nodes agree; otherwise "needs one", never a guess', () => {
    const same1 = iqf('4.1', own({ champions: [{ itemKey: null, userId: 'ann' }] }));
    const same2 = iqf('4.2', own({ champions: [{ itemKey: null, userId: 'ann' }] }));
    const other = iqf('5', own({ champions: [{ itemKey: null, userId: 'bob' }] }));
    const lacking = iqf('4.2.1', own());
    const agree = resolveTree(EXT, owns({}), new Map([['A', [same1, same2]]])).get('A')!.effective;
    expect(champ(agree)).toEqual({ itemKey: null, userId: 'ann', needsOne: false, sources: [{ kind: 'iqf', code: '4.1' }, { kind: 'iqf', code: '4.2' }] });
    const differ = resolveTree(EXT, owns({}), new Map([['A', [same1, other]]])).get('A')!.effective;
    expect(champ(differ)).toMatchObject({ userId: null, needsOne: true });
    const partly = resolveTree(EXT, owns({}), new Map([['A', [same1, lacking]]])).get('A')!.effective;
    expect(champ(partly)).toMatchObject({ userId: null, needsOne: true });
    // A child below a "needs one" requirement still needs one, from its parent.
    const below = resolveTree(EXT, owns({}), new Map([['A', [same1, other]]])).get('A.1')!.effective;
    expect(champ(below)).toMatchObject({ userId: null, needsOne: true, sources: [{ kind: 'parent', code: 'A' }] });
    // Nobody has one: nothing to ask for.
    expect(resolveTree(EXT, owns({}), new Map([['A', [lacking]]])).get('A')!.effective.champions).toEqual([]);
  });

  it('an own value overrides the mapped one; removing it ("Back to inherited") gives the mapped one again', () => {
    const m = iqf('4.2', own({ scope: { levelKey: 'program', itemIds: ['p1'] }, champions: [{ itemKey: null, userId: 'ann' }] }));
    const mapped = new Map([['A.1', [m]]]);
    const withOwn = resolveTree(EXT, owns({ 'A.1': own({ scope: { levelKey: 'unit', itemIds: ['u9'] }, champions: [{ itemKey: null, userId: 'zed' }] }) }), mapped).get('A.1')!;
    expect(withOwn.effective.scope).toMatchObject({ levels: [{ levelKey: 'unit', itemIds: ['u9'] }], sources: [{ kind: 'own' }] });
    expect(champ(withOwn.effective)).toMatchObject({ userId: 'zed', sources: [{ kind: 'own' }] });
    expect(withOwn.inherited.scope).toMatchObject({ levels: [{ levelKey: 'program', itemIds: ['p1'] }], sources: [{ kind: 'iqf', code: '4.2' }] });
    expect(champ(withOwn.inherited)).toMatchObject({ userId: 'ann', sources: [{ kind: 'iqf', code: '4.2' }] });
    const removed = resolveTree(EXT, owns({}), mapped).get('A.1')!;
    expect(removed.effective).toEqual(withOwn.inherited);
  });

  it('the mapping beats the parent: a mapped child does not take its unmapped parent\'s value', () => {
    const m = iqf('4.2', own({ scope: { levelKey: 'program', itemIds: [] } }));
    const r = resolveTree(EXT, owns({ A: own({ scope: { levelKey: 'unit', itemIds: [] } }) }), new Map([['A.1', [m]]]));
    expect(r.get('A.1')!.effective.scope).toMatchObject({ levels: [{ levelKey: 'program' }], sources: [{ kind: 'iqf', code: '4.2' }] });
    expect(r.get('A.1.1')!.effective.scope).toMatchObject({ levels: [{ levelKey: 'program' }], sources: [{ kind: 'parent', code: 'A.1' }] });
  });

  it('carries over to a new version: the same codes resolve the same with the same mappings', () => {
    const m = iqf('4.2', own({ champions: [{ itemKey: null, userId: 'ann' }] }));
    const o = owns({ A: own({ scope: { levelKey: 'program', itemIds: [] } }) });
    const v1 = resolveTree(EXT, o, new Map([['A.1', [m]]]));
    const v2 = resolveTree([...EXT, ...tree([['A.2', 'A']])], o, new Map([['A.1', [m]]]));
    expect(v2.get('A.1')).toEqual(v1.get('A.1'));
    expect(v2.get('A.2')!.effective.scope).toMatchObject({ sources: [{ kind: 'parent', code: 'A' }] });
  });
});
