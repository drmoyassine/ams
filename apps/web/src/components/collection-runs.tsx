// The runs of an evidence item (TASK-090, DEC-031): one line for each period of its schedule, with what happened to it (pending, requested,
// supplied, late, failed, skipped), what supplied it, the error of a failed one, and the actions: Run now, Retry, Skip this period (with a reason)
// and Mark supplied (choose an existing version). Shown in the item's Collection section. Also the "BI is not configured" note, and the
// status chips shared by the library cards and My work.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_COLLECTION_ATTEMPTS, type CollectionRun, type CollectionRunStatus, type EvidenceItem, type EvidenceVersion } from '@ams/shared';
import { useTranslation } from '../i18n';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';
import { formatDate, formatDateTime } from '../lib/intl';
import { useAction } from '../lib/use-action';
import { DialogTitle, ReasonDialog } from '../pages/cycles/dialogs';
import { ContentText } from './content-text';
import { Chip, day, fieldCls, selectCls, type Tone } from './cycles/labels';
import { Dialog } from './dialog';
import { Button } from './ui/button';

export const RUN_TONE: Record<CollectionRunStatus, Tone> = { pending: 'neutral', requested: 'info', supplied: 'good', late: 'warn', failed: 'bad', skipped: 'neutral' };

/** The status of a run as a chip: the word always, the colour as a help. */
export function RunStatusChip({ run }: { run: Pick<CollectionRun, 'status'> }) {
  const { t } = useTranslation();
  return <Chip tone={RUN_TONE[run.status]} testId="run-status">{t(`coll.status.${run.status}`)}</Chip>;
}

/** Whether the BI is set up on the server (no secrets); a person without the right to read evidence never gets here. */
export function useCollectionConfig(api: EvidenceApi, enabled = true) {
  return useQuery({ queryKey: ['collection-config'], queryFn: () => api.collectionConfig(), enabled, staleTime: 60_000, retry: false });
}

/** Said on the Collection section of a BI item while the server has no BI to ask. */
export function BiNotConfigured() {
  const { t } = useTranslation();
  return <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="bi-not-configured">{t('coll.biNotConfigured')}</p>;
}

/** Choose which version of the item answers the period. */
function SupplyDialog({ run, versions, busy, error, onSubmit, onClose }: {
  run: CollectionRun; versions: EvidenceVersion[]; busy: boolean; error: string; onSubmit: (versionId: string) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [versionId, setVersionId] = useState(versions[0]?.id ?? '');
  return (
    <Dialog labelledBy="supply-run-title" onClose={onClose}>
      <DialogTitle id="supply-run-title" onClose={onClose}>{t('coll.supply.title', { period: run.periodLabel })}</DialogTitle>
      <form className="space-y-3" aria-label={t('coll.supply.title', { period: run.periodLabel })} onSubmit={(e) => { e.preventDefault(); if (versionId) onSubmit(versionId); }}>
        <p className="text-sm text-muted-foreground">{t('coll.supply.intro')}</p>
        <label className={fieldCls}>{t('coll.supply.version')}
          <select aria-label={t('coll.supply.version')} className={selectCls} value={versionId} onChange={(e) => setVersionId(e.target.value)} dir="auto">
            {versions.map((v) => <option key={v.id} value={v.id}>{t('coll.supply.option', { n: v.versionNo, date: formatDate(v.createdAt) })}{v.fileName ? ` · ${v.fileName}` : ''}</option>)}
          </select>
        </label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !versionId}>{t('coll.supply.confirm')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** One run: the period, when it is due, its state, what supplied it or went wrong, and what a person may do about it. */
function RunRow({ run, canWrite, versions, onSkip, onSupply, onRetry, busy }: {
  run: CollectionRun; canWrite: boolean; versions: EvidenceVersion[]; busy: boolean; onSkip: () => void; onSupply: () => void; onRetry: () => void;
}) {
  const { t } = useTranslation();
  const open = run.status === 'pending' || run.status === 'requested' || run.status === 'late';
  const actionable = open || run.status === 'failed';
  return (
    <li data-testid="collection-run" data-status={run.status} className="space-y-1 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words font-medium" dir="auto"><ContentText>{run.periodLabel}</ContentText></span>
        <RunStatusChip run={run} />
        <span className="text-xs text-muted-foreground">{t('coll.due', { date: day(run.dueDate) })}</span>
        {run.status === 'supplied' && run.versionNo !== null && <span className="text-xs text-muted-foreground" data-testid="run-version">{t('coll.suppliedBy', { n: run.versionNo })}</span>}
        <span className="ms-auto flex flex-wrap gap-1">
          {canWrite && run.status === 'failed' && <Button type="button" variant="outline" className="px-3 py-1" disabled={busy} aria-label={t('coll.retryNamed', { period: run.periodLabel })} onClick={onRetry}>{t('coll.retry')}</Button>}
          {canWrite && actionable && versions.length > 0 && <Button type="button" variant="ghost" className="px-3 py-1" disabled={busy} aria-label={t('coll.markSuppliedNamed', { period: run.periodLabel })} onClick={onSupply}>{t('coll.markSupplied')}</Button>}
          {canWrite && actionable && <Button type="button" variant="ghost" className="px-3 py-1" disabled={busy} aria-label={t('coll.skipNamed', { period: run.periodLabel })} onClick={onSkip}>{t('coll.skip')}</Button>}
        </span>
      </div>
      {run.status === 'failed' && run.lastError && (
        <p className="break-words text-sm text-red-800" role="note" data-testid="run-error" dir="auto">{run.lastError}</p>
      )}
      {run.status === 'failed' && (
        <p className="text-xs text-muted-foreground" data-testid="run-attempts">
          {t('coll.attempts', { count: run.attempts, max: MAX_COLLECTION_ATTEMPTS })} · {run.nextAttemptAt ? t('coll.nextAttempt', { date: formatDateTime(run.nextAttemptAt) }) : t('coll.noRetry')}
        </p>
      )}
      {run.status === 'skipped' && run.skipReason && <p className="break-words text-sm text-muted-foreground" data-testid="run-skip-reason" dir="auto">{t('coll.skippedFor', { reason: run.skipReason })}</p>}
      {run.status === 'requested' && run.method === 'request' && run.requestHasAccount === false && <p className="text-xs text-muted-foreground" data-testid="run-no-account">{t('coll.requestNoAccount')}</p>}
      {run.status === 'requested' && run.method === 'bi' && <p className="text-xs text-muted-foreground">{t('coll.waitingForBi')}</p>}
    </li>
  );
}

/**
 * The runs of one item, newest period first, with "Run now". Reading needs evidence:read; the actions are for those who may write evidence and
 * for an item that is active.
 */
export function CollectionRuns({ item, canWrite, apis }: { item: EvidenceItem; canWrite: boolean; apis?: { evidence?: EvidenceApi | undefined } | undefined }) {
  const { t } = useTranslation();
  const api = useEvidenceApi(apis?.evidence);
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['item-runs', item.id], queryFn: () => api.itemRuns(item.id) });
  const versions = useQuery({ queryKey: ['evidence-item', item.id], queryFn: () => api.get(item.id), select: (d) => d.versions });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [skipping, setSkipping] = useState<CollectionRun | null>(null);
  const [supplying, setSupplying] = useState<CollectionRun | null>(null);
  const act = useAction(setError);
  const active = item.status === 'active';
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['item-runs', item.id] }), qc.invalidateQueries({ queryKey: ['evidence-item', item.id] }), qc.invalidateQueries({ queryKey: ['evidence'] }),
    qc.invalidateQueries({ queryKey: ['collection-runs'] }), qc.invalidateQueries({ queryKey: ['notifications'] }), qc.invalidateQueries({ queryKey: ['evidence-requests'] }),
  ]);
  const run = async (fn: () => Promise<unknown>, done?: () => void) => {
    setBusy(true); setError('');
    try { if ((await act(async () => { await fn(); return true; })) !== undefined) { done?.(); await refresh(); } } finally { setBusy(false); }
  };
  const list = runs.data ?? [];
  return (
    <div className="space-y-2" data-testid="collection-runs">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{t('coll.runs.title')}</h3>
        {canWrite && active && item.method !== 'survey' && (
          <Button type="button" variant="outline" className="ms-auto px-3 py-1" disabled={busy} onClick={() => void run(() => api.runNow(item.id))}>{busy ? t('coll.runNowBusy') : t('coll.runNow')}</Button>
        )}
      </div>
      {error && !skipping && !supplying && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {runs.isError && <p role="alert" className="text-sm text-red-700">{(runs.error as Error).message}</p>}
      {runs.isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {runs.isSuccess && list.length === 0 && <p className="rounded-md border border-dashed border-border p-2 text-sm text-muted-foreground" data-testid="no-runs">{item.schedule ? t('coll.runs.noneScheduled') : t('coll.runs.none')}</p>}
      {list.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border text-sm" aria-label={t('coll.runs.title')}>
          {list.map((r) => (
            <RunRow key={r.id} run={r} canWrite={canWrite} versions={versions.data ?? []} busy={busy}
              onRetry={() => void run(() => api.retryRun(r.id))} onSkip={() => { setError(''); setSkipping(r); }} onSupply={() => { setError(''); setSupplying(r); }} />
          ))}
        </ul>
      )}
      {skipping && (
        <ReasonDialog title={t('coll.skip.title', { period: skipping.periodLabel })} intro={t('coll.skip.intro')} label={t('coll.skip.reason')} confirm={t('coll.skip')} busy={busy} error={error}
          onClose={() => setSkipping(null)} onSubmit={(reason) => void run(() => api.skipRun(skipping.id, reason), () => setSkipping(null))} />
      )}
      {supplying && (
        <SupplyDialog run={supplying} versions={versions.data ?? []} busy={busy} error={error} onClose={() => setSupplying(null)}
          onSubmit={(versionId) => void run(() => api.supplyRun(supplying.id, versionId), () => setSupplying(null))} />
      )}
    </div>
  );
}
