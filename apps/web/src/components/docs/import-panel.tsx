import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentRow, ImportRun, ImportStage, ImportTargetInfo } from '@ams/shared';
import type { DocScopeRef, DocumentsApi } from '../../lib/documents-api';
import { useAction } from '../../lib/use-action';
import { Dialog } from '../dialog';
import { Button } from '../ui/button';
import { RunChip, spendText, WhenText } from './parts';

const STAGE_LABEL: Record<ImportStage, string> = {
  read: 'Reading the documents', extract: 'Finding', verify: 'Checking the quotes', propose: 'Preparing the list', finalise: 'Finishing',
};
const active = (r: ImportRun | undefined) => r?.status === 'queued' || r?.status === 'running';
const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;

/** Where a run stands, in words, for the progress strip. */
export function importProgressText(r: ImportRun, itemsLabel: string): string {
  const p = r.progress;
  const parts: string[] = [];
  if (r.status === 'queued') parts.push('Waiting for the worker');
  else if (r.stage === 'extract') parts.push(`${STAGE_LABEL.extract} ${itemsLabel}`);
  else if (r.stage) parts.push(STAGE_LABEL[r.stage]);
  if (r.stage === 'read' && p.docsTotal) parts.push(`document ${Math.min((p.docsDone ?? 0) + 1, p.docsTotal)} of ${p.docsTotal}`);
  if (p.windowsTotal && r.stage === 'extract') parts.push(`${p.windowsDone ?? 0}/${p.windowsTotal} windows`);
  if (p.items !== undefined && r.stage !== 'read') parts.push(`${p.items.toLocaleString('en')} ${p.items === 1 ? 'item' : 'items'} so far`);
  parts.push(spendText(r.usage));
  return parts.join(' · ');
}

/** What a run came to, in words: "12 found, 8 applied, 2 skipped". Counts only. */
export function importCountsText(r: ImportRun): string {
  const c = r.counts;
  return [`${c.total} found`, ...(c.applied ? [`${c.applied} applied`] : []), ...(c.skipped ? [`${c.skipped} skipped`] : []), ...(c.pending && !active(r) ? [`${c.pending} waiting for a decision`] : []), ...(c.flagged ? [`${c.flagged} to look at`] : [])].join(', ');
}

/**
 * The imports a place offers: one button per target, the readiness check before it starts, live progress while it runs (the list
 * polls), and the history of earlier runs with a link to each one's proposals and report.
 */
export function ImportPanel({ api, scope, targets, docs, canImport, onReview, onReport, onFix }: {
  api: DocumentsApi; scope: DocScopeRef; targets: ImportTargetInfo[]; docs: DocumentRow[]; canImport: boolean;
  onReview: (runId: string) => void; onReport: (runId: string) => void; onFix?: (where: 'docs' | 'sources' | 'version') => void;
}) {
  const qc = useQueryClient();
  const key = ['imports', scope.kind, scope.id];
  const runs = useQuery({ queryKey: key, queryFn: () => api.runs(scope), refetchInterval: (q) => (q.state.data?.some((r) => active(r)) ? 1500 : false) });
  const list = runs.data ?? [];
  const current = list.find((r) => active(r));
  const [dialog, setDialog] = useState<ImportTargetInfo | null>(null);
  const [error, setError] = useState('');
  const run = useAction(setError);
  const was = useRef(false);
  useEffect(() => {
    // A run just ended: the documents and their counts may have changed.
    if (was.current && !current) void qc.invalidateQueries({ queryKey: ['docs', scope.kind, scope.id] });
    was.current = !!current;
  }, [current, qc, scope.kind, scope.id]);
  const noun = (r: ImportRun) => targets.find((t) => t.kind === r.targetKind)?.itemsLabel ?? 'items';

  if (!targets.length && !list.length) return null;
  return (
    <section aria-label="Imports" className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">Import</h3>
        <span className="text-xs text-muted-foreground">The AI reads the documents and proposes drafts for you to review. Nothing is saved until you apply it.</span>
        {canImport && !current && targets.map((t, i) => (
          <Button key={t.kind} type="button" className={i === 0 ? 'ms-auto' : ''} onClick={() => { setError(''); setDialog(t); }}>Import {t.label.toLowerCase()}</Button>
        ))}
        {canImport && current && <Button type="button" variant="outline" className="ms-auto" onClick={() => { void run(() => api.cancel(current.id)).then(() => qc.invalidateQueries({ queryKey: key })); }}>Stop</Button>}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {current && <div role="status" aria-label="Import progress" aria-live="polite" className="rounded bg-muted px-2 py-1 text-sm break-words">{current.targetLabel}: {importProgressText(current, noun(current))}</div>}
      {list.length > 0 && (
        <ul aria-label="Import history" className="space-y-1 text-sm">
          {list.slice(0, 10).map((r) => (
            <li key={r.id} data-testid="import-run" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 break-words">
              <RunChip status={r.status} />
              <span className="font-medium">{r.targetLabel}</span>
              <span className="text-xs text-muted-foreground"><WhenText iso={r.startedAt ?? r.createdAt} />{r.startedByName ? <> by <span dir="auto">{r.startedByName}</span></> : null}</span>
              {!active(r) && <span className="min-w-0 text-xs">{importCountsText(r)}</span>}
              <span className="text-xs text-muted-foreground">{spendText(r.usage)}</span>
              {r.status === 'failed' && r.error && <span className="min-w-0 text-xs text-red-700">{r.error}</span>}
              {!active(r) && r.counts.total > 0 && <button type="button" className="text-xs underline" aria-label={`Review the proposals of the ${r.targetLabel} import`} onClick={() => onReview(r.id)}>Review</button>}
              {!active(r) && <button type="button" className="text-xs underline" aria-label={`Report of the ${r.targetLabel} import`} onClick={() => onReport(r.id)}>Report</button>}
            </li>
          ))}
        </ul>
      )}
      {dialog && (
        <StartDialog api={api} scope={scope} target={dialog} docs={docs} onClose={() => setDialog(null)} {...(onFix ? { onFix } : {})}
          onStarted={() => { setDialog(null); void qc.invalidateQueries({ queryKey: key }); }} />
      )}
    </section>
  );
}

/** The readiness check (never a model call), the documents to read, and Start. */
function StartDialog({ api, scope, target, docs, onClose, onStarted, onFix }: {
  api: DocumentsApi; scope: DocScopeRef; target: ImportTargetInfo; docs: DocumentRow[]; onClose: () => void; onStarted: () => void;
  onFix?: (where: 'docs' | 'sources' | 'version') => void;
}) {
  const usable = docs.filter((d) => d.status !== 'failed' && (d.hasFile || (d.pageCount ?? 0) > 0));
  const [picked, setPicked] = useState<Set<string>>(new Set(usable.map((d) => d.id)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useAction(setError);
  const pre = useQuery({ queryKey: ['import-preflight', scope.kind, scope.id, target.kind], queryFn: () => api.preflight(scope, target.kind), staleTime: 0, gcTime: 0 });
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const can = !!pre.data?.canStart && picked.size > 0;
  const start = async () => {
    setBusy(true); setError('');
    const r = await run(() => api.start({ scopeKind: scope.kind, scopeId: scope.id, targetKind: target.kind, documentIds: usable.filter((d) => picked.has(d.id)).map((d) => d.id) }));
    setBusy(false);
    if (r) onStarted();
  };
  return (
    <Dialog labelledBy="import-start-title" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="import-start-title" className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">Import {target.label.toLowerCase()}</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{target.description} The AI reads your documents (never your evidence files) and proposes {target.itemsLabel} beside the page they came from. You review them; nothing changes until you apply.</p>
      {pre.isLoading && <p className="text-sm text-muted-foreground">Checking…</p>}
      {pre.data && (
        <ul aria-label="Before you start" className="mb-3 space-y-1 text-sm">
          {pre.data.checks.map((c) => (
            <li key={c.id} data-testid="preflight-check" className="flex flex-wrap items-baseline gap-x-2">
              <span className={`rounded px-1.5 text-xs ${c.status === 'ok' ? 'bg-emerald-50 text-emerald-900' : c.status === 'problem' ? 'bg-red-50 text-red-900' : 'bg-muted text-muted-foreground'}`}>{c.status === 'ok' ? 'OK' : c.status === 'problem' ? 'Fix' : 'Note'}</span>
              <span className="min-w-0 break-words">{c.message}</span>
              {c.fix?.where === 'ai' && <Link to="/settings/ai" className="underline">{c.fix.label}</Link>}
              {c.fix && c.fix.where !== 'ai' && onFix && <button type="button" className="underline" onClick={() => { onFix(c.fix!.where as 'docs'); onClose(); }}>{c.fix.label}</button>}
            </li>
          ))}
        </ul>
      )}
      {pre.isError && <p role="alert" className="mb-3 text-sm text-red-700">Could not check whether an import can start.</p>}
      {usable.length > 0 && (
        <fieldset className="mb-3 space-y-1 text-sm">
          <legend className="mb-1 font-medium">Documents to read</legend>
          {usable.map((d) => (
            <label key={d.id} className="flex items-start gap-2">
              <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} className="mt-1" />
              <span dir="auto" className="min-w-0 break-all">{d.name}</span>
              <span className="text-xs text-muted-foreground">{d.statusText}</span>
            </label>
          ))}
        </fieldset>
      )}
      {pre.data && !pre.data.canStart && <p className="mb-2 text-sm text-amber-900">{pre.data.firstProblem}</p>}
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="button" disabled={!can || busy} title={!can ? pre.data?.firstProblem ?? undefined : undefined} onClick={() => void start()}>Start import</Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{plural(picked.size, 'document')} chosen.</p>
    </Dialog>
  );
}
