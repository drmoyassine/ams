// The engagement's Reports tab (TASK-092): the reports made for this engagement, newest first, each opening the report
// page; "Add a report" makes one from a reviewed template of the engagement's framework edition (the round the
// milestone asks for arrives with the workflow, TASK-094). Managers create; everyone with report:read sees the list.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { EngagementDetail } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Chip } from '../../components/cycles/labels';
import { useTranslation } from '../../i18n';
import { frameworkApi, type FrameworkApi } from '../../lib/framework-api';
import { reportApi, useReportApi, type ReportApi } from '../../lib/report-api';
import { useAction } from '../../lib/use-action';

const STATUS_TONE = { draft: 'neutral', internally_approved: 'info', submitted: 'good' } as const;

export function ReportsTab({ detail, canManage, api: reportOverride, framework }: {
  detail: EngagementDetail; canManage: boolean; api?: ReportApi; framework?: FrameworkApi;
}) {
  const { t } = useTranslation();
  const api = useReportApi(reportOverride);
  const fw = framework ?? frameworkApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['reports', 'engagement', detail.engagement.id], queryFn: () => api.list({ engagementId: detail.engagement.id }) });
  const list = q.data ?? [];

  return (
    <div className="space-y-3" data-testid="reports-tab">
      <div className="flex flex-wrap items-center gap-2">
        {canManage && (
          <Button type="button" onClick={() => setCreating(true)} data-testid="add-report">{t('rep.addReport')}</Button>
        )}
      </div>
      {q.isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {!q.isLoading && list.length === 0 && <p className="text-sm text-muted-foreground" data-testid="no-reports">{t('rep.noReports')}</p>}
      <ul className="space-y-2">
        {list.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3" data-testid="report-card">
            <Link to="/reports/$id" params={{ id: r.id }} className="min-w-0 flex-1 break-words text-sm font-medium underline" dir="auto" data-testid="report-link">{r.title}</Link>
            <Chip tone={STATUS_TONE[r.status]} testId={`report-status-${r.id}`}>{t(`rep.status.${r.status}`)}</Chip>
            <span className="text-xs text-muted-foreground" data-testid={`report-progress-${r.id}`}>{t('rep.approvedOf', { approved: r.approvedSections, count: r.sectionCount })}</span>
          </li>
        ))}
      </ul>
      {creating && (
        <CreateReportDialog detail={detail} fw={fw} api={api} onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); void qc.invalidateQueries({ queryKey: ['reports'] }); void navigate({ to: '/reports/$id', params: { id } }); }} />
      )}
    </div>
  );
}

function CreateReportDialog({ detail, fw, api, onClose, onCreated }: {
  detail: EngagementDetail; fw: ReturnType<typeof frameworkApi>; api: ReturnType<typeof reportApi>;
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const templates = useQuery({ queryKey: ['report-templates', detail.engagement.frameworkVersionId], queryFn: () => fw.templates(detail.engagement.frameworkVersionId) });
  const usable = (templates.data ?? []).filter((x) => x.reviewStatus === 'approved');

  const create = async () => {
    setBusy(true); setError(null);
    const r = await act(() => api.create({
      frameworkVersionId: detail.engagement.frameworkVersionId, templateKey: key,
      engagementId: detail.engagement.id, ...(title.trim() ? { title: title.trim() } : {}),
    }));
    setBusy(false);
    if (r) onCreated(r.id);
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="create-report">
      <h2 className="text-base font-semibold">{t('rep.createTitle')}</h2>
      <p className="text-sm text-muted-foreground">{t('rep.createIntro')}</p>
      {templates.isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {templates.isSuccess && usable.length === 0 && <p className="text-sm text-muted-foreground" data-testid="no-templates">{t('rep.noTemplates')}</p>}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('rep.templateLabel')}</span>
        <select aria-label={t('rep.templateLabel')} value={key} onChange={(e) => setKey(e.target.value)} data-testid="template-select"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm">
          <option value="">—</option>
          {usable.map((x) => <option key={x.key} value={x.key} dir="auto">{x.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('rep.reportNameOptional')}</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('rep.reportNameOptional')} dir="auto" data-testid="create-title" />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!key || busy} onClick={() => void create()} data-testid="create-go">{t('rep.createGo')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </div>
    </div>
  );
}
