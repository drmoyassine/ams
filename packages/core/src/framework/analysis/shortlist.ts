// Candidate shortlists for the IQF mapping (step E, DEC-023). Pure: no database, no AI.
//
// A shortlist is a ranking of the IQF's items against one external requirement. The ranking only chooses which few
// candidates the model is asked about; it never decides a relation and its numbers are never shown to people. Two
// rankings are fused: words (this file: normalised token overlap weighted by rarity, plus how much of an item's title
// is found in the requirement, plus explicit references to an item's code) and meaning (vector similarity, supplied by
// the caller when embeddings are on). Fusion is by rank only (reciprocal rank fusion), so the scales never mix.
//
// Arabic is normalised as in quote matching (framework/quote-match.ts), on the AMS side only; the stored text is never
// changed. The lexical scorer stands in for pg_trgm / tsvector so that it needs no database extension (DEC-008) and
// treats Arabic and English the same way.
import { normalizeQuoteText } from '../quote-match.js';

export interface RankItem {
  id: string;
  code: string;
  title: string;
  /** Description / official wording; may be empty. */
  text: string;
  /** Titles of the ancestors, top first (candidates only): the area an item belongs to helps to find it. */
  path?: string[];
}

const STOP = new Set((
  // English function words, and words that open nearly every requirement.
  'a an and are as at be been being by can do does for from has have if in into is it its may must not of on or shall should so such that the their them then there these they this those to under was were will with within without would '
  + 'ensure ensures provide provides provided including include includes appropriate sufficient adequate institution institutions program programs programme programmes '
  // Arabic function words, as the normaliser writes them.
  + 'في من علي الي عن مع ان او التي الذي الذين هذا هذه ذلك تلك كل بين ما لا قد يتم تكون يكون لدي هو هي علي كما ايضا حيث عند وفق وفقا خلال'
).split(/\s+/));

const ENGLISH_SUFFIXES = ['ions', 'ion', 'ments', 'ment', 'ings', 'ing', 'ness', 'ities', 'ity', 'ally', 'ly', 'ated', 'ates', 'ate', 'ed', 'es', 's', 'e'];

function stem(word: string): string {
  if (/^[؀-ۿ]/.test(word)) {
    // Arabic: drop the definite article (and a conjunction or preposition before it).
    const m = /^(?:وال|بال|كال|فال|لل|ال)(.{3,})$/u.exec(word);
    return m ? m[1]! : word;
  }
  if (word.length < 5) return word;
  if (word.endsWith('ies') && word.length > 5) return `${word.slice(0, -3)}y`;
  for (const suffix of ENGLISH_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  return word;
}

/** Normalised, stemmed words of a text, without function words and bare numbers. */
export function tokenize(text: string): string[] {
  return normalizeQuoteText(text).split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !STOP.has(w))
    .map(stem);
}

/** Character trigrams of every word (padded), as a set. */
function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeQuoteText(text).split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3 && !STOP.has(x))) {
    const padded = `  ${w} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `text` refer to this code as a word of its own ("see 4.2", "Q1.1")? Plain digits alone are too common to count. */
export function mentionsCode(text: string, code: string): boolean {
  const c = normalizeQuoteText(code);
  if (c.length < 3 || !/[.-]|[a-z]\d|\d[a-z]/.test(c)) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}.])${escapeRe(c)}(?![\\p{L}\\p{N}]|\\.\\d)`, 'u').test(normalizeQuoteText(text));
}

interface Doc { item: RankItem; tf: Map<string, number>; len: number; titleTrigrams: Set<string> }

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 2;
/** How much of a candidate's title found in the requirement is worth, against the word score. */
const TITLE_TRIGRAM_WEIGHT = 3;
const CODE_MENTION_BOOST = 8;

/** A word index over the candidates (the IQF's items). Build once per run, rank per requirement. */
export class LexicalIndex {
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(candidates: readonly RankItem[]) {
    this.docs = candidates.map((item) => {
      const tf = new Map<string, number>();
      const add = (tokens: string[], weight: number) => { for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight); };
      add(tokenize(item.title), TITLE_WEIGHT);
      add(tokenize(item.text), 1);
      add(tokenize((item.path ?? []).join(' ')), 0.5);
      let len = 0;
      for (const n of tf.values()) len += n;
      return { item, tf, len, titleTrigrams: trigrams(item.title) };
    });
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docs.length ? this.docs.reduce((n, d) => n + d.len, 0) / this.docs.length : 0;
  }

  /** Candidates with a score above zero, best first (ties by code, so the order is stable). */
  rank(query: Pick<RankItem, 'title' | 'text'>, k = Infinity): { id: string; score: number }[] {
    const qText = `${query.title} ${query.text}`;
    const qTokens = [...new Set(tokenize(qText))];
    const qTrigrams = trigrams(qText);
    const n = this.docs.length;
    const out: { id: string; score: number; code: string }[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of qTokens) {
        const tf = d.tf.get(t);
        if (!tf) continue;
        const idf = Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (d.len / (this.avgLen || 1)))));
      }
      if (d.titleTrigrams.size && score > 0) {
        let found = 0;
        for (const g of d.titleTrigrams) if (qTrigrams.has(g)) found++;
        score += TITLE_TRIGRAM_WEIGHT * (found / d.titleTrigrams.size);
      }
      if (mentionsCode(qText, d.item.code)) score += CODE_MENTION_BOOST;
      if (score > 0) out.push({ id: d.item.id, score, code: d.item.code });
    }
    out.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code, 'en', { numeric: true }) || a.id.localeCompare(b.id));
    return out.slice(0, k).map(({ id, score }) => ({ id, score }));
  }
}

const RRF_K = 60;

/** Reciprocal rank fusion of several best-first lists of ids. Only ranks count. */
export function fuseRankings(lists: readonly (readonly string[])[], k: number): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, k).map(([id]) => id);
}

/** How many candidates each ranking contributes before fusion. */
export const RANK_DEPTH = 20;
/** Candidates the model is asked about, per requirement. */
export const SHORTLIST_SIZE = 8;
/** Below this many candidates a shortlist is padded with the IQF's top-level items, so the model can still say where it belongs. */
export const MIN_SHORTLIST = 4;

export interface Shortlist {
  ids: string[];
  /** Candidates that came from the pad, not from a ranking. */
  padded: number;
  /** How many came from each ranking (a candidate in both counts in both). */
  fromWords: number;
  fromMeaning: number;
}

/**
 * The shortlist for one requirement: fused words and meaning rankings (`byMeaning` is best first and empty when
 * embeddings are off), padded with `fallback` (the IQF's top-level items) when fewer than MIN_SHORTLIST were found.
 */
export function buildShortlist(byWords: readonly string[], byMeaning: readonly string[], fallback: readonly string[], size = SHORTLIST_SIZE): Shortlist {
  const ids = fuseRankings([byWords.slice(0, RANK_DEPTH), byMeaning.slice(0, RANK_DEPTH)], size);
  const have = new Set(ids);
  let padded = 0;
  for (const id of fallback) {
    if (ids.length >= Math.min(size, MIN_SHORTLIST)) break;
    if (!have.has(id)) { ids.push(id); have.add(id); padded++; }
  }
  const words = new Set(byWords.slice(0, RANK_DEPTH));
  const meaning = new Set(byMeaning.slice(0, RANK_DEPTH));
  return { ids, padded, fromWords: ids.filter((i) => words.has(i)).length, fromMeaning: ids.filter((i) => meaning.has(i)).length };
}

// ---- Measuring a shortlist --------------------------------------------------------------------------------------

export interface RecallResult {
  k: number;
  /** Requirements with at least one labelled item. */
  queries: number;
  /** Labelled (requirement, item) pairs, and how many of them are in the first k of the ranking. */
  pairs: number;
  hits: number;
  /** hits / pairs: the share of labelled pairs the shortlist contains. */
  recall: number;
  /** Requirements whose shortlist holds at least one labelled item. */
  queriesWithHit: number;
}

/**
 * Shortlist recall at k over a hand-labelled set (DEC-023): `labels` maps a requirement to the items a person says answer
 * it; `rank` returns the shortlist for a requirement, best first. Pure, so a test can run it on any ranking.
 */
export function shortlistRecall(labels: ReadonlyMap<string, ReadonlySet<string>>, rank: (queryId: string) => readonly string[], k = 10): RecallResult {
  let pairs = 0;
  let hits = 0;
  let queries = 0;
  let queriesWithHit = 0;
  for (const [queryId, wanted] of labels) {
    if (wanted.size === 0) continue;
    queries++;
    const top = new Set(rank(queryId).slice(0, k));
    const found = [...wanted].filter((id) => top.has(id)).length;
    pairs += wanted.size;
    hits += found;
    if (found > 0) queriesWithHit++;
  }
  return { k, queries, pairs, hits, recall: pairs ? Math.round((hits / pairs) * 1000) / 1000 : 0, queriesWithHit };
}
