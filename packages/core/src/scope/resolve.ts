// Effective scope and champion of a requirement (TASK-086, docs/quality-management-plan.md "Standards in operation"). Pure: no
// database, no accreditor identity (DEC-002); requirements are only codes in a tree.
//
//   - A requirement's own value wins ("Own").
//   - An external requirement mapped (approved mappings only) to institution-framework nodes takes theirs next: the scope is the
//     UNION of the mapped nodes' effective scopes; a champion is taken only when every mapped node has the same one, otherwise
//     the answer is "needs one" (nothing is guessed).
//   - Otherwise it takes its parent's effective value, within the same standard ("From Standard 4"); otherwise nothing.
// Every effective value carries its source. `inherited` is what a node would have without its own value ("Back to inherited").
// Scope and each champion (overall, or one per scoped item) resolve independently.

export type Source = { kind: 'own'; code: null } | { kind: 'parent'; code: string } | { kind: 'iqf'; code: string };

/** A level and the items of it; no items = every one at that level. */
export interface ScopeValue { levelKey: string; itemIds: string[] }
/** `itemKey` is "org_unit:<id>" or "program:<id>"; null is the overall champion. */
export interface ChampionValue { itemKey: string | null; userId: string }
export interface Own { scope: ScopeValue | null; champions: ChampionValue[] }
export interface TreeNode { code: string; parentCode: string | null }

export interface ResolvedScope { levels: ScopeValue[]; sources: Source[] }
export interface ResolvedChampion { itemKey: string | null; userId: string | null; needsOne: boolean; sources: Source[] }
export interface Resolved { scope: ResolvedScope | null; champions: ResolvedChampion[] }
export interface Both { effective: Resolved; inherited: Resolved }

/** An approved mapping's institution-framework node, already resolved within its own tree. */
export interface MappedNode { code: string; effective: Resolved }

const EMPTY: Resolved = { scope: null, champions: [] };
const own: Source = { kind: 'own', code: null };

/** Several scopes united: per level, everything when any of them is "all", otherwise the items of all of them. */
export function unionScopes(values: ScopeValue[]): ScopeValue[] {
  const byLevel = new Map<string, { all: boolean; ids: Set<string> }>();
  for (const v of values) {
    const cur = byLevel.get(v.levelKey) ?? { all: false, ids: new Set<string>() };
    if (v.itemIds.length === 0) cur.all = true;
    for (const id of v.itemIds) cur.ids.add(id);
    byLevel.set(v.levelKey, cur);
  }
  return [...byLevel].map(([levelKey, c]) => ({ levelKey, itemIds: c.all ? [] : [...c.ids] }));
}

const keyOrder = (a: ResolvedChampion, b: ResolvedChampion) => (a.itemKey === null ? -1 : b.itemKey === null ? 1 : a.itemKey.localeCompare(b.itemKey));

/** What mapped nodes give for one champion key: all the same person -> inherited; they differ or only some have one -> needs one; none -> nothing. */
function fromMapped(key: string | null, mapped: MappedNode[]): ResolvedChampion | null {
  const found = mapped.map((m) => ({ m, c: m.effective.champions.find((c) => c.itemKey === key) }));
  if (found.every((f) => !f.c || (!f.c.userId && !f.c.needsOne))) return null;
  const first = found[0]!.c;
  const agree = found.every((f) => f.c && !f.c.needsOne && f.c.userId && f.c.userId === first?.userId);
  const sources = mapped.map((m): Source => ({ kind: 'iqf', code: m.code }));
  return agree ? { itemKey: key, userId: first!.userId, needsOne: false, sources } : { itemKey: key, userId: null, needsOne: true, sources };
}

/**
 * Resolves every node of one version's tree. `ownByCode` holds what a person set (by code, so it carries over to the next
 * version unchanged); `mapped` (external standards only) holds each code's approved-mapping nodes, resolved in their own tree.
 * Codes in `ownByCode` that this tree does not have are ignored.
 */
export function resolveTree(nodes: readonly TreeNode[], ownByCode: ReadonlyMap<string, Own>, mapped: ReadonlyMap<string, MappedNode[]> = new Map()): Map<string, Both> {
  const parentOf = new Map(nodes.map((n) => [n.code, n.parentCode] as const));
  const memo = new Map<string, Resolved>();
  const visiting = new Set<string>();

  const compute = (code: string, withOwn: boolean): Resolved => {
    const o = withOwn ? ownByCode.get(code) : undefined;
    const via = mapped.get(code) ?? [];
    const parentCode = parentOf.get(code) ?? null;
    const parent = parentCode !== null && !visiting.has(parentCode) ? effective(parentCode) : EMPTY;

    // Scope: own, else the union of the mapped nodes that have one, else the parent's.
    let scope: ResolvedScope | null = null;
    if (o?.scope) scope = { levels: [o.scope], sources: [own] };
    else {
      const have = via.filter((m) => m.effective.scope);
      if (have.length) scope = { levels: unionScopes(have.flatMap((m) => m.effective.scope!.levels)), sources: have.map((m): Source => ({ kind: 'iqf', code: m.code })) };
      else if (parent.scope) scope = { levels: parent.scope.levels, sources: [{ kind: 'parent', code: parentCode! }] };
    }

    // Champions, key by key: own, else what the mapped nodes agree on (or "needs one"), else the parent's.
    const keys = new Set<string | null>([...(o?.champions ?? []).map((c) => c.itemKey), ...parent.champions.map((c) => c.itemKey), ...via.flatMap((m) => m.effective.champions.map((c) => c.itemKey))]);
    const champions: ResolvedChampion[] = [];
    for (const key of keys) {
      const mine = o?.champions.find((c) => c.itemKey === key);
      if (mine) { champions.push({ itemKey: key, userId: mine.userId, needsOne: false, sources: [own] }); continue; }
      const m = via.length ? fromMapped(key, via) : null;
      if (m) { champions.push(m); continue; }
      const p = parent.champions.find((c) => c.itemKey === key);
      if (p) champions.push({ itemKey: key, userId: p.userId, needsOne: p.needsOne, sources: [{ kind: 'parent', code: parentCode! }] });
    }
    return { scope, champions: champions.sort(keyOrder) };
  };

  const effective = (code: string): Resolved => {
    const hit = memo.get(code);
    if (hit) return hit;
    visiting.add(code);
    const r = compute(code, true);
    visiting.delete(code);
    memo.set(code, r);
    return r;
  };

  const out = new Map<string, Both>();
  for (const n of nodes) out.set(n.code, { effective: effective(n.code), inherited: ownByCode.has(n.code) ? compute(n.code, false) : effective(n.code) });
  return out;
}
