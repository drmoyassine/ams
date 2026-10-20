// Quality Management -> Cycles (TASK-080): every cycle of the institution with filters (status, unit or program, template, what it is
// about, only mine, late or due soon) and a search, "New cycle" (the same launch dialog as the ⋯ menu of a standard), and per row the
// title, what it is about and who does the work, the status, the progress, the next stage with its owner and date, and a flag while an
// owner or unit is still to be chosen. A draft is started with "Start" or deleted (to the Trash, with Undo); a running cycle is cancelled
// with a reason. People who cannot manage cycles see the list read-only.
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CYCLE_ANCHOR_KINDS, CYCLE_DUE_FILTERS, CYCLE_STATUSES, type CycleAnchorKind, type CycleDueFilter, type CycleFilter, type CycleStatus, type CycleSummary, type Me } from '@ams/shared';
import { useConfirm } from '../../components/confirm-dialog';
import { ContentText } from '../../components/content-text';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useDirectory, type CycleApis } from '../../components/cycles/directory';
import { LaunchCycleDialog } from '../../components/cycles/launch-cycle-dialog';
import { CYCLE_TONE, Chip, cycleStatusLabels, day, fieldCls, selectCls, stageStatusLabels } from '../../components/cycles/labels';
import { useTranslation } from '../../i18n';
import { useCyclesApi } from '../../lib/cycles-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { anchorLabels, type T } from '../settings/quality-management/labels';
import { DueSection } from './due-section';
import { ReasonDialog } from './dialogs';

const small = 'px-3 py-1';

export function CyclesTab({ me, meLoaded, apis = {}, onOpen }: { me: Me | undefined; meLoaded: boolean; apis?: CycleApis; onOpen: (cycleId: string) => void }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const api = useCyclesApi(apis.cycles);
  const dir = useDirectory(apis);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const manage = can(me, 'cycle:manage');
  const [status, setStatus] = useState<'' | CycleStatus>('');
  const [place, setPlace] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [anchorKind, setAnchorKind] = useState<'' | CycleAnchorKind>('');
  const [due, setDue] = useState<'' | CycleDueFilter>('');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<CycleSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);
  useEffect(() => { const id = setTimeout(() => setQ(search.trim()), 250); return () => clearTimeout(id); }, [search]);

  const placeId = place.split(':')[1];
  const filter: CycleFilter = {
    ...(status ? { status } : {}), ...(templateId ? { templateId } : {}), ...(anchorKind ? { anchorKind } : {}), ...(due ? { due } : {}),
    ...(mine && me?.userId ? { ownerId: me.userId } : {}), ...(q ? { q } : {}),
    ...(placeId ? { aboutId: placeId } : {}),
  };
  // The rows stay while a changed filter is fetched, so the list does not blink.
  const list = useQuery({ queryKey: ['cycles', filter], queryFn: () => api.list(filter), placeholderData: (previous) => previous });
  const templates = useQuery({ queryKey: ['cycle-templates'], queryFn: () => api.templates() });
  const filtered = Object.keys(filter).length > 0;
  const rows = list.data ?? [];
  const statuses = cycleStatusLabels(t);
  const stageStatuses = stageStatusLabels(t);
  const anchors = anchorLabels(t);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['cycles'] }); void qc.invalidateQueries({ queryKey: ['my-work'] }); };
  const run = async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setError(''); setBusy(true);
    try { const r = await act(fn); refresh(); return r; } finally { setBusy(false); }
  };
  const remove = async (c: CycleSummary) => {
    if (!(await confirm({ title: t('qmc.cycle.deleteTitle', { name: c.title }), message: t('qmc.cycle.deleteMessage'), confirmLabel: t('common.delete'), tone: 'danger' }))) return;
    await run(() => api.delete(c.id));
  };

  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground">{t('qmc.list.intro')}</p>
      <ReadOnlyNote show={meLoaded && !manage} />
      <DueSection manage={manage} me={me} apis={apis} onOpen={onOpen} />
      <div className="flex flex-wrap items-end gap-2" role="search" aria-label={t('qmc.filter.label')}>
        <label className={fieldCls}>{t('common.search')}<Input aria-label={t('qmc.filter.search')} dir="auto" className="min-w-0 sm:w-56" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label className={fieldCls}>{t('qmc.filter.status')}
          <select aria-label={t('qmc.filter.status')} className={`${selectCls} sm:w-auto`} value={status} onChange={(e) => setStatus(e.target.value as '' | CycleStatus)}>
            <option value="">{t('qmc.filter.allStatuses')}</option>
            {CYCLE_STATUSES.map((s) => <option key={s} value={s}>{statuses[s]}</option>)}
          </select>
        </label>
        <label className={fieldCls}>{t('qmc.filter.place')}
          <select aria-label={t('qmc.filter.place')} className={`${selectCls} sm:w-auto sm:max-w-56`} value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="">{t('qmc.filter.allPlaces')}</option>
            <optgroup label={t('ops.cycle.units')}>{dir.units.map((u) => <option key={u.id} value={`org_unit:${u.id}`}>{u.nameEn}</option>)}</optgroup>
            <optgroup label={t('ops.cycle.programs')}>{dir.programs.map((p) => <option key={p.id} value={`program:${p.id}`}>{p.nameEn}</option>)}</optgroup>
          </select>
        </label>
        <label className={fieldCls}>{t('qmc.filter.template')}
          <select aria-label={t('qmc.filter.template')} className={`${selectCls} sm:w-auto sm:max-w-56`} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">{t('qmc.filter.allTemplates')}</option>
            {(templates.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label className={fieldCls}>{t('qmc.filter.anchor')}
          <select aria-label={t('qmc.filter.anchor')} className={`${selectCls} sm:w-auto`} value={anchorKind} onChange={(e) => setAnchorKind(e.target.value as '' | CycleAnchorKind)}>
            <option value="">{t('qmc.filter.allAnchors')}</option>
            {CYCLE_ANCHOR_KINDS.map((k) => <option key={k} value={k}>{anchors[k]}</option>)}
          </select>
        </label>
        <label className={fieldCls}>{t('qmc.filter.due')}
          <select aria-label={t('qmc.filter.due')} className={`${selectCls} sm:w-auto`} value={due} onChange={(e) => setDue(e.target.value as '' | CycleDueFilter)}>
            <option value="">{t('qmc.filter.anyDue')}</option>
            {CYCLE_DUE_FILTERS.map((d) => <option key={d} value={d}>{d === 'late' ? t('qmc.filter.late') : t('qmc.filter.soon')}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />{t('qmc.filter.mine')}</label>
        {manage && <Button type="button" className="sm:ms-auto" onClick={() => setCreating(true)}>{t('qmc.new.button')}</Button>}
      </div>

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {list.isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {list.isError && <p role="alert" className="text-sm text-red-700">{(list.error as Error).message}</p>}
      {list.isSuccess && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-5" data-testid="no-cycles">
          <p className="font-medium">{filtered ? t('qmc.list.noMatch') : t('qmc.list.empty')}</p>
          {!filtered && <p className="mt-1 text-sm text-muted-foreground">{manage ? t('qmc.list.emptyManage') : t('qmc.list.emptyView')}</p>}
        </div>
      )}

      <ul className="space-y-2" aria-label={t('qmc.list.label')}>
        {rows.map((c) => {
          const pct = c.stageCount ? Math.round((c.stagesDone / c.stageCount) * 100) : 0;
          return (
            <li key={c.id} data-testid="cycle-row" data-status={c.status} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-start gap-2">
                <Link to="/quality-management/cycles/$id" params={{ id: c.id }} className="min-w-0 flex-1 break-words text-base font-medium underline-offset-2 hover:underline" dir="auto">{c.title}</Link>
                <div className="flex flex-wrap items-center gap-1">
                  <Chip tone={CYCLE_TONE[c.status]} testId="cycle-status">{statuses[c.status]}</Chip>
                  {c.late && <Chip tone="bad" testId="cycle-late">{t('qmc.late')}</Chip>}
                  {!c.late && c.dueSoon && <Chip tone="warn" testId="cycle-soon">{t('qmc.dueSoon')}</Chip>}
                  {c.unresolvedCount > 0 && c.status !== 'completed' && c.status !== 'cancelled' && <Chip tone="warn" testId="unresolved-flag" title={t('ops.cycle.unresolved', { count: c.unresolvedCount })}>{t('qmc.needsOwner', { count: c.unresolvedCount })}</Chip>}
                </div>
              </div>
              <dl className="grid gap-x-5 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('qmc.cycle.anchor')}:</dt><dd className="min-w-0 break-words"><span className="text-muted-foreground">{anchors[c.anchorKind]}: </span><ContentText>{c.anchorName ?? t('qmc.unknownName')}</ContentText></dd></div>
                {c.subjectKind && <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('qmc.cycle.subject')}:</dt><dd className="min-w-0 break-words"><ContentText>{c.subjectName ?? t('qmc.unknownName')}</ContentText></dd></div>}
                <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('qmc.cycle.unit')}:</dt><dd className="min-w-0 break-words"><ContentText>{c.responsibleUnitName ?? ''}</ContentText></dd></div>
                <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('qmc.cycle.dates')}:</dt><dd>{day(c.startDate)}{c.endDate ? ` – ${day(c.endDate)}` : ''}</dd></div>
                <div className="flex min-w-0 items-center gap-2 sm:col-span-1">
                  <dt className="shrink-0 text-muted-foreground">{t('qmc.cycle.progress')}:</dt>
                  <dd className="flex min-w-0 items-center gap-2">
                    <span data-testid="progress-text">{t('qmc.progress', { done: c.stagesDone, count: c.stageCount })}</span>
                    <span className="h-2 w-16 shrink-0 overflow-hidden rounded bg-muted" role="progressbar" aria-label={t('qmc.cycle.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span className="block h-2 bg-primary" style={{ width: `${pct}%` }} /></span>
                  </dd>
                </div>
                {c.nextStage && (
                  <div className="flex min-w-0 gap-1 sm:col-span-2 lg:col-span-3" data-testid="next-stage">
                    <dt className="shrink-0 text-muted-foreground">{t('qmc.next.title')}:</dt>
                    <dd className="min-w-0 break-words">
                      <ContentText>{c.nextStage.name}</ContentText>
                      <span className="text-muted-foreground"> · {stageStatuses[c.nextStage.status]} · </span>
                      {c.nextStage.ownerName ? <ContentText>{c.nextStage.ownerName}</ContentText> : <Chip tone="warn">{t('qmc.stage.noOwner')}</Chip>}
                      {c.nextStage.endDate && <span className={c.nextStage.late ? 'text-red-700' : 'text-muted-foreground'}> · {t('qmc.next.due', { date: day(c.nextStage.endDate) })}{c.nextStage.late ? ` (${t('qmc.late')})` : ''}</span>}
                    </dd>
                  </div>
                )}
              </dl>
              {c.status === 'cancelled' && c.cancelReason && <p className="break-words text-sm text-muted-foreground"><span className="font-medium">{t('qmc.cycle.cancelledBecause')}</span> <span dir="auto">{c.cancelReason}</span></p>}
              {manage && (c.status === 'draft' || c.status === 'active') && (
                <div className="flex flex-wrap gap-1">
                  {c.status === 'draft' && <Button type="button" variant="outline" className={small} disabled={busy || c.stageCount === 0} aria-label={t('qmc.cycle.startNamed', { name: c.title })} onClick={() => void run(() => api.activate(c.id))}>{t('qmc.cycle.start')}</Button>}
                  {c.status === 'draft' && <Button type="button" variant="ghost" className={`${small} text-red-700`} disabled={busy} aria-label={t('qmc.cycle.deleteNamed', { name: c.title })} onClick={() => void remove(c)}>{t('common.delete')}</Button>}
                  {c.status === 'active' && <Button type="button" variant="ghost" className={`${small} text-red-700`} disabled={busy} aria-label={t('qmc.cycle.cancelNamed', { name: c.title })} onClick={() => setCancelling(c)}>{t('qmc.cycle.cancel')}</Button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {creating && <LaunchCycleDialog me={me} apis={apis} onClose={() => setCreating(false)} onOpen={onOpen} />}
      {cancelling && (
        <ReasonDialog title={t('qmc.cycle.cancelTitle', { name: cancelling.title })} intro={t('qmc.cycle.cancelIntro')} label={t('qmc.cycle.cancelReason')} confirm={t('qmc.cycle.cancel')} busy={busy} error={error} onClose={() => setCancelling(null)}
          onSubmit={(reason) => void run(() => api.cancel(cancelling.id, reason)).then((r) => { if (r) setCancelling(null); })} />
      )}
    </div>
  );
}
