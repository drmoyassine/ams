import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import type { FrameworkApi } from '../../lib/framework-api';

/** What an item cites: a document, a page and the quote on it. */
export interface Citation { key: string; label: string; documentId: string; page: number; quote: string | null }

/** True from 1280px up: the viewer then sits beside the list; below it opens as a bottom sheet from the card's Source button. */
export function useWide(): boolean {
  const query = '(min-width: 1280px)';
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [wide, setWide] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return wide;
}

/** The page text with the cited stretch marked. Offsets come from the server (UTF-16, into this exact text). */
export function HighlightedText({ text, range }: { text: string; range: { start: number; end: number } | null }) {
  const mark = useRef<HTMLElement>(null);
  useEffect(() => { if (range && mark.current && typeof mark.current.scrollIntoView === 'function') mark.current.scrollIntoView({ block: 'nearest' }); }, [range?.start, range?.end, text]);
  if (!range || range.start >= range.end || range.end > text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, range.start)}
      <mark ref={mark} data-testid="source-highlight" className="rounded bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-700">{text.slice(range.start, range.end)}</mark>
      {text.slice(range.end)}
    </>
  );
}

/**
 * The source of the selected requirement or note: the document, the page number and that page's stored text, with the cited
 * quote highlighted (the highlight is computed on the server with the same matcher that verified the quote). Previous and next
 * page, a choice among the sources an item cites, and a link to the Docs tab. Direction follows the text (dir="auto").
 * Remount it (key) when the selection changes.
 */
export function SourceViewer({ api, title, citations, onOpenInDocs, heading = 'Source' }: {
  /** Only these two calls: the version page and the import review each give it their own. */
  api: Pick<FrameworkApi, 'pageView' | 'sourceFileUrl'>; title: string; citations: Citation[]; onOpenInDocs?: (documentId: string, page: number) => void; heading?: string;
}) {
  const [active, setActive] = useState(citations[0]?.key ?? '');
  const cite = citations.find((c) => c.key === active) ?? citations[0];
  const [page, setPage] = useState<number | null>(null); // null: the cited page
  const shown = page ?? cite?.page ?? 1;
  const view = useQuery({
    queryKey: ['page-view', cite?.documentId, shown, cite?.quote ?? ''], enabled: !!cite,
    queryFn: () => api.pageView(cite!.documentId, shown, cite!.quote ?? undefined),
  });
  const v = view.data;
  const at = v ? v.pageNos.indexOf(shown) : -1;
  const prev = v ? [...v.pageNos].reverse().find((n) => n < shown) : undefined;
  const next = v ? v.pageNos.find((n) => n > shown) : undefined;
  const choose = (c: Citation) => { setActive(c.key); setPage(null); };

  return (
    <section aria-label={heading} className="space-y-3 text-sm" data-testid="source-viewer">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{heading}</span>
        <span className="min-w-0 font-medium break-words"><ContentText>{title}</ContentText></span>
      </div>
      {!cite && <p className="text-muted-foreground">This item does not cite a source document.</p>}
      {citations.length > 1 && (
        <div role="group" aria-label="Sources this item cites" className="flex flex-wrap gap-1">
          {citations.map((c) => (
            <button key={c.key} type="button" aria-pressed={cite?.key === c.key} onClick={() => choose(c)}
              className={`rounded-md border px-2 py-1 text-start text-xs ${cite?.key === c.key ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>
              <ContentText>{c.label}</ContentText>
            </button>
          ))}
        </div>
      )}
      {cite && view.isError && <p role="alert" className="text-red-700">The source could not be loaded.</p>}
      {cite && !v && !view.isError && <p className="text-muted-foreground">Loading the page…</p>}
      {cite && v && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 break-words" data-testid="source-document"><ContentText>{v.document.title}</ContentText></span>
            <Button type="button" variant="outline" className="px-2 py-1" aria-label="Previous page" disabled={prev === undefined} onClick={() => prev !== undefined && setPage(prev)}>‹</Button>
            <span role="status" aria-label="Page" className="text-xs whitespace-nowrap">
              Page {shown}{v.pageNos.length > 0 && at >= 0 ? ` (${at + 1} of ${v.pageNos.length} stored)` : ''}
            </span>
            <Button type="button" variant="outline" className="px-2 py-1" aria-label="Next page" disabled={next === undefined} onClick={() => next !== undefined && setPage(next)}>›</Button>
          </div>
          {page !== null && page !== cite.page && <button type="button" className="text-xs underline" onClick={() => setPage(null)}>Back to the cited page ({cite.page})</button>}
          {v.quoteGiven && v.page && v.highlight === null && (
            <p role="note" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" data-testid="quote-missing">
              The quote was not found on this page, so nothing is highlighted.
              {v.quoteFoundOnPage !== null && <> It appears on <button type="button" className="underline" onClick={() => setPage(v.quoteFoundOnPage)}>page {v.quoteFoundOnPage}</button>.</>}
            </p>
          )}
          {cite.quote && <blockquote className="border-s-2 border-border ps-2 text-xs text-muted-foreground" data-testid="cited-quote"><ContentText>{cite.quote}</ContentText></blockquote>}
          {v.page ? (
            <>
              {v.page.needsOcr && <p role="note" className="text-xs text-amber-800">This page has no readable text layer; the text below may be incomplete.</p>}
              <div dir="auto" data-testid="source-page-text" className="max-h-[50dvh] overflow-y-auto rounded-md border border-border bg-background p-3 leading-relaxed whitespace-pre-wrap break-words xl:max-h-[calc(100dvh-24rem)]">
                <HighlightedText text={v.page.text} range={v.highlight} />
              </div>
            </>
          ) : (
            <p role="note" className="rounded border border-border bg-muted/40 p-2 text-xs" data-testid="page-missing">
              The text of page {shown} is not stored{v.pageNos.length === 0 ? ': this source has no page text yet. Read its file, or type the page in, under Docs.' : '.'}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {onOpenInDocs && <button type="button" className="underline" onClick={() => onOpenInDocs(v.document.id, shown)}>Open in Docs</button>}
            {v.document.hasFile && (
              <a className="underline" target="_blank" rel="noreferrer" href={`${api.sourceFileUrl(v.document.id)}${v.document.mime === 'application/pdf' ? `#page=${shown}` : ''}`}>
                Open the original file
              </a>
            )}
          </div>
        </>
      )}
    </section>
  );
}
