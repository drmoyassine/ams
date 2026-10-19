// Quality Management -> My work (TASK-080): the stages I own in running cycles and the approvals waiting for my decision, with due dates
// and late flags, each linking to the stage on its cycle page. A person with no stage and no approval sees that there is nothing for them.
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ContentText } from '../../components/content-text';
import type { CycleApis } from '../../components/cycles/directory';
import { Chip, day, stageStatusLabels } from '../../components/cycles/labels';
import { useTranslation } from '../../i18n';
import { useCyclesApi } from '../../lib/cycles-api';
import type { T } from '../settings/quality-management/labels';

/** The number shown beside the menu item: stages I own plus approvals waiting for me (running cycles only). */
export function useMyWork(apis: CycleApis = {}, enabled = true) {
  const api = useCyclesApi(apis.cycles);
  return useQuery({ queryKey: ['my-work'], queryFn: () => api.myWork(), enabled, staleTime: 30_000 });
}

export function MyWorkTab({ apis = {} }: { apis?: CycleApis }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const q = useMyWork(apis);
  const statuses = stageStatusLabels(t);
  if (q.isError) return <p role="alert" className="text-sm text-red-700">{(q.error as Error).message}</p>;
  if (!q.data) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  const { stages, approvals } = q.data;
  return (
    <div className="space-y-6">
      <p className="max-w-prose text-sm text-muted-foreground">{t('qmc.my.intro')}</p>
      {stages.length === 0 && approvals.length === 0 && <p className="rounded-lg border border-dashed border-border p-5 text-sm" data-testid="my-work-empty">{t('qmc.my.empty')}</p>}

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
    </div>
  );
}
