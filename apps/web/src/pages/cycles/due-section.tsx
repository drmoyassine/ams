// Quality Management -> Cycles -> "Due to launch" (TASK-081, DEC-029: plans PROPOSE, QA launches). The runs that are due or coming up
// because a plan says so and no run exists yet: one line per plan, subject and period. Filters (template, who it is about, due or
// coming up, how far ahead), select several and "Review and launch" (the shared launch dialog, one run after another, with the template,
// subject, period and plan already filled in), or "Skip this period" with a reason, which is kept so the run is not proposed again.
// Stretches the academic calendar does not cover are named ("No term defined for that period"), never guessed. Computed on request:
// nothing here launches by itself.
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { DueRun, DueRunsQuery } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { type CycleApis } from '../../components/cycles/directory';
import { LaunchCycleDialog } from '../../components/cycles/launch-cycle-dialog';
import { Chip, day, fieldCls, selectCls } from '../../components/cycles/labels';
import { gapText } from '../../components/plans/labels';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { usePlansApi } from '../../lib/plans-api';
import { useAction } from '../../lib/use-action';
import { ReasonDialog } from './dialogs';

const HORIZONS = [30, 120, 365] as const;
const rowKey = (r: DueRun) => `${r.planId}|${r.subjectKind ?? '-'}:${r.subjectId ?? r.anchorId}|${r.periodStart}`;

export function DueSection({ manage, apis = {}, me, onOpen }: { manage: boolean; apis?: CycleApis; me: Parameters<typeof LaunchCycleDialog>[0]['me']; onOpen: (cycleId: string) => void }) {
  const { t } = useTranslation();
  const api = usePlansApi(apis.plans);
  const qc = useQueryClient();
  const [templateId, setTemplateId] = useState('');
  const [state, setState] = useState<'' | 'due' | 'upcoming'>('');
  const [horizon, setHorizon] = useState<number>(120);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<DueRun[]>([]);
  const [skipping, setSkipping] = useState<DueRun | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const made = useRef(false);
  const act = useAction(setError);

  const query: DueRunsQuery = { horizonDays: horizon, ...(templateId ? { templateId } : {}), ...(state ? { state } : {}) };
  const due = useQuery({ queryKey: ['due-runs', query], queryFn: () => api.due(query), placeholderData: (p) => p });
  const plans = useQuery({ queryKey: ['cycle-plans'], queryFn: () => api.list(), staleTime: 30_000 });
  const runs = due.data?.runs ?? [];
  const templates = [...new Map((plans.data ?? []).filter((p) => p.mode === 'own').map((p) => [p.templateId, p.templateName] as const))];
  const launchable = runs.filter((r) => r.canLaunch);
  const chosen = launchable.filter((r) => picked.has(rowKey(r)));
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['due-runs'] }); void qc.invalidateQueries({ queryKey: ['cycle-plans'] }); void qc.invalidateQueries({ queryKey: ['cycles'] }); };

  const toggle = (r: DueRun) => setPicked((s) => { const n = new Set(s); const k = rowKey(r); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const start = (list: DueRun[]) => { made.current = false; setQueue(list); };
  const closeLaunch = () => {
    // After a run was made the next one opens; closing without making one stops the rest.
    if (made.current) { made.current = false; setQueue((q) => q.slice(1)); } else setQueue([]);
    setPicked(new Set());
    refresh();
  };
  const skip = async (reason: string) => {
    if (!skipping) return;
    setBusy(true); setError('');
    try {
      const r = await act(() => api.skip({ planId: skipping.planId, subjectKind: skipping.subjectKind, subjectId: skipping.subjectId, periodStart: skipping.periodStart, reason }));
      if (r) { setSkipping(null); refresh(); }
    } finally { setBusy(false); }
  };
  const current = queue[0];

  return (
    <section aria-labelledby="due-title" className="space-y-3 rounded-lg border border-border p-3" data-testid="due-section">
      <div>
        <h2 id="due-title" className="text-base font-semibold">{t('plans.due.title')}</h2>
        <p className="max-w-prose text-sm text-muted-foreground">{t('plans.due.intro')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2" role="search" aria-label={t('plans.due.filters')}>
        <label className={fieldCls}>{t('plans.due.template')}
          <select aria-label={t('plans.due.template')} className={`${selectCls} sm:w-auto sm:max-w-56`} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">{t('qmc.filter.allTemplates')}</option>
            {templates.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className={fieldCls}>{t('plans.due.state')}
          <select aria-label={t('plans.due.state')} className={`${selectCls} sm:w-auto`} value={state} onChange={(e) => setState(e.target.value as '' | 'due' | 'upcoming')}>
            <option value="">{t('plans.due.anyState')}</option>
            <option value="due">{t('plans.state.due')}</option>
            <option value="upcoming">{t('plans.state.upcoming')}</option>
          </select>
        </label>
        <label className={fieldCls}>{t('plans.due.horizon')}
          <select aria-label={t('plans.due.horizon')} className={`${selectCls} sm:w-auto`} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
            {HORIZONS.map((h) => <option key={h} value={h}>{t('plans.due.days', { count: h })}</option>)}
          </select>
        </label>
        {manage && <Button type="button" className="sm:ms-auto" disabled={chosen.length === 0 || busy} onClick={() => start(chosen)}>{t('plans.due.reviewLaunch', { count: chosen.length })}</Button>}
      </div>

      {error && !skipping && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {due.isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {due.isError && <p role="alert" className="text-sm text-red-700">{(due.error as Error).message}</p>}
      {due.isSuccess && runs.length === 0 && <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground" data-testid="nothing-due">{t('plans.due.empty', { count: horizon })}</p>}

      <ul className="space-y-2" aria-label={t('plans.due.list')}>
        {runs.map((r) => {
          const k = rowKey(r);
          return (
            <li key={k} data-testid="due-run" data-state={r.state} className="flex flex-wrap items-start gap-2 rounded-lg border border-border p-2">
              {manage && <input type="checkbox" className="mt-1" aria-label={t('plans.due.select', { name: `${r.templateName} ${r.periodLabel} ${r.subjectName ?? ''}` })} disabled={!r.canLaunch} checked={picked.has(k)} onChange={() => toggle(r)} />}
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="min-w-0 break-words text-sm font-medium" dir="auto"><ContentText>{r.templateName}</ContentText> · <ContentText>{r.periodLabel}</ContentText></p>
                <p className="min-w-0 break-words text-xs text-muted-foreground">
                  <ContentText>{r.subjectName ?? r.anchorName ?? ''}</ContentText>
                  {r.subjectKind && r.anchorName && <> · <ContentText>{r.anchorName}</ContentText></>}
                  {r.ownerName && <> · {t('qmc.new.owner')}: <ContentText>{r.ownerName}</ContentText></>}
                  {' · '}{day(r.periodStart)}{r.periodEnd ? ` – ${day(r.periodEnd)}` : ''}
                </p>
              </div>
              <Chip tone={r.state === 'due' ? 'warn' : 'neutral'} testId="due-state">{r.state === 'due' ? t('plans.state.due') : t('plans.state.upcoming')}</Chip>
              {manage && (
                <div className="flex flex-wrap gap-1">
                  <Button type="button" variant="outline" className="px-3 py-1" disabled={!r.canLaunch || busy} aria-label={t('plans.due.launchNamed', { name: `${r.templateName} ${r.periodLabel} ${r.subjectName ?? ''}` })} onClick={() => start([r])}>{t('plans.due.launch')}</Button>
                  <Button type="button" variant="ghost" className="px-3 py-1" disabled={busy} aria-label={t('plans.due.skipNamed', { name: `${r.templateName} ${r.periodLabel} ${r.subjectName ?? ''}` })} onClick={() => { setError(''); setSkipping(r); }}>{t('plans.due.skip')}</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {(due.data?.gaps ?? []).length > 0 && (
        <ul className="space-y-1" aria-label={t('plans.due.gaps')} data-testid="due-gaps">
          {due.data!.gaps.map((g) => (
            <li key={`${g.planId}|${g.reason}`} role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              <ContentText className="font-medium">{g.planLabel}</ContentText>: {gapText(t, g)}{g.reason !== 'no_date' ? ` ${t('plans.gap.define')}` : ` ${t('plans.gap.setDate')}`}
            </li>
          ))}
          <li className="text-xs text-muted-foreground"><Link to="/settings/organization" className="underline">{t('plans.gap.openCalendar')}</Link></li>
        </ul>
      )}

      {current && (
        <LaunchCycleDialog key={rowKey(current)} proposal={current} me={me} apis={apis} onClose={closeLaunch} onOpen={onOpen} onMade={() => { made.current = true; }} />
      )}
      {skipping && (
        <ReasonDialog title={t('plans.skip.title', { name: `${skipping.templateName} · ${skipping.periodLabel}` })} intro={t('plans.skip.intro')} label={t('plans.skip.reason')} confirm={t('plans.due.skip')} busy={busy} error={error}
          onClose={() => setSkipping(null)} onSubmit={(reason) => void skip(reason)} />
      )}
    </section>
  );
}
