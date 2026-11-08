import { useQuery } from '@tanstack/react-query';
import { CourseReport } from '../components/course-report';
import { useTranslation } from '../i18n';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';

/** Reports are not evidence: they draw on the values of KPIs for a scope and a period. The Course Report is made for one course and term. */
export function ReportsPage({ api: override }: { api?: EvidenceApi }) {
  const { t } = useTranslation();
  const api = useEvidenceApi(override);
  const list = useQuery({ queryKey: ['evidence', '', 'with-archived'], queryFn: () => api.list(undefined, { includeArchived: true }) });
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold sm:text-2xl">{t('nav.reports')}</h1>
      <p className="text-sm text-muted-foreground">A report is not evidence: it draws on the values of KPIs for a scope and a period, and adds the instructor’s or the program’s own analysis.</p>
      <h2 className="text-lg font-semibold">Course Report</h2>
      {list.data ? <CourseReport api={api} items={list.data} /> : <p className="text-sm">Loading…</p>}
    </section>
  );
}
