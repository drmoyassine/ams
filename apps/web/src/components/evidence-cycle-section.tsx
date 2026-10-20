// The Cycle section of an evidence item's card (DEC-030, TASK-087): "Collect this regularly". It shows the plan the item has (template, how
// often, owner, the next due date), the cycle that is open now (a link to its page) and the past ones, and offers "Collect this regularly"
// (the plan dialog), "Start a cycle now" (a one-off cycle, the shared launch dialog with this item fixed) and "Stop repeating". It uses the
// existing plan and cycle services anchored on the evidence item; people who may not manage cycles read it and change nothing.
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CyclePlan, CycleSummary, EvidenceItem } from '@ams/shared';
import { useTranslation } from '../i18n';
import { useCyclesApi } from '../lib/cycles-api';
import { type FrameworkApi } from '../lib/framework-api';
import { can, useMe } from '../lib/me';
import { usePlansApi } from '../lib/plans-api';
import { useAction } from '../lib/use-action';
import { Shaded } from './accordion';
import { useConfirm } from './confirm-dialog';
import { ContentText } from './content-text';
import { PlanDialog } from './cycles/plan-dialog';
import { LaunchCycleDialog } from './cycles/launch-cycle-dialog';
import { CYCLE_TONE, Chip, cycleStatusLabels, day } from './cycles/labels';
import type { CycleApis } from './cycles/directory';
import { recurrenceText } from './plans/labels';
import { Button } from './ui/button';
import type { T } from '../pages/settings/quality-management/labels';

const small = 'px-3 py-1';
const OPEN = new Set(['draft', 'active']);

export function EvidenceCycleSection({ item, framework, apis = {} }: { item: EvidenceItem; framework: FrameworkApi; apis?: CycleApis }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const cycles = useCyclesApi(apis.cycles);
  const plansApi = usePlansApi(apis.plans);
  const me = useMe(framework);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<'plan' | 'start' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);
  const readable = can(me.data, 'cycle:read');
  const manage = can(me.data, 'cycle:manage') && item.status === 'active';
  const plan = useQuery({ queryKey: ['cycle-plans', 'target', 'evidence_item', item.id], queryFn: () => plansApi.target({ anchorKind: 'evidence_item', anchorId: item.id }), enabled: readable });
  const list = useQuery({ queryKey: ['cycles', { anchorKind: 'evidence_item', anchorId: item.id }], queryFn: () => cycles.list({ anchorKind: 'evidence_item', anchorId: item.id }), enabled: readable });
  const statuses = cycleStatusLabels(t);
  if (me.isSuccess && !readable) return null;

  const plans = (plan.data?.own ?? []).filter((p) => p.mode === 'own');
  const current: CyclePlan | undefined = plans.find((p) => p.active) ?? plans[0];
  const runs = list.data ?? [];
  const open = runs.filter((c) => OPEN.has(c.status));
  const past = runs.filter((c) => !OPEN.has(c.status));
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['cycle-plans'] }), qc.invalidateQueries({ queryKey: ['due-runs'] }), qc.invalidateQueries({ queryKey: ['cycles'] }), qc.invalidateQueries({ queryKey: ['my-work'] }),
  ]);
  /** Removes the plan when it never made a cycle, else switches it off (its cycles keep pointing at it). */
  const stop = async (p: CyclePlan) => {
    if (!(await confirm({ title: t('evc.stop.title'), message: t('evc.stop.message'), confirmLabel: t('evc.stop'), tone: 'danger' }))) return;
    setBusy(true); setError('');
    try {
      const made = runs.some((c) => c.planId === p.id);
      const r = await act(() => (made
        ? plansApi.set({
          anchorKind: 'evidence_item', anchorId: item.id, templateId: p.templateId, mode: 'own', recurrence: p.recurrence ?? undefined, firstStart: p.firstStart ?? undefined,
          ownerUserId: p.ownerUserId, responsibleUnitId: p.responsibleUnitId, appliesTo: p.appliesTo, active: false,
        } as never).then(() => true)
        : plansApi.clear(p.id).then(() => true)));
      if (r !== undefined) await refresh();
    } finally { setBusy(false); }
  };

  return (
    <section aria-label={t('evc.title')} className="space-y-2" data-testid="evidence-cycle">
      <Shaded>{t('evc.title')}</Shaded>
      {(plan.isLoading || list.isLoading) && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {plan.isError && <p role="alert" className="text-sm text-red-700">{(plan.error as Error).message}</p>}
      {plan.isSuccess && !current && <p className="text-sm text-muted-foreground" data-testid="evidence-cycle-none">{t('evc.none')}</p>}
      {current && (
        <div className="space-y-1 rounded-md border border-border p-3" data-testid="evidence-plan" data-active={current.active}>
          <p className="flex min-w-0 flex-wrap items-center gap-2 break-words text-sm font-medium"><ContentText>{current.templateName}</ContentText>
            {!current.active && <Chip tone="neutral" testId="plan-stopped">{t('evc.stopped')}</Chip>}
          </p>
          <dl className="grid gap-x-5 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('plans.repeats')}:</dt><dd data-testid="plan-recurrence">{recurrenceText(tr, current.recurrence)}</dd></div>
            {current.firstStart && <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('evc.firstDue')}:</dt><dd>{day(current.firstStart)}</dd></div>}
            <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('qmc.new.owner')}:</dt><dd className="min-w-0 break-words" dir="auto">{current.ownerName ?? t('evc.ownerFromItem')}</dd></div>
            {current.active && (
              <div className="flex min-w-0 gap-1"><dt className="shrink-0 text-muted-foreground">{t('plans.list.nextDue')}:</dt>
                <dd className="min-w-0 break-words" data-testid="plan-next">{current.nextDue ? <><ContentText>{current.nextLabel}</ContentText> · {day(current.nextDue)}</> : current.waitingForDate ? t('plans.list.waiting') : t('plans.list.noneDue')}</dd></div>
            )}
          </dl>
        </div>
      )}

      {open.length > 0 && (
        <div className="space-y-1" data-testid="evidence-open-cycle">
          <p className="text-xs text-muted-foreground">{t('evc.open')}</p>
          <ul className="space-y-1">{open.map((c) => <CycleLine key={c.id} c={c} status={statuses[c.status]} />)}</ul>
        </div>
      )}
      {past.length > 0 && (
        <div className="space-y-1" data-testid="evidence-past-cycles">
          <p className="text-xs text-muted-foreground">{t('evc.past')}</p>
          <ul className="space-y-1">{past.map((c) => <CycleLine key={c.id} c={c} status={statuses[c.status]} />)}</ul>
        </div>
      )}
      {list.isSuccess && runs.length === 0 && current && <p className="text-sm text-muted-foreground">{t('evc.noCycles')}</p>}

      {manage && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('evc.actions')}>
          <Button type="button" variant="outline" className={small} disabled={busy} onClick={() => setDialog('plan')}>{current?.active ? t('evc.change') : t('evc.collect')}</Button>
          <Button type="button" variant="outline" className={small} disabled={busy} onClick={() => setDialog('start')}>{t('evc.startNow')}</Button>
          {current?.active && <Button type="button" variant="ghost" className={`${small} text-red-700`} disabled={busy} onClick={() => void stop(current)}>{t('evc.stop')}</Button>}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {dialog === 'plan' && (
        <PlanDialog evidence={{ id: item.id, title: item.title, ownerUserId: item.ownerUserId }} {...(current ? { plan: current } : {})} me={me.data} apis={apis} onClose={() => setDialog(null)} onSaved={() => void refresh()} />
      )}
      {dialog === 'start' && (
        <LaunchCycleDialog evidenceId={item.id} me={me.data} apis={apis} onClose={() => { setDialog(null); void refresh(); }} onOpen={(id) => { void navigate({ to: '/quality-management/cycles/$id', params: { id } }); }} />
      )}
    </section>
  );
}

function CycleLine({ c, status }: { c: CycleSummary; status: string }) {
  const { t } = useTranslation();
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2 text-sm" data-testid="evidence-cycle-row" data-status={c.status}>
      <Link to="/quality-management/cycles/$id" params={{ id: c.id }} className="min-w-0 break-words underline-offset-2 hover:underline" dir="auto">{c.title}</Link>
      <Chip tone={CYCLE_TONE[c.status]}>{status}</Chip>
      {c.nextStage && c.status !== 'completed' && c.status !== 'cancelled' && (
        <span className="min-w-0 break-words text-xs text-muted-foreground">{t('qmc.next.title')}: <ContentText>{c.nextStage.name}</ContentText>{c.nextStage.endDate ? ` · ${t('qmc.next.due', { date: day(c.nextStage.endDate) })}` : ''}</span>
      )}
      {(c.status === 'completed' || c.status === 'cancelled') && <span className="text-xs text-muted-foreground">{day(c.startDate)}{c.endDate ? ` – ${day(c.endDate)}` : ''}</span>}
    </li>
  );
}
