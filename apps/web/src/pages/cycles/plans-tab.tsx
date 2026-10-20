// Quality Management -> Plans (TASK-081, simplified by DEC-030): every cycle plan of the institution: what it is attached to, the template, how
// often, the next run not yet launched and its owner. A plan only PROPOSES runs; they appear under Cycles -> Due to launch for QA to launch and,
// for the plan's owner, in My work. Plans that already exist are listed and their dates kept, but no screen creates or changes them (DEC-031:
// evidence is collected by the schedule on the evidence item; plans for reports and Quality Assurance cycles are coming).
// For a plan whose next run is set by a decision, the date is recorded here. Anything that needs a term the calendar lacks says so.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CyclePlan, Me } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import type { CycleApis } from '../../components/cycles/directory';
import { Chip, day, fieldCls } from '../../components/cycles/labels';
import { gapText, planAnchorLabels, recurrenceText } from '../../components/plans/labels';
import { ReadOnlyNote } from '../../components/read-only-note';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useTranslation } from '../../i18n';
import { usePlansApi } from '../../lib/plans-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';

function NextDate({ plan, onSet, busy }: { plan: CyclePlan; onSet: (date: string) => void; busy: boolean }) {
  const { t } = useTranslation();
  const [date, setDate] = useState('');
  return (
    <form className="flex flex-wrap items-end gap-2" aria-label={t('plans.nextDate.form', { name: plan.templateName })} onSubmit={(e) => { e.preventDefault(); if (date) onSet(date); }}>
      <label className={fieldCls}>{t('plans.nextDate.label')}<Input type="date" required aria-label={t('plans.nextDate.labelNamed', { name: plan.templateName })} value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <Button type="submit" variant="outline" className="px-3 py-1" disabled={!date || busy}>{t('plans.nextDate.set')}</Button>
    </form>
  );
}

export function PlansTab({ me, meLoaded, apis = {} }: { me: Me | undefined; meLoaded: boolean; apis?: CycleApis }) {
  const { t } = useTranslation();
  const api = usePlansApi(apis.plans);
  const qc = useQueryClient();
  const manage = can(me, 'cycle:manage');
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);
  const list = useQuery({ queryKey: ['cycle-plans'], queryFn: () => api.list() });
  const labels = planAnchorLabels(t);
  const rows = (list.data ?? []).filter((p) => (!q.trim() || `${p.templateName} ${p.anchorName ?? ''} ${p.code ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['cycle-plans'] }); void qc.invalidateQueries({ queryKey: ['due-runs'] }); void qc.invalidateQueries({ queryKey: ['requirement-context'] }); };
  const setDate = async (p: CyclePlan, date: string) => {
    setBusy(true); setError('');
    try { const r = await act(() => api.setNextDate(p.id, date)); if (r) refresh(); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground">{t('plans.list.intro')}</p>
      <ReadOnlyNote show={meLoaded && !manage} />
      <div className="flex flex-wrap items-end gap-2" role="search" aria-label={t('plans.list.filters')}>
        <label className={fieldCls}>{t('common.search')}<Input aria-label={t('plans.list.search')} dir="auto" className="min-w-0 sm:w-56" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {list.isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {list.isError && <p role="alert" className="text-sm text-red-700">{(list.error as Error).message}</p>}
      {list.isSuccess && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-5" data-testid="no-plans">
          <p className="font-medium">{(list.data ?? []).length > 0 ? t('plans.list.noMatch') : t('plans.list.empty')}</p>
          {(list.data ?? []).length === 0 && <p className="mt-1 text-sm text-muted-foreground">{manage ? t('plans.list.emptyManage') : t('plans.list.emptyView')}</p>}
        </div>
      )}
      <ul className="space-y-2" aria-label={t('plans.list.label')}>
        {rows.map((p) => (
          <li key={p.id} data-testid="plan-row" data-mode={p.mode} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-start gap-2">
              <p className="min-w-0 flex-1 break-words text-base font-medium" dir="auto"><ContentText>{p.templateName}</ContentText></p>
              <div className="flex flex-wrap items-center gap-1">
                <Chip testId="plan-anchor-kind">{labels[p.anchorKind]}</Chip>
                {p.mode === 'opt_out' && <Chip tone="warn" testId="plan-opt-out">{t('plans.optedOut')}</Chip>}
                {!p.active && p.mode === 'own' && <Chip tone="neutral" testId="plan-off">{t('plans.off')}</Chip>}
              </div>
            </div>
            <dl className="grid gap-x-5 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('plans.list.attached')}:</dt><dd className="min-w-0 break-words"><ContentText>{p.anchorName ?? t('qmc.unknownName')}</ContentText></dd></div>
              {p.mode === 'own' && <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('plans.repeats')}:</dt><dd data-testid="plan-recurrence">{recurrenceText(t, p.recurrence)}</dd></div>}
              {p.mode === 'own' && p.firstStart && <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('plans.firstStart')}:</dt><dd>{day(p.firstStart)}</dd></div>}
              {p.mode === 'own' && (
                <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('plans.list.nextDue')}:</dt>
                  <dd className="min-w-0 break-words" data-testid="plan-next">{p.nextDue ? <><ContentText>{p.nextLabel}</ContentText> · {day(p.nextDue)}</> : p.waitingForDate ? t('plans.list.waiting') : t('plans.list.noneDue')}</dd></div>
              )}
              {p.ownerName && <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('plans.owner')}:</dt><dd className="min-w-0 break-words"><ContentText>{p.ownerName}</ContentText></dd></div>}
            </dl>
            {p.gap && p.mode === 'own' && <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="plan-gap">{gapText(t, p.gap)}. {t('plans.gap.define')}</p>}
            {manage && p.waitingForDate && <NextDate plan={p} busy={busy} onSet={(d) => void setDate(p, d)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
