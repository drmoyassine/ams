// A cycle (/quality-management/cycles/$id, TASK-080): the header (title, what it is about, who is responsible, who leads it, status,
// dates, cancel, the previous cycle), the stages as a timeline and as a list, and - for a draft - the controls to build it by hand.
// Full width, no side panels. What a person can do mirrors the API: cycle:manage for the cycle's own settings, owners, units and dates;
// a stage owner (or cycle:work) works the stage; only the named approver decides an approval. Everyone else sees it read-only.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CycleDetail } from '@ams/shared';
import { useConfirm } from '../../components/confirm-dialog';
import { ContentText } from '../../components/content-text';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { useDirectory, type CycleApis } from '../../components/cycles/directory';
import { CYCLE_TONE, Chip, cycleStatusLabels, day } from '../../components/cycles/labels';
import { useTranslation } from '../../i18n';
import { useCyclesApi } from '../../lib/cycles-api';
import { useMe } from '../../lib/me';
import { useSettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import { anchorLabels, type T } from '../settings/quality-management/labels';
import { CycleTimeline } from './cycle-timeline';
import { AddStageDialog } from './draft-dialogs';
import { EditCycleDialog, ReasonDialog } from './dialogs';
import type { CycleEnv, RunOptions } from './env';
import { StageCard } from './stage-card';

export function CyclePage({ id, stageId, apis = {}, onBack }: { id: string; /** Opens this stage (the link of "My work"). */ stageId?: string | undefined; apis?: CycleApis; onBack?: () => void }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const api = useCyclesApi(apis.cycles);
  const settings = useSettingsApi(apis.settings);
  const me = useMe(settings);
  const dir = useDirectory(apis);
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cycle', id], queryFn: () => api.get(id) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ at: string; text: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'cancel' | 'edit' | 'stage' | null>(null);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [scrollTo, setScrollTo] = useState<string | null>(stageId ?? null);
  const at = useRef('');
  const act = useAction((text) => setError({ at: at.current, text }));
  const cycle = q.data;

  const run = async (fn: () => Promise<CycleDetail>, options: RunOptions = {}) => {
    at.current = options.at ?? '';
    setBusy(true); setNotice(''); setError(null);
    try {
      const r = await act(fn);
      if (r) {
        qc.setQueryData(['cycle', id], r);
        void qc.invalidateQueries({ queryKey: ['cycles'] });
        void qc.invalidateQueries({ queryKey: ['my-work'] });
        if (options.notice) setNotice(options.notice);
      }
      return r;
    } finally { setBusy(false); }
  };

  // The stage the link points at (or one picked on the timeline) opens and scrolls into view once it is on the page.
  useEffect(() => {
    if (!scrollTo || !cycle?.stages.some((s) => s.id === scrollTo)) return;
    const el = document.getElementById(`stage-${scrollTo}`);
    if (el) { el.scrollIntoView?.({ block: 'start' }); setScrollTo(null); }
  }, [scrollTo, cycle, toggled]);

  if (q.isError) return <p role="alert" className="text-sm text-red-700">{(q.error as Error).message}</p>;
  if (!cycle) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;

  const manage = cycle.canManage;
  const anyWork = cycle.stages.some((s) => s.canWork) || cycle.stages.some((s) => s.outputs.some((o) => o.canDecide));
  const statuses = cycleStatusLabels(t);
  const anchors = anchorLabels(t);
  const env: CycleEnv = {
    cycle, api, apis, me: me.data, dir, manage, busy, error, run,
    focusStage: (stage) => { setToggled((x) => ({ ...x, [stage]: true })); setScrollTo(stage); },
  };
  const isOpen = (stage: CycleDetail['stages'][number]) => toggled[stage.id] ?? (stage.status !== 'completed' && stage.status !== 'skipped');
  const pageError = error && error.at === '' ? error.text : '';
  const unresolved = cycle.unresolvedCount;

  const removeDraft = async () => {
    if (!(await confirm({ title: t('qmc.cycle.deleteTitle', { name: cycle.title }), message: t('qmc.cycle.deleteMessage'), confirmLabel: t('common.delete'), tone: 'danger' }))) return;
    at.current = '';
    setBusy(true); setError(null);
    try {
      const r = await act(() => api.delete(cycle.id));
      if (r) { void qc.invalidateQueries({ queryKey: ['cycles'] }); void qc.invalidateQueries({ queryKey: ['my-work'] }); onBack?.(); }
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4" data-testid="cycle-page">
      <p className="text-sm"><Link to="/quality-management" search={{ tab: 'cycles' }} className="underline">{t('qmc.cycle.back')}</Link></p>
      <header className="space-y-2">
        <div className="flex flex-wrap items-start gap-2">
          <h1 className="min-w-0 flex-1 break-words text-xl font-semibold sm:text-2xl" dir="auto">{cycle.title}</h1>
          <Chip tone={CYCLE_TONE[cycle.status]} testId="cycle-status">{statuses[cycle.status]}</Chip>
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label={t('qmc.cycle.anchor')} value={<><span className="text-muted-foreground">{anchors[cycle.anchorKind]}: </span><ContentText>{cycle.anchorName ?? t('qmc.unknownName')}</ContentText></>} />
          {cycle.subjectKind && <Fact label={t('qmc.cycle.subject')} value={<ContentText>{cycle.subjectName ?? t('qmc.unknownName')}</ContentText>} />}
          <Fact label={t('qmc.cycle.unit')} value={<ContentText>{cycle.responsibleUnitName ?? ''}</ContentText>} />
          <Fact label={t('qmc.cycle.lead')} value={<ContentText>{cycle.leadName ?? ''}</ContentText>} />
          <Fact label={t('qmc.cycle.dates')} value={<>{day(cycle.startDate)}{cycle.endDate ? ` – ${day(cycle.endDate)}` : ''}</>} />
          {cycle.periodLabel && <Fact label={t('qmc.cycle.period')} value={<ContentText>{cycle.periodLabel}</ContentText>} />}
          {cycle.templateName && <Fact label={t('qmc.cycle.template')} value={<><ContentText>{cycle.templateName}</ContentText>{cycle.templateVersion ? ` · ${t('qmt.version', { version: cycle.templateVersion })}` : ''}</>} />}
          <Fact label={t('qmc.cycle.progress')} value={t('qmc.progress', { done: cycle.stagesDone, count: cycle.stageCount })} />
          {cycle.previousCycleId && <Fact label={t('qmc.cycle.previous')} value={<Link className="underline" to="/quality-management/cycles/$id" params={{ id: cycle.previousCycleId }}>{t('qmc.cycle.openPrevious')}</Link>} />}
        </dl>
        {cycle.status === 'cancelled' && (
          <p role="note" data-testid="cancel-reason" className="break-words rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900"><span className="font-medium">{t('qmc.cycle.cancelledBecause')}</span> <span dir="auto">{cycle.cancelReason}</span></p>
        )}
        {cycle.status === 'draft' && <p role="note" className="rounded-md border border-border bg-muted p-2 text-sm" data-testid="draft-note">{t('qmc.cycle.draftNote')}</p>}
        {unresolved > 0 && cycle.status !== 'completed' && cycle.status !== 'cancelled' && (
          <p role="note" data-testid="unresolved-note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">{t('ops.cycle.unresolved', { count: unresolved })}</p>
        )}
        <ReadOnlyNote show={me.isSuccess && !manage && !anyWork} />
        {manage && cycle.status !== 'completed' && cycle.status !== 'cancelled' && (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('qmc.cycle.actions')}>
            {cycle.status === 'draft' && <Button type="button" disabled={busy || cycle.stages.length === 0} onClick={() => void run(() => api.activate(cycle.id))}>{t('qmc.cycle.start')}</Button>}
            {cycle.status === 'active' && cycle.stages.every((s) => s.status === 'not_started') && <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => api.revertToDraft(cycle.id))}>{t('qmc.cycle.backToDraft')}</Button>}
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog('edit')}>{t('qmc.cycle.edit')}</Button>
            {cycle.status === 'draft' && <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog('stage')}>{t('qmc.addStage.open')}</Button>}
            {cycle.status === 'draft' && <Button type="button" variant="ghost" className="text-red-700" disabled={busy} onClick={() => void removeDraft()}>{t('qmc.cycle.deleteDraft')}</Button>}
            {cycle.status === 'active' && <Button type="button" variant="ghost" className="text-red-700" disabled={busy} onClick={() => setDialog('cancel')}>{t('qmc.cycle.cancel')}</Button>}
          </div>
        )}
        {pageError && <p role="alert" className="text-sm text-red-700">{pageError}</p>}
        {notice && <p role="status" className="text-sm text-emerald-800" data-testid="notice">{notice}</p>}
      </header>

      <section aria-label={t('qmc.timeline.title')} className="space-y-2">
        <h2 className="text-base font-semibold">{t('qmc.timeline.title')}</h2>
        {cycle.stages.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="no-stages">{manage && cycle.status === 'draft' ? t('qmc.cycle.noStagesBuild') : t('qmc.cycle.noStages')}</p> : <CycleTimeline cycle={cycle} onOpen={env.focusStage} />}
      </section>

      {cycle.stages.length > 0 && (
        <section aria-label={t('qmc.stages.title')} className="space-y-2">
          <h2 className="text-base font-semibold">{t('qmc.stages.title')}</h2>
          <ol className="space-y-3" aria-label={t('qmc.stages.title')}>
            {cycle.stages.map((s, i) => <StageCard key={s.id} stage={s} index={i} env={env} open={isOpen(s)} onToggle={() => setToggled((x) => ({ ...x, [s.id]: !isOpen(s) }))} />)}
          </ol>
        </section>
      )}

      {dialog === 'cancel' && (
        <ReasonDialog title={t('qmc.cycle.cancelTitle', { name: cycle.title })} intro={t('qmc.cycle.cancelIntro')} label={t('qmc.cycle.cancelReason')} confirm={t('qmc.cycle.cancel')} busy={busy} error={pageError} onClose={() => setDialog(null)}
          onSubmit={(reason) => void run(() => api.cancel(cycle.id, reason)).then((r) => { if (r) setDialog(null); })} />
      )}
      {dialog === 'edit' && (
        <EditCycleDialog cycle={cycle} dir={dir} busy={busy} error={pageError} onClose={() => setDialog(null)}
          onSubmit={(v) => void run(() => api.update(cycle.id, { title: v.title, leadUserId: v.leadUserId, responsibleUnitId: v.responsibleUnitId, endDate: v.endDate, periodLabel: v.periodLabel, ...(cycle.status === 'draft' && v.startDate !== cycle.startDate ? { startDate: v.startDate } : {}) })).then((r) => { if (r) setDialog(null); })} />
      )}
      {dialog === 'stage' && (
        <AddStageDialog cycle={cycle} dir={dir} busy={busy} error={pageError} onClose={() => setDialog(null)}
          onSubmit={(v) => void run(() => api.addStage(cycle.id, v)).then((r) => { if (r) { setDialog(null); setToggled((x) => ({ ...x, [r.stages[r.stages.length - 1]!.id]: true })); } })} />
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{label}:</dt><dd className="min-w-0 break-words">{value}</dd></div>;
}
