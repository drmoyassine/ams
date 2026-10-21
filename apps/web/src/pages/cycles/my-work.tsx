// Quality Management -> My work (TASK-080, DEC-030): the runs that have fallen due of plans I own, each with a "Start" (the shared launch dialog),
// the evidence I owe (the open collection runs of items I own: "Supply <evidence> for <period>", TASK-090), the stages I own in running cycles and the approvals waiting for my decision, with due dates and late flags, each linking to the stage on its
// cycle page. A person with nothing to do sees that there is nothing for them.
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DueRun, EvidenceLink } from '@ams/shared';
import { RunStatusChip } from '../../components/collection-runs';
import { ContentText } from '../../components/content-text';
import type { CycleApis } from '../../components/cycles/directory';
import { LaunchCycleDialog } from '../../components/cycles/launch-cycle-dialog';
import { Chip, day, stageStatusLabels } from '../../components/cycles/labels';
import { ResubmitLinkDialog } from '../../components/link-review-dialogs';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { useCyclesApi } from '../../lib/cycles-api';
import { useEvidenceApi } from '../../lib/evidence-api';
import { formatDate } from '../../lib/intl';
import { can, useMe } from '../../lib/me';
import { useSettingsApi } from '../../lib/settings-api';
import type { T } from '../settings/quality-management/labels';

/** The number shown beside the menu item: stages I own plus approvals waiting for me (running cycles only). */
export function useMyWork(apis: CycleApis = {}, enabled = true) {
  const api = useCyclesApi(apis.cycles);
  return useQuery({ queryKey: ['my-work'], queryFn: () => api.myWork(), enabled, staleTime: 30_000 });
}

/** My in-app notifications (TASK-088); an empty list for a person who cannot read evidence, and when they cannot be loaded. */
export function useMyNotifications(apis: CycleApis = {}, enabled = true) {
  const api = useEvidenceApi(apis.evidence);
  return useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications(), enabled, staleTime: 30_000, retry: false });
}

/** The open collection runs (pending or late) of the evidence items I own (TASK-090); an empty list for a person who cannot read evidence. */
export function useMyRuns(apis: CycleApis = {}, enabled = true) {
  const api = useEvidenceApi(apis.evidence);
  return useQuery({ queryKey: ['collection-runs', 'mine'], queryFn: () => api.collectionRuns({ mine: true, status: 'pending,late' }), enabled, staleTime: 30_000, retry: false });
}

export function MyWorkTab({ apis = {} }: { apis?: CycleApis }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const q = useMyWork(apis);
  const me = useMe(useSettingsApi(apis.settings));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const evidence = useEvidenceApi(apis.evidence);
  const notes = useMyNotifications(apis, can(me.data, 'evidence:read'));
  const [starting, setStarting] = useState<DueRun | null>(null);
  const [resubmitting, setResubmitting] = useState<EvidenceLink | null>(null);
  const [noteError, setNoteError] = useState('');
  const myRuns = useMyRuns(apis, can(me.data, 'evidence:read'));
  const runs = myRuns.data ?? [];
  const notices = notes.data ?? [];
  const refreshNotices = () => { void qc.invalidateQueries({ queryKey: ['notifications'] }); };
  const actOn = (fn: () => Promise<unknown>) => { setNoteError(''); fn().then(refreshNotices, (e: Error) => setNoteError(e.message)); };
  const statuses = stageStatusLabels(t);
  if (q.isError) return <p role="alert" className="text-sm text-red-700">{(q.error as Error).message}</p>;
  if (!q.data) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  const { stages, approvals, dueRuns } = q.data;
  return (
    <div className="space-y-6">
      <p className="max-w-prose text-sm text-muted-foreground">{t('qmc.my.intro')}</p>
      {stages.length === 0 && approvals.length === 0 && dueRuns.length === 0 && notices.length === 0 && runs.length === 0 && <p className="rounded-lg border border-dashed border-border p-5 text-sm" data-testid="my-work-empty">{t('qmc.my.empty')}</p>}

      {notices.length > 0 && (
        <section aria-label={t('qmc.my.notifications')} className="space-y-2">
          <h2 className="text-base font-semibold">{t('qmc.my.notifications')}</h2>
          {noteError && <p role="alert" className="text-sm text-red-700">{noteError}</p>}
          <ul className="space-y-2">
            {notices.map((n) => (
              <li key={n.id} data-testid="my-notification" data-unread={!n.readAt} className="space-y-1 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <p className="min-w-0 flex-1 break-words text-sm" dir="auto"><ContentText>{n.body}</ContentText></p>
                  {!n.readAt && <Chip tone="info" testId="notification-new">{t('qmc.my.new')}</Chip>}
                </div>
                <p className="text-xs text-muted-foreground">{formatDate(n.createdAt)}</p>
                <div className="flex flex-wrap gap-2">
                  {n.run && <Link to="/evidence" search={{ item: n.run.evidenceItemId }} className="inline-flex items-center rounded-md border border-border px-3 py-1 text-sm underline-offset-2 hover:underline" aria-label={t('coll.notice.openNamed', { title: n.run.evidenceTitle })}>{t('coll.my.open')}</Link>}
                  {n.kind === 'link_rejected' && n.link?.reviewStatus === 'rejected' && (
                    <Button type="button" variant="outline" className="px-3 py-1" aria-label={t('qmc.my.resubmitNamed', { title: n.link.evidenceTitle })} onClick={() => setResubmitting(n.link)}>{t('qmc.my.resubmit')}</Button>
                  )}
                  {!n.readAt && <Button type="button" variant="ghost" className="px-3 py-1" onClick={() => actOn(() => evidence.markNotificationRead(n.id))}>{t('qmc.my.markRead')}</Button>}
                  <Button type="button" variant="ghost" className="px-3 py-1" aria-label={t('qmc.my.dismissNamed', { text: n.link?.evidenceTitle ?? n.title })} onClick={() => actOn(() => evidence.dismissNotification(n.id))}>{t('qmc.my.dismiss')}</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {runs.length > 0 && (
        <section aria-label={t('coll.my.title')} className="space-y-2" data-testid="my-evidence-runs">
          <h2 className="text-base font-semibold">{t('coll.my.title')}</h2>
          <ul className="space-y-2">
            {runs.map((r) => (
              <li key={r.id} data-testid="my-evidence-run" data-status={r.status} className="flex flex-wrap items-start gap-2 rounded-lg border border-border p-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="break-words text-base font-medium" dir="auto">{t('coll.my.supply', { title: r.evidenceTitle, period: r.periodLabel })}</p>
                  <p className="break-words text-sm text-muted-foreground">{t('coll.due', { date: day(r.dueDate) })}</p>
                </div>
                <RunStatusChip run={r} />
                <Link to="/evidence" search={{ item: r.evidenceItemId }} className="inline-flex items-center rounded-md border border-border px-3 py-1 text-sm underline-offset-2 hover:underline" aria-label={t('coll.my.openNamed', { title: r.evidenceTitle })}>{t('coll.my.open')}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dueRuns.length > 0 && (
        <section aria-label={t('qmc.my.due')} className="space-y-2">
          <h2 className="text-base font-semibold">{t('qmc.my.due')}</h2>
          <ul className="space-y-2">
            {dueRuns.map((r) => (
              <li key={`${r.planId}|${r.periodStart}`} data-testid="my-due-run" className="flex flex-wrap items-start gap-2 rounded-lg border border-border p-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="break-words text-base font-medium" dir="auto"><ContentText>{r.templateName}</ContentText> · <ContentText>{r.periodLabel}</ContentText></p>
                  <p className="break-words text-sm text-muted-foreground"><ContentText>{r.subjectName ?? r.anchorName ?? ''}</ContentText> · {day(r.periodStart)}{r.periodEnd ? ` – ${day(r.periodEnd)}` : ''}</p>
                </div>
                <Chip tone="warn" testId="due-state">{t('plans.state.due')}</Chip>
                <Button type="button" variant="outline" className="px-3 py-1" aria-label={t('qmc.my.startNamed', { name: `${r.templateName} ${r.periodLabel}` })} onClick={() => setStarting(r)}>{t('qmc.my.start')}</Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {approvals.length > 0 && (
        <section aria-label={t('qmc.my.approvals')} className="space-y-2">
          <h2 className="text-base font-semibold">{t('qmc.my.approvals')}</h2>
          <ul className="space-y-2">
            {approvals.map((a) => (
              <li key={a.outputId} data-testid="my-approval" className="space-y-1 rounded-lg border border-border p-3">
                <Link to="/quality-management/cycles/$id" params={{ id: a.cycleId }} search={{ stage: a.stageId }} className="break-words text-base font-medium underline-offset-2 hover:underline" dir="auto">{a.outputName}</Link>
                <p className="break-words text-sm text-muted-foreground"><ContentText>{a.cycleTitle}</ContentText> · <ContentText>{a.stageName}</ContentText></p>
                {a.returnedBefore && <Chip tone="warn">{t('qmc.my.returnedBefore')}</Chip>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {stages.length > 0 && (
        <section aria-label={t('qmc.my.stages')} className="space-y-2">
          <h2 className="text-base font-semibold">{t('qmc.my.stages')}</h2>
          <ul className="space-y-2">
            {stages.map((s) => (
              <li key={s.stageId} data-testid="my-stage" data-late={s.late} className="space-y-1 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <Link to="/quality-management/cycles/$id" params={{ id: s.cycleId }} search={{ stage: s.stageId }} className="min-w-0 flex-1 break-words text-base font-medium underline-offset-2 hover:underline" dir="auto">{s.stageName}</Link>
                  <div className="flex flex-wrap items-center gap-1">
                    <Chip tone={s.status === 'in_progress' ? 'info' : 'neutral'}>{statuses[s.status]}</Chip>
                    {s.late && <Chip tone="bad" testId="my-late">{t('qmc.late')}</Chip>}
                  </div>
                </div>
                <p className="break-words text-sm text-muted-foreground"><ContentText>{s.cycleTitle}</ContentText></p>
                <p className="text-sm text-muted-foreground">
                  {s.endDate ? t('qmc.next.due', { date: day(s.endDate) }) : t('qmc.noDate')}
                  {(s.missingInputs > 0 || s.missingOutputs > 0) && <> · {t('qmc.my.missing', { inputs: s.missingInputs, outputs: s.missingOutputs })}</>}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {resubmitting && (
        <ResubmitLinkDialog link={resubmitting} onClose={() => setResubmitting(null)}
          onResubmit={(rationale) => evidence.resubmit(resubmitting.id, { rationale }).then(refreshNotices)} />
      )}
      {starting && (
        <LaunchCycleDialog key={`${starting.planId}|${starting.periodStart}`} proposal={starting} me={me.data} apis={apis} onClose={() => setStarting(null)}
          onOpen={(id) => { void navigate({ to: '/quality-management/cycles/$id', params: { id } }); }} />
      )}
    </div>
  );
}
