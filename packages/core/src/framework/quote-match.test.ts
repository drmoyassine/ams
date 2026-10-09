// The deterministic quote check of the framework analysis (DEC-006): pure, so tested without a database.
import { describe, expect, it } from 'vitest';
import { bestSubstringSimilarity, normalizeQuoteText, textInPages, verifyQuote } from './quote-match.js';
import { formatPages, mergeExtracted, pageWindows, type RawItem } from './analysis/merge.js';
import type { ExtractItem } from './analysis/schemas.js';

const pages = (...texts: string[]) => new Map(texts.map((t, i) => [i + 1, t]));

describe('normalizeQuoteText', () => {
  it('unifies Unicode form, whitespace, quotes, dashes, hyphenation and case', () => {
    expect(normalizeQuoteText('  The  Institution’s\n“mission” — re-\n viewed  ')).toBe('the institution\'s "mission" - reviewed');
    expect(normalizeQuoteText('é')).toBe('é'); // NFC
    expect(normalizeQuoteText('a​b‏c')).toBe('abc');
  });

  it('folds Arabic: diacritics, tatweel, alef, taa marbuta, alef maqsura, hamza seats, digits, punctuation', () => {
    expect(normalizeQuoteText('يَجِبُ')).toBe('يجب');
    expect(normalizeQuoteText('تنشـــرها')).toBe('تنشرها');
    expect(normalizeQuoteText('أإآٱا')).toBe('ااااا');
    expect(normalizeQuoteText('المؤسسة')).toBe(normalizeQuoteText('المؤسسه'));
    expect(normalizeQuoteText('على')).toBe('علي');
    expect(normalizeQuoteText('مسؤول')).toBe(normalizeQuoteText('مسوول'));
    expect(normalizeQuoteText('هيئة')).toBe(normalizeQuoteText('هييه'));
    expect(normalizeQuoteText('المعيار ٣، البند ۴؟')).toBe('المعيار 3, البند 4?');
  });
});

describe('bestSubstringSimilarity', () => {
  it('is 1 for an exact occurrence and measures edits against the best stretch otherwise', () => {
    expect(bestSubstringSimilarity('board minutes', 'provide the board minutes approving')).toBe(1);
    // One letter wrong in 20: 0.95.
    expect(bestSubstringSimilarity('the board minutes ok', 'xx the board minutes 0k xx')).toBeCloseTo(0.95, 5);
    expect(bestSubstringSimilarity('completely different', 'nothing alike here at all')).toBeLessThan(0.6);
    expect(bestSubstringSimilarity('', 'x')).toBe(0);
  });

  it('compares long texts by word sequences', () => {
    const long = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
    expect(bestSubstringSimilarity(long, `intro ${long} outro`)).toBe(1);
    expect(bestSubstringSimilarity(long, long.replace('word70', 'wurd70'))).toBeGreaterThan(0.95);
    expect(bestSubstringSimilarity(long, 'unrelated text')).toBe(0);
  });
});

describe('verifyQuote', () => {
  const doc = pages(
    'Standard 1\nThe institution defines its purposes.',
    'Criterion 1.1\nThe mission statement is published on the institution\'s website and reviewed every five years.',
    'Institutions must provide the board\nminutes approving the mission.',
  );

  it('finds the quote on the cited page, despite line breaks and OCR-sized differences', () => {
    expect(verifyQuote('published on the institution’s website', doc, 2)).toMatchObject({ verified: true, page: 2, score: 1 });
    expect(verifyQuote('The mission statemant is published on the institution\'s website', doc, 2)).toMatchObject({ verified: true, page: 2 });
  });

  it('falls back to the neighbouring pages and across a page break, and reports where it was found', () => {
    expect(verifyQuote('The institution defines its purposes.', doc, 2)).toMatchObject({ verified: true, page: 1 });
    expect(verifyQuote('reviewed every five years. Institutions must provide the board', doc, 2)).toMatchObject({ verified: true, page: 2 });
    expect(verifyQuote('The institution defines its purposes.', doc, 3)).toMatchObject({ verified: false, page: null });
  });

  it('does not verify an invented or paraphrased quote, or an empty one', () => {
    expect(verifyQuote('The institution must operate a research vessel.', doc, 2).verified).toBe(false);
    expect(verifyQuote('Every five years the mission is reviewed and published online.', doc, 2).verified).toBe(false);
    expect(verifyQuote('   ', doc, 2)).toEqual({ verified: false, page: null, score: 0 });
  });

  it('verifies Arabic quotes written with other letter forms and without diacritics or tatweel', () => {
    const ar = pages('إرشادات\nيَجِبُ عَلَى المؤسسة أنْ تُراجِعَ رسالتها كلَّ خمس سنوات وأن تنشـــرها على موقعها الإلكتروني.');
    expect(verifyQuote('يجب علي المؤسسه ان تراجع رسالتها كل خمس سنوات وان تنشرها', ar, 1)).toMatchObject({ verified: true, page: 1 });
    expect(verifyQuote('يجب على الجامعة أن تنشر تقريرها السنوي', ar, 1).verified).toBe(false);
  });
});

describe('textInPages', () => {
  it('requires a requirement\'s whole wording in the cited page and the pages around it', () => {
    const doc = pages('One.', 'The institution has a policy on academic', 'freedom that is reviewed annually.');
    expect(textInPages('The institution has a policy on academic freedom that is reviewed annually.', doc, 2)).toBe(true);
    expect(textInPages('The institution has a policy on research ethics that is approved by the senate.', doc, 2)).toBe(false);
  });
});

const raw = (id: string, seq: number, item: Partial<ExtractItem> & Pick<ExtractItem, 'kind' | 'text' | 'source'>, documentId = 'd1', window = 0): RawItem =>
  ({ id, documentId, seq, window, item: { temp_id: id, flags: [], ...item } as ExtractItem });

describe('mergeExtracted', () => {
  const docs = new Map([['d1', { role: 'standards', language: 'en' }], ['g', { role: 'guidance', language: 'ar' }]]);
  const text = new Map([['d1', pages('1 Mission. The institution has a mission.', '1.1 It is published. 1.1.1 Reviewed yearly.')], ['g', pages('Guidance on 1.1: publish it widely.')]]);

  it('merges a requirement seen in two windows by code, keeping the most complete text, and resolves parents by code or temp id', () => {
    const r = mergeExtracted([
      raw('a', 0, { kind: 'requirement', code: '1', text: 'The institution has a mission.', source: { page: 1, quote: 'The institution has a mission.' } }),
      raw('b', 1, { kind: 'requirement', code: '1.1', parent_code: '1', text: 'It is', flags: ['possible_omission'], source: { page: 2, quote: 'It is published.' } }),
      raw('c', 10_000, { kind: 'requirement', code: '1.1', parent_code: '1', text: 'It is published.', source: { page: 2, quote: 'It is published.' } }, 'd1', 1),
      raw('d', 10_001, { kind: 'requirement', code: '1.1.1', parent_temp_id: 'c', text: 'Reviewed yearly.', source: { page: 2, quote: 'Reviewed yearly.' } }, 'd1', 1),
    ], docs, text, new Set());
    expect(r.duplicatesMerged).toBe(1);
    expect(r.requirements.map((x) => [x.code, x.parentCode, x.depth, x.text])).toEqual([
      ['1', null, 0, 'The institution has a mission.'], ['1.1', '1', 1, 'It is published.'], ['1.1.1', '1.1', 2, 'Reviewed yearly.'],
    ]);
    expect(r.requirements[1]!.flags).not.toContain('possible_omission');
    expect(r.requirements[1]!.from).toEqual(['b', 'c']);
    expect(r.requirements[1]!.seq).toBe(1);
  });

  it('flags orphans, keeps requirements out of guidance documents, and makes an unverified "required" note an AI suggestion', () => {
    const r = mergeExtracted([
      raw('a', 0, { kind: 'requirement', code: '7.1', parent_code: '7', text: 'Orphan.', source: { page: 1, quote: 'The institution has a mission.' } }),
      raw('b', 1, { kind: 'requirement', code: '9', text: 'From guidance.', source: { page: 1, quote: 'Guidance on 1.1' } }, 'g'),
      raw('c', 2, { kind: 'note', parent_code: '1.1', authority: 'required', text: 'Publish it widely.', source: { page: 1, quote: 'publish it widely' } }, 'g'),
      raw('d', 3, { kind: 'note', parent_code: '1.1', authority: 'required', text: 'Print it.', source: { page: 1, quote: 'print it on posters' } }, 'g'),
      raw('e', 4, { kind: 'note', parent_code: '4.4', text: 'Nowhere.', source: { page: 1, quote: 'publish it widely' } }, 'g'),
    ], docs, text, new Set(['1.1']));
    expect(r.requirements.map((x) => [x.code, x.parentCode, x.flags.includes('orphan:7')])).toEqual([['7.1', null, true]]);
    expect(r.orphanRequirements).toBe(1);
    expect(r.notFromStandards).toBe(1);
    expect(r.orphanNotes).toBe(1);
    expect(r.notes.map((n) => [n.text, n.authority, n.quoteVerified, n.flags.includes('required_unverified')])).toEqual([
      ['Publish it widely.', 'required', true, false], ['Print it.', 'ai_suggested', false, true],
    ]);
    expect(r.checks.get('d')!.flags).toContain('quote_not_found');
    expect(r.checks.get('e')!.flags).toContain('orphan_note');
  });
});

describe('pageWindows and formatPages', () => {
  it('cuts ~8-page windows overlapping by one page', () => {
    expect(pageWindows([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(pageWindows(Array.from({ length: 9 }, (_, i) => i + 1))).toEqual([[1, 2, 3, 4, 5, 6, 7, 8], [8, 9]]);
    expect(pageWindows(Array.from({ length: 15 }, (_, i) => i + 1))).toEqual([[1, 2, 3, 4, 5, 6, 7, 8], [8, 9, 10, 11, 12, 13, 14, 15]]);
    expect(pageWindows([])).toEqual([]);
  });

  it('heads each page with its real number', () => {
    expect(formatPages([{ pageNo: 4, text: 'abc' }, { pageNo: 7, text: 'defgh' }], 3)).toBe('=== Page 4 ===\nabc\n\n=== Page 7 ===\ndef […]');
  });
});
