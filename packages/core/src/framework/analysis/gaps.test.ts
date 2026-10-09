// The gap finder and the recovery bookkeeping (step D): pure, no database, no AI.
import { describe, expect, it } from 'vitest';
import type { AnalysisGap } from '@ams/shared';
import { findGaps, findNumberingGaps, numberingHints, pageRange, parseCode, substantivePage, type FoundGap } from './gaps.js';
import { mergeExtracted, type DocInfo, type RawItem } from './merge.js';
import { gapCounts, MAX_QUESTIONS_PER_TASK, planTasks, questionFor, reconcileGaps } from './recovery.js';
import type { ExtractItem } from './schemas.js';

/** Codes as siblings, each on its own page (so every hole can be asked about). */
const sib = (codes: string[]) => codes.map((code, i) => ({ code, parsed: parseCode(code)!, documentId: 'd', page: i + 1, seq: i }));
const missing = (codes: string[], hints?: { examples: string[] }[]) => findNumberingGaps(sib(codes), numberingHints(hints)).map((g) => g.code);

describe('codes', () => {
  it('splits a code into prefix words and numbering parts, whatever the separators', () => {
    expect(parseCode('CFR 2.4')).toMatchObject({ prefix: 'cfr', parts: [{ raw: '2', num: 2 }, { raw: '4', num: 4 }] });
    expect(parseCode('2.4(a)')!.parts.map((p) => p.raw)).toEqual(['2', '4', 'a']);
    expect(parseCode('Standard IV')).toMatchObject({ prefix: 'standard', parts: [{ raw: 'IV', kinds: ['roman'], roman: 4 }] });
    expect(parseCode('٢٫٣')!.parts.map((p) => [p.num, p.script])).toEqual([[2, 'arabic'], [3, 'arabic']]);
    // "i" may be a letter or a roman numeral; "b" only a letter.
    expect(parseCode('1.i')!.parts[1]!.kinds).toEqual(['letter', 'roman']);
    expect(parseCode('1.b')!.parts[1]!.kinds).toEqual(['letter']);
    // Words after the numbering: not a pattern to follow.
    expect(parseCode('2.4 bis')).toBeNull();
    expect(parseCode('Introduction')).toBeNull();
  });
});

describe('numbering gaps', () => {
  it('finds a hole among numbered siblings, and leaves deliberate jumps alone', () => {
    expect(missing(['2.1', '2.2', '2.4'])).toEqual(['2.3']);
    expect(missing(['1.1', '1.2', '1.9'])).toEqual([]); // six missing in a row: a jump, not a gap
    expect(missing(['1', '2', '5'])).toEqual(['3', '4']);
    // Different parents and prefixes are different sibling groups.
    expect(missing(['2.1', '2.3', '3.1', '3.3', 'CFR 2.1', 'CFR 2.3'])).toEqual(['2.2', '3.2', 'CFR 2.2']);
  });

  it('finds the codes missing before the first sibling', () => {
    expect(missing(['4.2', '4.3'])).toEqual(['4.1']);
    // A lone sibling is not a series: a document may cover only Standard 2.
    expect(missing(['2', '2.1'])).toEqual([]);
  });

  it('handles lettered parts, with any separators, keeping the neighbour\'s style', () => {
    expect(missing(['2.4(a)', '2.4(b)', '2.4(d)'])).toEqual(['2.4(c)']);
    expect(missing(['3-1', '3.2', '3/4'])).toEqual(['3.3']);
    expect(missing(['A', 'B', 'D'])).toEqual(['C']);
    // "c" alone could be roman 100, but its siblings are letters.
    expect(missing(['1.a', '1.b', '1.c', '1.e'])).toEqual(['1.d']);
  });

  it('handles roman numerals, using the structure stage\'s examples to read "i" and "v"', () => {
    expect(missing(['Standard I', 'Standard II', 'Standard IV'])).toEqual(['Standard III']);
    expect(missing(['1.i', '1.ii', '1.iv'])).toEqual(['1.iii']);
    // Only "i" and "v": letters by default (too far apart to be a gap), roman when the examples say so.
    expect(missing(['2.i', '2.v'])).toEqual([]);
    expect(missing(['2.i', '2.v'], [{ examples: ['2.ii', '2.iii'] }])).toEqual(['2.ii', '2.iii', '2.iv']);
  });

  it('handles Arabic-Indic and Persian digits, writing the missing code in the same digits', () => {
    expect(missing(['٢٫١', '٢٫٢', '٢٫٤'])).toEqual(['٢٫٣']);
    expect(missing(['۳.۱', '۳.۳'])).toEqual(['۳.۲']);
    expect(missing(['المعيار ١', 'المعيار ٣'])).toEqual(['المعيار ٢']);
  });

  it('keeps zero-padding', () => {
    expect(missing(['01', '02', '04'])).toEqual(['03']);
  });
});

describe('pages', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  it('counts a page as substantive only with enough words, and never a contents or index page', () => {
    expect(substantivePage(`The institution must ${words(50)}`).substantive).toBe(true);
    expect(substantivePage('This page intentionally left blank.')).toEqual({ substantive: false, why: 'only 5 words' });
    const toc = ['Contents', ...Array.from({ length: 12 }, (_, i) => `Standard ${i + 1} ${words(4)} .... ${i + 3}`)].join('\n');
    expect(substantivePage(toc)).toMatchObject({ substantive: false, why: expect.stringMatching(/contents or index/) });
    const index = ['Index', ...Array.from({ length: 12 }, (_, i) => `term${i} ${words(3)} 12, 14, ${i + 20}`)].join('\n');
    expect(substantivePage(index).substantive).toBe(false);
  });

  it('limits the pages a question shows', () => {
    const pages = new Map(Array.from({ length: 30 }, (_, i) => [i + 1, 'x'] as const));
    expect(pageRange(pages, 4, 6)).toEqual([4, 5, 6]);
    expect(pageRange(pages, 0, 2)).toEqual([1, 2]);
    expect(pageRange(pages, 3, 25, 20)).toHaveLength(6);
    expect(pageRange(pages, 3, 25, 20)).toContain(20);
  });
});

// ---- The finder over a merged result -------------------------------------------------------------------------------

const PAGE_TEXT = (n: number) => `Page ${n} text. ` + Array.from({ length: 50 }, (_, i) => `term${n}x${i}`).join(' ');
let seq = 0;
function raw(documentId: string, window: number, o: Partial<ExtractItem> & { text: string; page: number; quote?: string }): RawItem {
  const { page, quote, ...rest } = o;
  const item: ExtractItem = {
    kind: 'requirement', temp_id: `t${seq}`, parent_temp_id: null, code: null, parent_code: null, level_label: null, title: null, note_type: null, authority: null,
    is_assessable: true, confidence: 0.9, flags: [], ...rest, source: { page, quote: quote ?? o.text },
  };
  return { id: `i${seq}`, documentId, seq: seq++, window, item };
}
function run(items: RawItem[], pages: Map<string, Map<number, string>>, docs: Map<string, DocInfo>, knownCodes: string[] = []) {
  const merged = mergeExtracted(items, docs, pages, new Set(knownCodes));
  return findGaps({ merged, raw: items, pages, docs, knownCodes: new Set(knownCodes) });
}

describe('the gap finder', () => {
  const docs = new Map<string, DocInfo>([['std', { role: 'standards', language: 'en' }], ['std2', { role: 'standards', language: 'en' }], ['guide', { role: 'guidance', language: 'en' }]]);
  const pagesOf = (texts: Record<number, string>) => new Map(Object.entries(texts).map(([k, v]) => [Number(k), v]));

  it('finds numbering holes, missing parents, unverified quotes, low confidence and uncovered pages, keyed stably', () => {
    const p = pagesOf({
      1: 'Contents\n2.1 Curriculum .... 2\n2.2 Assessment .... 3\n2.4 Support .... 4\n9.1 Annex .... 5',
      2: '2.1 Curriculum\nEach programme has a curriculum with published learning outcomes.',
      3: '2.2 Assessment\nAssessment methods are aligned with the learning outcomes.',
      4: '2.4 Support\nThe institution provides advising.',
      5: '9.1.1 Annex rule\nThe annex rule is stated here in full.',
      6: PAGE_TEXT(6), // substantive, nothing cites it
      7: 'Glossary.', // short: not asked about
    });
    const pages = new Map([['std', p]]);
    const items = [
      raw('std', 0, { code: '2', text: 'Each programme has a curriculum', page: 2 }),
      raw('std', 0, { code: '2.1', parent_code: '2', text: 'Each programme has a curriculum with published learning outcomes.', page: 2 }),
      raw('std', 0, { code: '2.2', parent_code: '2', text: 'Assessment methods are aligned with the learning outcomes.', page: 3, confidence: 0.3 }),
      raw('std', 0, { code: '2.4', parent_code: '2', text: 'The institution provides advising.', page: 4, quote: 'The institution provides advising to all students every term.' }),
      raw('std', 0, { code: '9.1.1', parent_code: '9.1', text: 'The annex rule is stated here in full.', page: 5 }),
      raw('std', 0, { kind: 'note', parent_code: '7.7', text: 'A note about nothing known.', page: 5, quote: 'The annex rule is stated here in full.' }),
    ];
    const gaps = run(items, pages, docs);
    const view = gaps.map((g) => [g.key, g.kind, g.page, g.pages]);
    expect(view).toEqual([
      ['req:2.3', 'numbering_gap', 3, [3, 4]],
      ['req:9.1', 'missing_parent', 5, [3, 4, 5]],
      ['req:7.7', 'missing_parent', 5, [3, 4, 5]],
      ['req:2.2', 'low_confidence', 3, [2, 3, 4]],
      ['req:2.4', 'unverified_quote', 4, [3, 4, 5]],
      ['page:std:6', 'uncovered_page', 6, [5, 6, 7]],
    ]);
    expect(gaps[0]!.detail).toBe('between 2.2 and 2.4');
    expect(gaps[1]!.detail).toBe('named as the parent of 9.1.1');
    // Recovered items sort between their neighbours.
    expect(gaps[0]!.anchorSeq).toBeGreaterThan(items[2]!.seq);
    expect(gaps[0]!.anchorSeq).toBeLessThan(items[3]!.seq);
    expect(questionFor(gaps[0]!)).toMatch(/^Is there a requirement coded "2\.3" on these pages\? It would come between 2\.2 and 2\.4/);
    expect(questionFor(gaps[4]!)).toMatch(/^Re-cite the requirement coded "2\.4"/);
    expect(questionFor(gaps[5]!)).toMatch(/^Nothing was taken from page 6/);
  });

  it('does not ask about codes already known (in the draft, or deleted by a person)', () => {
    const pages = new Map([['std', pagesOf({ 1: '2.1 a b c', 2: '2.2 a b c', 3: '2.4 a b c' })]]);
    const items = [raw('std', 0, { code: '2.1', text: 'a b c', page: 1 }), raw('std', 0, { code: '2.2', text: 'a b c', page: 2 }), raw('std', 0, { code: '2.4', text: 'a b c', page: 3 })];
    expect(run(items, pages, docs).map((g) => g.key)).toEqual(['req:2.3']);
    expect(run(items, pages, docs, ['2.3'])).toEqual([]);
  });

  it('treats a page that only continues the item before it as covered, and only looks at standards documents', () => {
    const long = PAGE_TEXT(2);
    const pages = new Map([
      ['std', pagesOf({ 1: `1.1 Rule\nThe rule says ${long.slice(0, 200)}`, 2: long })],
      ['guide', pagesOf({ 1: PAGE_TEXT(9) })],
    ]);
    const items = [raw('std', 0, { code: '1.1', text: `The rule says ${long.slice(0, 200)}`, page: 1, quote: 'The rule says' })];
    expect(run(items, pages, docs)).toEqual([]);
  });

  it('flags the same code with materially different wording in two documents as a conflict, never a cut-short copy', () => {
    const pages = new Map([
      ['std', pagesOf({ 1: '3.1 Governance\nThe board approves the budget every year.', 2: '3.1 Governance\nThe board approves the budget' })],
      ['std2', pagesOf({ 1: '3.1 Governance\nStudents elect two members of the senate.' })],
    ]);
    const cut = [
      raw('std', 0, { code: '3.1', text: 'The board approves the budget', page: 1 }),
      raw('std', 1, { code: '3.1', text: 'The board approves the budget every year.', page: 1 }),
    ];
    expect(run(cut, pages, docs)).toEqual([]);
    const both = [...cut, raw('std2', 2, { code: '3.1', text: 'Students elect two members of the senate.', page: 1 })];
    const gaps = run(both, pages, docs);
    expect(gaps.map((g) => [g.key, g.kind, g.pages])).toEqual([['conflict:3.1', 'conflict', []]]);
    expect(gaps[0]!.detail).toBe('different wording in two documents (pages 1 and 1)');
  });
});

describe('recovery bookkeeping', () => {
  const found = (key: string, kind: FoundGap['kind'] = 'numbering_gap', pages = [1, 2]): FoundGap => ({ key, kind, code: key.slice(4), documentId: 'd', page: 1, detail: '', pages, anchorSeq: 0 });
  const gap = (key: string, status: AnalysisGap['status']): AnalysisGap => ({ key, kind: 'numbering_gap', status, code: key.slice(4), documentId: 'd', page: 1, round: 0, attempts: 1, detail: '', reason: null, requirementId: null });

  it('reconciles: gone means recovered, confirmed absent is never reopened, new ones are open, conflicts stay conflicts', () => {
    const prev = [gap('req:2.3', 'open'), gap('req:2.5', 'confirmed_absent'), gap('req:2.7', 'open')];
    const next = reconcileGaps(prev, [found('req:2.5'), found('req:2.7'), found('req:2.9'), found('conflict:1', 'conflict', [])], 1);
    expect(next.map((g) => [g.key, g.status, g.round])).toEqual([
      ['req:2.3', 'recovered', 1], ['req:2.5', 'confirmed_absent', 0], ['req:2.7', 'open', 0], ['req:2.9', 'open', 1], ['conflict:1', 'conflict', 1],
    ]);
    expect(gapCounts(next)).toEqual({ gapsRecovered: 1, gapsUnresolved: 2, gapsConfirmedAbsent: 1, conflicts: 1, uncoveredPages: 0 });
  });

  it('groups questions about the same pages into one call, and never asks about a conflict', () => {
    const tasks = planTasks([found('req:a'), found('req:b'), found('req:c', 'numbering_gap', [5]), found('conflict:x', 'conflict', [])]);
    expect(tasks.map((t) => [t.pages, t.questions.map((q) => [q.id, q.key])])).toEqual([
      [[1, 2], [['q1', 'req:a'], ['q2', 'req:b']]], [[5], [['q1', 'req:c']]],
    ]);
    const many = planTasks(Array.from({ length: MAX_QUESTIONS_PER_TASK + 1 }, (_, i) => found(`req:${i}`)));
    expect(many.map((t) => t.questions.length)).toEqual([MAX_QUESTIONS_PER_TASK, 1]);
  });
});
