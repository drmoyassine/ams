/**
 * Deterministic quote verification (DEC-006). The stored text of a source page is the only authority: a quote is
 * verified when, after normalising both sides the same way, it occurs in that page. Normalisation happens on the AMS
 * side only; stored text and quotes are never rewritten.
 */
export function normalizeForQuote(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '') // zero-width and bidi marks
    .replace(/\u0640/g, '') // Arabic tatweel
    .replace(/[\u064B-\u065F\u0670]/g, '') // Arabic diacritics (harakat)
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/-\s*\n\s*/g, '') // hyphenation at a line break
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function quoteInText(quote: string, pageText: string): boolean {
  const q = normalizeForQuote(quote);
  return q.length > 0 && normalizeForQuote(pageText).includes(q);
}
