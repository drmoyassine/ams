// Where a quote is on a page (the review screen's highlight): the same matcher as the verifier, returning offsets into the
// page text as stored. Pure; no database.
import { describe, expect, it } from 'vitest';
import { bestSubstringMatch, bestSubstringSimilarity, foldWithMap, locateQuote, normalizeQuoteText, verifyQuote } from './quote-match.js';

const SAMPLES = [
  'Institutions must publish their mission statement.',
  '  Leading   and\ttrailing \n whitespace  ',
  'Line-\nbreak hyphenation – and “typographic” quotes ‘too’',
  'يَجِبُ أَنْ تَكُونَ لِلْمُؤَسَّسَةِ رِسَالَةٌ مُعْلَنَةٌ ١٢٣',
  'الـــرســالــة والأهداف‏ (٢٠٢٦)',
  'école  Œuvre İstanbul',
  'a ​ b ﻿ c',
  '',
];

describe('foldWithMap', () => {
  it('folds exactly like normalizeQuoteText', () => {
    for (const s of SAMPLES) expect(foldWithMap(s).norm, JSON.stringify(s)).toBe(normalizeQuoteText(s));
  });

  it('maps every folded character back into the original text', () => {
    for (const s of SAMPLES) {
      const f = foldWithMap(s);
      expect(f.starts).toHaveLength(f.norm.length);
      for (let i = 0; i < f.norm.length; i++) {
        expect(f.starts[i]!).toBeGreaterThanOrEqual(0);
        expect(f.ends[i]!).toBeLessThanOrEqual(s.length);
        expect(f.ends[i]!).toBeGreaterThan(f.starts[i]!);
      }
    }
  });
});

describe('bestSubstringMatch', () => {
  it('agrees with bestSubstringSimilarity and says where', () => {
    const hay = 'the institution must publish its mission statement every year';
    for (const needle of ['must publish its mission statement', 'must publish it mission statment', 'nothing like it at all, really']) {
      expect(bestSubstringMatch(needle, hay).score).toBeCloseTo(bestSubstringSimilarity(needle, hay), 10);
    }
    expect(bestSubstringMatch('must publish its mission statement', hay)).toMatchObject({ score: 1, start: 16, end: 50 });
    const fuzzy = bestSubstringMatch('must publish it mission statment', hay);
    expect(fuzzy.score).toBeGreaterThanOrEqual(0.9);
    expect(hay.slice(fuzzy.start, fuzzy.end)).toContain('mission');
  });
});

describe('locateQuote', () => {
  const pages = (...texts: string[]) => new Map(texts.map((t, i) => [i + 1, t] as const));

  it('returns the range of the cited quote in the page as stored', () => {
    const text = 'Standard 1\nInstitutions must publish their mission statement.\nIt is reviewed every year.';
    const hit = locateQuote('must publish their  MISSION statement', pages(text), 1)!;
    expect(hit.page).toBe(1);
    expect(text.slice(hit.start, hit.end)).toBe('must publish their mission statement');
  });

  it('finds an Arabic quote written without its diacritics inside a vowelled page, and highlights whole letters', () => {
    const text = 'المعيار الأول\nيَجِبُ أَنْ تَكُونَ لِلْمُؤَسَّسَةِ رِسَالَةٌ مُعْلَنَةٌ.\nتُراجَعُ كُلَّ سَنَةٍ.';
    const hit = locateQuote('يجب أن تكون للمؤسسة رسالة معلنة', pages(text), 1)!;
    expect(hit).not.toBeNull();
    const shown = text.slice(hit.start, hit.end);
    expect(shown.startsWith('يَجِبُ')).toBe(true);
    expect(shown.endsWith('مُعْلَنَةٌ')).toBe(true); // the last letter keeps its marks
    expect(normalizeQuoteText(shown)).toBe(normalizeQuoteText('يجب أن تكون للمؤسسة رسالة معلنة'));
    // and the verifier agrees that it is there
    expect(verifyQuote('يجب أن تكون للمؤسسة رسالة معلنة', pages(text), 1).verified).toBe(true);
  });

  it('accepts a small slip like the verifier does (90%) and rejects a different sentence', () => {
    const text = 'The institution shall maintain a published mission statement approved by its board.';
    expect(locateQuote('The institution shall maintain a publishd mission statement approved by its board.', pages(text), 1)).not.toBeNull();
    expect(locateQuote('Graduates complete a capstone project in their final year.', pages(text), 1)).toBeNull();
    expect(locateQuote('   ', pages(text), 1)).toBeNull();
  });

  it('finds the quote on a neighbouring page when the cited page is wrong, and says which', () => {
    const hit = locateQuote('every programme has learning outcomes', pages('Cover page', 'Contents', 'Every programme has learning outcomes.'), 2)!;
    expect(hit.page).toBe(3);
  });

  it('clips a quote that runs over a page break to the cited page', () => {
    const p1 = 'Preamble. The institution must keep a record of';
    const p2 = 'every complaint it receives, and its outcome. More text.';
    const quote = 'must keep a record of every complaint it receives';
    const onFirst = locateQuote(quote, pages(p1, p2), 1)!;
    expect(onFirst.page).toBe(1);
    expect(p1.slice(onFirst.start, onFirst.end)).toBe('must keep a record of');
    const onSecond = locateQuote(quote, pages(p1, p2), 2)!;
    expect(onSecond.page).toBe(2);
    expect(p2.slice(onSecond.start, onSecond.end)).toBe('every complaint it receives');
  });

  it('joins a word hyphenated at a line break', () => {
    const text = 'The institution evalu-\nates its programmes every year.';
    const hit = locateQuote('evaluates its programmes', pages(text), 1)!;
    expect(text.slice(hit.start, hit.end)).toBe('evalu-\nates its programmes');
  });
});
