import { useQuery } from '@tanstack/react-query';
import type { ImportReport } from '@ams/shared';
import type { DocumentsApi } from '../../lib/documents-api';
import { Button } from '../ui/button';
import { RunChip, spendText, StatusChip, WhenText } from './parts';

const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;

/**
 * What an import run read, found and checked, from what is stored (never from a model): the documents and their pages, how many
 * pages were read by OCR, the proposals by status, every row that needs a look with its reasons, the spend and what was used.
 * Counts only; there is no score and no verdict.
 */
export function ImportReportView({ api, runId, onBack, onReview }: { api: DocumentsApi; runId: string; onBack: () => void; onReview: (runId: string) => void }) {
  const q = useQuery({ queryKey: ['import-report', runId], queryFn: () => api.report(runId) });
  const r = q.data;
  return (
    <section aria-label="Import report" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>← Back to documents</Button>
        {r && r.proposals.total > 0 && <Button type="button" variant="outline" className="ms-auto" onClick={() => onReview(runId)}>Review the proposals</Button>}
      </div>
      {q.isError && <p role="alert" className="text-sm text-red-700">The report could not be loaded.</p>}
      {!r && !q.isError && <p className="text-sm text-muted-foreground">Loading…</p>}
      {r && <Body r={r} />}
    </section>
  );
}

function Body({ r }: { r: ImportReport }) {
  const c = r.proposals;
  return (
    <>
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{r.run.targetLabel} import</h2>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <RunChip status={r.run.status} />
          <span>{r.scopeLabel}</span>
          {r.run.startedAt && <span>started <WhenText iso={r.run.startedAt} />{r.run.startedByName ? <> by <span dir="auto">{r.run.startedByName}</span></> : null}</span>}
        </p>
        {r.stoppedMessage && <p role="note" className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">{r.stoppedMessage}</p>}
        {r.run.status === 'failed' && r.run.error && !r.stoppedMessage && <p role="alert" className="text-sm text-red-700">{r.run.error}</p>}
      </header>

      <section aria-label="What was read" className="space-y-1">
        <h3 className="font-medium">What was read</h3>
        <p className="text-sm">{plural(r.totals.documentsRead, 'document')} read of {r.totals.documents}, {plural(r.totals.pages, 'page')} in all{r.totals.ocrPages ? `, ${plural(r.totals.ocrPages, 'page')} read by OCR` : ''}{r.totals.unreadablePages ? `, ${plural(r.totals.unreadablePages, 'page')} could not be read` : ''}.</p>
        <ul className="space-y-1 text-sm">
          {r.documents.map((d) => (
            <li key={d.documentId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span dir="auto" className="min-w-0 break-all font-medium">{d.name}</span>
              <span className="text-xs text-muted-foreground">{plural(d.pages, 'page')}{d.pagesOcr ? `, ${d.pagesOcr} by OCR` : ''}{d.pagesUnreadable ? `, ${d.pagesUnreadable} unreadable` : ''}</span>
              <StatusChip doc={{ status: d.status, statusText: d.readError ?? d.status, name: d.name }} />
              {d.warnings.length > 0 && <span className="min-w-0 text-xs text-amber-900">{d.warnings.join('; ')}</span>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="What was found" className="space-y-1">
        <h3 className="font-medium">What was found</h3>
        <p className="text-sm" data-testid="report-counts">
          {plural(c.total, 'item')}: {c.pending} waiting for a decision, {c.accepted + c.edited} accepted{c.edited ? ` (${c.edited} edited)` : ''}, {c.skipped} skipped, {c.applied} applied.
        </p>
        <p className="text-sm text-muted-foreground">Quotes found on their page: {c.quoteVerified} of {c.total}{c.lowConfidence ? ` · ${c.lowConfidence} the AI was unsure about` : ''}.</p>
      </section>

      <section aria-label="Rows to look at" className="space-y-1">
        <h3 className="font-medium">To look at ({r.flagged.length})</h3>
        {r.flagged.length === 0 ? <p className="text-sm text-muted-foreground">Nothing was flagged.</p> : (
          <ul className="space-y-1 text-sm">
            {r.flagged.map((f) => (
              <li key={f.proposalId} data-testid="flagged" className="break-words">
                <span dir="auto" className="font-medium">{f.label || 'Item'}</span>
                {f.documentName && <span className="text-xs text-muted-foreground"> · <span dir="auto">{f.documentName}</span>{f.pageNo ? `, page ${f.pageNo}` : ''}</span>}
                <span className="block text-xs text-amber-900">{f.reasons.join(' ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Applied" className="space-y-1">
        <h3 className="font-medium">Applied</h3>
        {r.applies.length === 0 ? <p className="text-sm text-muted-foreground">Nothing has been applied yet.</p> : (
          <ul className="space-y-1 text-sm">
            {r.applies.map((a) => (
              <li key={a.id}>{plural(a.applied, 'item')} applied <WhenText iso={a.appliedAt} />{a.byName ? <> by <span dir="auto">{a.byName}</span></> : null}{a.state === 'undone' ? ' · undone' : ''}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Cost and settings" className="space-y-1">
        <h3 className="font-medium">Cost and settings</h3>
        <p className="text-sm">{plural(r.usage.calls, 'model call')} · {spendText(r.usage)}</p>
        <p className="text-xs text-muted-foreground">{r.models.model ? `Model: ${r.models.model}${r.models.role === 'reading' ? ' (reading model)' : ''}. ` : ''}{r.promptVersion ? `Instructions version ${r.promptVersion}.` : ''}</p>
      </section>
    </>
  );
}
