// The shortlist ranking and its measure (DEC-023): pure tests, no database and no network. The fake embedder's vectors are not
// semantic, so only the lexical path and the plumbing are covered here; the hybrid number needs a real endpoint
// (`pnpm analysis:eval-mapping` with the EMBED_* variables).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateMapping, iqfEvalCandidates, type EvalSet } from './mapping-eval.js';
import { buildShortlist, fuseRankings, LexicalIndex, mentionsCode, shortlistRecall, tokenize } from './shortlist.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../db/fixtures');
const LABELS = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../eval/mapping-labels.json'), 'utf8')) as { sets: Record<string, Record<string, string[]>> };
const load = (): EvalSet[] => Object.entries(LABELS.sets).map(([id, labels]) => ({
  id, labels, requirements: (JSON.parse(readFileSync(resolve(FIXTURES, `${id}.json`), 'utf8')) as { requirements: EvalSet['requirements'] }).requirements,
}));

describe('tokenize', () => {
  it('lowers, stems, and drops function words and bare numbers', () => {
    expect(tokenize('The Assessment of student learning, in 2024')).toEqual(['assess', 'student', 'learn']);
    expect(tokenize('Programs are assessed; evaluating and evaluation')).toEqual(['assess', 'evaluat', 'evaluat']);
  });
  it('folds Arabic forms and drops the article, so differently written forms meet', () => {
    expect(tokenize('الرِّسَالَةُ والأهداف')).toEqual(tokenize('رساله اهداف'));
    expect(tokenize('المؤسسة')).toEqual(tokenize('موسسه'));
  });
});

describe('LexicalIndex', () => {
  const items = [
    { id: 'a', code: '1.1', title: 'Mission, vision and values', text: '' },
    { id: 'b', code: '2.1', title: 'Assessment of learning', text: 'How student learning is assessed' },
    { id: 'c', code: '3.1', title: 'Facilities and technology', text: '' },
  ];
  const index = new LexicalIndex(items);
  it('ranks by shared, rare words and returns nothing for an unrelated text', () => {
    expect(index.rank({ title: '', text: 'The mission and values of the institution are published' })[0]!.id).toBe('a');
    expect(index.rank({ title: '', text: 'Student learning outcomes are assessed' })[0]!.id).toBe('b');
    expect(index.rank({ title: '', text: 'Zzz qqq' })).toEqual([]);
  });
  it('lets an explicit reference to an item\'s code win', () => {
    expect(index.rank({ title: '', text: 'See item 3.1 for the laboratories and learning' })[0]!.id).toBe('c');
    expect(mentionsCode('see 3.1 above', '3.1')).toBe(true);
    expect(mentionsCode('see 13.15 above', '3.1')).toBe(false);
    expect(mentionsCode('item 3.1.2 applies', '3.1')).toBe(false);
    expect(mentionsCode('chapter 4 and 5', '4')).toBe(false);
  });
});

describe('fusion and shortlist', () => {
  it('fuses by rank only: an item both rankings like beats one only a single ranking likes', () => {
    expect(fuseRankings([['x', 'y', 'z'], ['y', 'q', 'x']], 3)).toEqual(['y', 'x', 'q']);
  });
  it('pads a short shortlist with the fallback and counts the pad', () => {
    const s = buildShortlist(['a'], [], ['t1', 't2', 't3', 't4', 't5'], 8);
    expect(s.ids).toEqual(['a', 't1', 't2', 't3']);
    expect(s).toMatchObject({ padded: 3, fromWords: 1, fromMeaning: 0 });
    expect(buildShortlist(['a', 'b', 'c', 'd'], ['e'], ['t1'], 8).padded).toBe(0);
  });
  it('is limited to its size', () => {
    const many = Array.from({ length: 30 }, (_, i) => `w${i}`);
    expect(buildShortlist(many, many.slice().reverse(), [], 8).ids).toHaveLength(8);
  });
});

describe('shortlist recall', () => {
  it('counts labelled pairs found in the first k', () => {
    const labels = new Map([['q1', new Set(['a', 'b'])], ['q2', new Set(['c'])], ['q3', new Set<string>()]]);
    const rank = (q: string) => (q === 'q1' ? ['a', 'x', 'y'] : ['x', 'y', 'z']);
    expect(shortlistRecall(labels, rank, 2)).toEqual({ k: 2, queries: 2, pairs: 3, hits: 1, recall: 0.333, queriesWithHit: 1 });
    expect(shortlistRecall(labels, rank, 3).hits).toBe(1);
  });
});

describe('the hand-labelled set', () => {
  it('names only requirements and template items that exist', () => {
    const candidates = new Set(iqfEvalCandidates().map((c) => c.id));
    const sets = load();
    expect(sets).toHaveLength(3);
    for (const { id, requirements, labels } of sets) {
      const codes = new Set(requirements.map((r) => r.code));
      for (const [code, items] of Object.entries(labels)) {
        expect(codes.has(code), `${id} ${code}`).toBe(true);
        for (const i of items) expect(candidates.has(i), `${id} ${code} -> ${i}`).toBe(true);
      }
    }
  });

  it('measures lexical shortlist recall at 10 (English standards: the words are shared; Arabic: they are not)', () => {
    const report = evaluateMapping(load(), 10);
    const by = Object.fromEntries(Object.entries(report.bySet).map(([k, v]) => [k, v.recall]));
    console.info(`[mapping eval] lexical recall@10: ${JSON.stringify({ overall: report.overall.recall, ...by })}`);
    // The measured numbers, kept as a floor so a change to the scorer that makes shortlists worse fails here.
    expect(report.overall.pairs).toBeGreaterThan(60);
    expect(report.overall.recall).toBeGreaterThanOrEqual(0.45);
    const english = Object.entries(by).filter(([k]) => k !== 'puc-2019').map(([, v]) => v);
    for (const r of english) expect(r).toBeGreaterThanOrEqual(0.6);
    // Cross-language: nothing to match on without embeddings.
    expect(by['puc-2019']).toBeLessThan(0.3);
  });

  it('accepts another ranking (the hybrid path), measured the same way', () => {
    const perfect = evaluateMapping(load(), 10, (set, r) => set.labels[r.code]!);
    expect(perfect.overall.recall).toBe(1);
    const none = evaluateMapping(load(), 10, () => []);
    expect(none.overall.recall).toBe(0);
  });
});
