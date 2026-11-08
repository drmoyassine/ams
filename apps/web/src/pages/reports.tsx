import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AccordionCard } from '../components/accordion';
import { CourseReport } from '../components/course-report';
import { PageHeader } from '../components/page-header';
import { useTranslation } from '../i18n';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';

/** The reports the AMS can generate. Each draws on the values of KPIs; add a report here and give it a body below. */
export const REPORTS = [
  { id: 'course', title: 'Course Report', subtitle: 'One course and term, made from the KPIs whose scope is Course' },
] as const;
type ReportId = (typeof REPORTS)[number]['id'];

/** The root Reports page: a card for each report; a card opens the report as a page of its own. Reports are not evidence. */
export function ReportsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <section className="space-y-4">
      <PageHeader title={t('nav.reports')} intro="A report is not evidence: it draws on the values of KPIs for a scope and a period, and adds the instructor’s or the program’s own analysis." />
      <ul className="space-y-2" aria-label="Reports">
        {REPORTS.map((r) => (
          <li key={r.id}>
            <AccordionCard label={`Report: ${r.title}`} title={r.title} strong subtitle={r.subtitle} open={false} menuLabel={`Actions for ${r.title}`} menu={[]}
              onToggle={() => { void navigate({ to: '/reports/type/$id', params: { id: r.id } }); }} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One report as a full page. Its filters (the dropdowns) are inside the report. */
export function ReportViewPage({ id, api: override }: { id: string; api?: EvidenceApi }) {
  const api = useEvidenceApi(override);
  const report = REPORTS.find((r) => r.id === id);
  const list = useQuery({ queryKey: ['evidence', '', 'with-archived'], queryFn: () => api.list(undefined, { includeArchived: true }), enabled: !!report });
  const bodies: Record<ReportId, () => React.ReactNode> = { course: () => (list.data ? <CourseReport api={api} items={list.data} /> : <p className="text-sm">Loading…</p>) };
  return (
    <section className="space-y-4">
      <Link to="/reports" className="inline-block text-sm text-muted-foreground underline-offset-2 hover:underline">← Reports</Link>
      {report
        ? (<><PageHeader title={report.title} intro={report.subtitle} />{bodies[report.id]()}</>)
        : <PageHeader title="Report not found" intro="There is no such report." />}
    </section>
  );
}
