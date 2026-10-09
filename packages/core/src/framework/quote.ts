import { normalizeQuoteText } from './quote-match.js';

/**
 * Deterministic quote verification (DEC-006). The stored text of a source page is the only authority: a quote is
 * verified when, after normalising both sides the same way, it occurs in that page. Normalisation happens on the AMS
 * side only; stored text and quotes are never rewritten. The analysis uses the fuzzy form in quote-match.ts.
 */
export const normalizeForQuote = normalizeQuoteText;

export function quoteInText(quote: string, pageText: string): boolean {
  const q = normalizeForQuote(quote);
  return q.length > 0 && normalizeForQuote(pageText).includes(q);
}
