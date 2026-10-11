// The review screen's source viewer: one stored page of a source, with the stretch a requirement or note cites marked.
// The marking is computed here, with the same matcher that verified the quote (quote-match.ts), never in the browser.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { sourcePage } from '@ams/db';
import type { Ctx } from '../ctx.js';
import { ValidationError } from '../ctx.js';
import { getSourceDocument, require_ } from './common.js';
import { locateQuote } from './quote-match.js';

export interface SourcePageView {
  document: { id: string; title: string; role: string; language: string; fileName: string | null; mime: string | null; hasFile: boolean; pageCount: number };
  /** Numbers of the pages whose text is stored, in order: what the previous/next buttons walk. */
  pageNos: number[];
  /** The requested page as stored; null when its text is not stored. */
  page: { pageNo: number; text: string; method: string; needsOcr: boolean } | null;
  /** The stretch of `page.text` that the quote matches (UTF-16 offsets, end exclusive); null: not on this page, or no quote given. */
  highlight: { start: number; end: number; score: number } | null;
  /** A quote was given and not found on this page: where it is instead (a neighbouring page), or null when nowhere near. */
  quoteFoundOnPage: number | null;
  /** Whether a quote was given to look for. */
  quoteGiven: boolean;
}

export const MAX_VIEW_QUOTE = 4000;

/** One page of a source for the split-view review, with the cited quote located in it. */
export async function getSourcePageView(ctx: Ctx, documentId: string, pageNo: number, quote?: string): Promise<SourcePageView> {
  await require_(ctx, 'framework:read');
  if (!Number.isInteger(pageNo) || pageNo < 1) throw new ValidationError('page numbers start at 1');
  if (quote && quote.length > MAX_VIEW_QUOTE) throw new ValidationError(`the quote is longer than ${MAX_VIEW_QUOTE} characters`);
  const doc = await getSourceDocument(ctx, documentId);
  const nos = (await ctx.tx.select({ n: sourcePage.pageNo }).from(sourcePage).where(eq(sourcePage.sourceDocumentId, documentId)).orderBy(asc(sourcePage.pageNo))).map((r) => r.n);
  const near = [pageNo - 1, pageNo, pageNo + 1, pageNo + 2].filter((n) => n >= 1 && nos.includes(n));
  const rows = near.length
    ? await ctx.tx.select().from(sourcePage).where(and(eq(sourcePage.sourceDocumentId, documentId), inArray(sourcePage.pageNo, near)))
    : [];
  const mine = rows.find((r) => r.pageNo === pageNo) ?? null;
  const trimmed = quote?.trim() ?? '';
  let highlight: SourcePageView['highlight'] = null;
  let elsewhere: number | null = null;
  if (trimmed && mine) {
    const hit = locateQuote(trimmed, new Map(rows.map((r) => [r.pageNo, r.text])), pageNo);
    if (hit?.page === pageNo) highlight = { start: hit.start, end: hit.end, score: hit.score };
    else if (hit) elsewhere = hit.page;
  }
  return {
    document: {
      id: doc.id, title: doc.title, role: doc.role, language: doc.language, fileName: doc.fileName, mime: doc.mime, hasFile: !!doc.fileName,
      pageCount: Math.max(nos.length, doc.pageCount ?? 0),
    },
    pageNos: nos,
    page: mine ? { pageNo: mine.pageNo, text: mine.text, method: mine.method, needsOcr: mine.needsOcr } : null,
    highlight,
    quoteFoundOnPage: elsewhere,
    quoteGiven: !!trimmed,
  };
}
