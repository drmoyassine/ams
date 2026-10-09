/**
 * Deterministic quote verification for the framework analysis (DEC-006, PRD 15.1 step 5). Pure: no database, no AI.
 * The stored text of a source page is the only authority. Both sides are normalised the same way (on the AMS side only;
 * stored text and quotes are never rewritten) and the quote must occur in the page, exactly or with a similarity of at
 * least 0.9 (edit distance against the best-matching stretch of the page). The cited page is tried first, then its
 * neighbours, then the stretch across a page break.
 */

/** The threshold of PRD 15.1: a quote counts as found at 90% similarity or more. */
export const QUOTE_MATCH_THRESHOLD = 0.9;

const ALEF_VARIANTS = /[\u0622\u0623\u0625\u0671\u0672\u0673]/g; // آ أ إ ٱ ٲ ٳ -> ا
const ARABIC_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g; // harakat, Quranic marks, superscript alef

/**
 * NFC; zero-width and bidi marks removed; Arabic folded (alef variants, tatweel, diacritics, taa marbuta to haa, alef
 * maqsura and hamza seats to their base letters, Arabic-Indic digits to ASCII, Arabic punctuation); typographic quotes and
 * dashes unified; hyphenation at a line break joined; whitespace collapsed; lower case.
 */
export function normalizeQuoteText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/\u0640/g, '') // tatweel
    .replace(ARABIC_MARKS, '')
    .replace(ALEF_VARIANTS, '\u0627')
    .replace(/\u0629/g, '\u0647') // ة -> ه
    .replace(/\u0649/g, '\u064A') // ى -> ي
    .replace(/\u0624/g, '\u0648') // ؤ -> و
    .replace(/\u0626/g, '\u064A') // ئ -> ي
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u060C/g, ',').replace(/\u061B/g, ';').replace(/\u061F/g, '?')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/-\s*\n\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Longest needle compared character by character; longer ones are compared by word sequences (see below). */
const MAX_EDIT_NEEDLE = 600;

/**
 * Similarity (0..1) of `needle` to its best-matching stretch of `hay`, both already normalised: 1 minus the edit distance
 * divided by the needle's length (Sellers' approximate substring match). Long needles use the share of their word
 * trigrams found in the hay, which tolerates OCR noise without the quadratic cost.
 */
export function bestSubstringSimilarity(needle: string, hay: string): number {
  const m = needle.length;
  if (m === 0) return 0;
  if (hay.includes(needle)) return 1;
  if (m > MAX_EDIT_NEEDLE) return trigramShare(needle, hay);
  let prev = new Uint32Array(hay.length + 1); // row i-1; row 0 is all zeros: the match may start anywhere
  let cur = new Uint32Array(hay.length + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const a = needle.charCodeAt(i - 1);
    for (let j = 1; j <= hay.length; j++) {
      const sub = prev[j - 1]! + (a === hay.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j]! + 1;
      const ins = cur[j - 1]! + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    [prev, cur] = [cur, prev];
  }
  let best = m;
  for (let j = 0; j <= hay.length; j++) if (prev[j]! < best) best = prev[j]!;
  return Math.max(0, 1 - best / m);
}

function trigramShare(needle: string, hay: string): number {
  const grams = (s: string) => {
    const w = s.split(' ').filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i + 2 < w.length; i++) out.push(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    return out.length ? out : [w.join(' ')];
  };
  const have = new Set(grams(hay));
  const want = grams(needle);
  return want.filter((g) => have.has(g)).length / want.length;
}

/** Page texts of one source document by page number. */
export type PageTexts = ReadonlyMap<number, string>;

export interface QuoteCheck {
  verified: boolean;
  /** Where the quote was found: the cited page, a neighbour, or null when it was not found. */
  page: number | null;
  /** Best similarity seen (0..1). */
  score: number;
}

/**
 * Is `quote` on the cited page of this document? Falls back to the pages before and after, and to the stretch across
 * the cited page's breaks (a quote may run over a page). Reports where it was found.
 */
export function verifyQuote(quote: string, pages: PageTexts, citedPage: number, threshold = QUOTE_MATCH_THRESHOLD): QuoteCheck {
  const q = normalizeQuoteText(quote);
  if (!q) return { verified: false, page: null, score: 0 };
  const norm = new Map<number, string>();
  const page = (n: number) => {
    if (!norm.has(n)) norm.set(n, pages.has(n) ? normalizeQuoteText(pages.get(n)!) : '');
    return norm.get(n)!;
  };
  let best = 0;
  const attempts: [number, string][] = [
    [citedPage, page(citedPage)],
    [citedPage - 1, page(citedPage - 1)],
    [citedPage + 1, page(citedPage + 1)],
    [citedPage, `${page(citedPage)} ${page(citedPage + 1)}`.trim()],
    [citedPage - 1, `${page(citedPage - 1)} ${page(citedPage)}`.trim()],
  ];
  for (const [at, hay] of attempts) {
    if (!hay) continue;
    const s = bestSubstringSimilarity(q, hay);
    if (s > best) best = s;
    if (s >= threshold) return { verified: true, page: at, score: s };
  }
  return { verified: false, page: null, score: best };
}

/**
 * Is a requirement's whole text in the source (PRD 15.1: official_text must itself be contained in the source pages)?
 * Looks at the cited page together with the one before and the two after, since wording often runs over a page break.
 */
export function textInPages(text: string, pages: PageTexts, citedPage: number, threshold = QUOTE_MATCH_THRESHOLD): boolean {
  const t = normalizeQuoteText(text);
  if (!t) return false;
  const hay = [citedPage - 1, citedPage, citedPage + 1, citedPage + 2]
    .map((n) => (pages.has(n) ? normalizeQuoteText(pages.get(n)!) : '')).filter(Boolean).join(' ');
  return !!hay && bestSubstringSimilarity(t, hay) >= threshold;
}
