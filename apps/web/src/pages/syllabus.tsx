// A course's syllabus (DEC-042): a report generated from the course's approved content in the institution's syllabus layout, or a preview of
// its draft. Nothing is edited here: the course page holds the content (Course content), its draft and its approval.
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { syllabusToWorkbook } from '@ams/shared';
import type { CycleApis } from '../components/cycles/directory';
import { Breadcrumb } from '../components/breadcrumb';
import { PageHeader } from '../components/page-header';
import { SyllabusView } from '../components/syllabus/syllabus-view';
import { Button } from '../components/ui/button';
import { download } from '../lib/sheet-io';
import { writeSyllabusWorkbook } from '../lib/syllabus-sheets';
import { useSyllabusApi, type SyllabusApi } from '../lib/syllabus-api';
import { useUrlState } from '../lib/url-state';

export function SyllabusPage({ courseId, api: override }: { courseId: string; api?: SyllabusApi; apis?: CycleApis }) {
  const api = useSyllabusApi(override);
  const q = useQuery({ queryKey: ['syllabus', courseId], queryFn: () => api.overview(courseId) });
  // ?version=draft previews the draft in progress; the approved content is the syllabus.
  const [which, setWhich] = useUrlState<'approved' | 'draft'>('version', 'approved', ['approved', 'draft']);
  const ov = q.data;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">Could not load the syllabus.</p>;
  if (!ov) return <p className="text-sm">Loading…</p>;
  const draft = ov.open;
  const shown = which === 'draft' && draft ? draft : ov.current;
  const coursePage = `/settings/courses/${courseId}`;
  return (
    <section className="space-y-4">
      <div className="print:hidden">
        <Breadcrumb items={[{ label: 'Settings', href: '/settings' }, { label: 'Courses', href: '/settings/courses' }, { label: ov.course.code, href: coursePage }, { label: 'Syllabus' }]} />
      </div>
      <PageHeader title={`${ov.course.code} · ${ov.course.titleEn}`}
        intro={`Syllabus${shown ? ` · version ${shown.versionNo}${shown.status === 'approved' ? ', approved' : `, ${shown.status.replace('_', ' ')} (not yet approved)`}` : ''}${ov.course.unitName ? ` · ${ov.course.unitName}` : ''}${ov.course.coordinatorName ? ` · Coordinator: ${ov.course.coordinatorName}` : ''}`}
        action={shown ? (
          <span className="flex flex-wrap gap-2 print:hidden">
            <Button type="button" variant="outline" onClick={() => window.print()}>Print or save as PDF</Button>
            <Button type="button" variant="outline" onClick={() => void writeSyllabusWorkbook(syllabusToWorkbook(shown.content, { code: ov.course.code, levels: ov.levels, plos: ov.plos, courses: ov.courses, customSections: ov.template.sections.filter((x) => x.key.startsWith('custom:')).map((x) => ({ key: x.key, title: x.title })) })).then((b) => download(b, `${ov.course.code} syllabus.xlsx`))}>Download (Excel)</Button>
          </span>
        ) : undefined} />
      <div className="flex flex-wrap items-center gap-2 text-sm print:hidden">
        {draft && ov.current && (
          <div role="tablist" aria-label="Which version" className="flex gap-1">
            {([['approved', `Approved (v${ov.current.versionNo})`], ['draft', `Draft (v${draft.versionNo})`]] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={which === id} onClick={() => setWhich(id)} className={`rounded-md px-3 py-1 ${which === id ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>{label}</button>
            ))}
          </div>
        )}
        {shown && shown.status !== 'approved' && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Preview: this version is not approved</span>}
        <Link to="/settings/courses/$courseId" params={{ courseId }} className="ms-auto underline-offset-2 hover:underline">Edit the course content</Link>
      </div>
      {shown
        ? <SyllabusView content={shown.content} code={ov.course.code} plos={ov.plos} levels={ov.levels} courses={ov.courses} template={ov.template} />
        : <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">This course has no content yet, so there is no syllabus to show. Add it on the course page.</p>}
    </section>
  );
}
