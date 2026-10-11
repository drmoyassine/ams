// The shortlist recall measure over a hand-labelled mapping set (DEC-023: "Step E is measured against a small hand-labelled
// mapping set before embeddings are on by default"). Pure: no database, no network, and no standard is named here; the set
// itself (which demo requirements map to which items of the starting template) is data in packages/core/eval.
import { INTERNAL_TEMPLATE } from '../internal-template.js';
import { LexicalIndex, shortlistRecall, type RankItem, type RecallResult } from './shortlist.js';

/** The starting template as ranking candidates: id = code, with the area's title as the path of a sub-standard. */
export function iqfEvalCandidates(): RankItem[] {
  return INTERNAL_TEMPLATE.flatMap((area, i) => [
    { id: String(i + 1), code: String(i + 1), title: area.title, text: '' },
    ...area.children.map((title, j) => ({ id: `${i + 1}.${j + 1}`, code: `${i + 1}.${j + 1}`, title, text: '', path: [area.title] })),
  ]);
}

export interface EvalRequirement { code: string; title: string; official_text?: string | null }
/** One standard's requirements, and the labels: requirement code -> codes of the items that answer it. */
export interface EvalSet { id: string; requirements: EvalRequirement[]; labels: Record<string, string[]> }

export interface EvalReport {
  k: number;
  overall: RecallResult;
  bySet: Record<string, RecallResult>;
}

const queryText = (r: EvalRequirement) => (r.official_text ?? '').slice(0, 1200);

/**
 * Shortlist recall at k. `rankFor` returns the shortlist (best first, as candidate ids) for one labelled requirement given
 * the lexical ranking; the default is the lexical ranking alone. A hybrid ranking is measured by passing a `rankFor` that
 * fuses the lexical list with its own.
 */
export function evaluateMapping(
  sets: readonly EvalSet[], k = 10,
  rankFor?: (set: EvalSet, requirement: EvalRequirement, lexical: readonly string[]) => readonly string[],
  candidates: readonly RankItem[] = iqfEvalCandidates(),
): EvalReport {
  const index = new LexicalIndex(candidates);
  const all = new Map<string, Set<string>>();
  const bySet: Record<string, RecallResult> = {};
  const rankings = new Map<string, readonly string[]>();
  for (const set of sets) {
    const labels = new Map<string, Set<string>>();
    for (const r of set.requirements) {
      const wanted = set.labels[r.code];
      if (!wanted) continue;
      const key = `${set.id}\u0000${r.code}`;
      const lexical = index.rank({ title: r.title, text: queryText(r) }).map((x) => x.id);
      rankings.set(key, rankFor ? rankFor(set, r, lexical) : lexical);
      labels.set(key, new Set(wanted));
      all.set(key, new Set(wanted));
    }
    bySet[set.id] = shortlistRecall(labels, (id) => rankings.get(id) ?? [], k);
  }
  return { k, overall: shortlistRecall(all, (id) => rankings.get(id) ?? [], k), bySet };
}
