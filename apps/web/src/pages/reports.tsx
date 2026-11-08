import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AccordionCard } from '../components/accordion';
import { CourseReport } from '../components/course-report';
import { PageHeader } from '../components/page-header';
import { useTranslation } from '../i18n';
import { useEvidenceApi, type EvidenceApi } from '../lib/evidence-api';

/** Reports are not evidence: they draw on the values of KPIs for a scope and a period. Each report is a card of the same kind as the evidence list; opening one generates it. */
export function ReportsPage({ api: override }: { api?: EvidenceApi }) {
  const { t } = useTranslation();
  const api = useEvidenceApi(override);
  const [open, setOpen] = useState(true);
  const list = useQuery({ queryKey: ['evidence', '', 'with-archived'], queryFn: () => api.list(undefined, { includeArchived: true }) });
  return (
    <section className="space-y-4">
      <PageHeader title={t('nav.reports')} intro="A report is not evidence: it draws on the values of KPIs for a scope and a period, and adds the instructor’s or the program’s own analysis." />
      <div className="space-y-2" role="list" aria-label="Reports">
        <div role="listitem">
          <AccordionCard label="Report: Course Report" title="Course Report" strong open={open} onToggle={() => setOpen(!open)} menuLabel="Actions for Course Report" menu={[]}
            subtitle="One course and term, made from the KPIs whose scope is Course">
            {list.data ? <CourseReport api={api} items={list.data} /> : <p className="text-sm">Loading…</p>}
          </AccordionCard>
        </div>
      </div>
    </section>
  );
}
