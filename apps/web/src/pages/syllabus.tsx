// A course's syllabus (DEC-038): the approved version in the AIU layout, or, for the coordinator, the editor with the rules checked live;
// the workflow (submit, endorse, approve, return), suggestions, staff and versions around it. Rules never stop you typing or saving; they
// flag. Only submitting for review waits for the errors to be fixed.
import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { checkSyllabus, errorsOf, syllabusToWorkbook, type SyllabusContent } from '@ams/shared';
import { confirmDialog } from '../components/confirm-dialog';
import type { CycleApis } from '../components/cycles/directory';
import { PageHeader } from '../components/page-header';
import { SyllabusEditor } from '../components/syllabus/syllabus-editor';
import { FlagBanner, HistoryList, StaffPanel, SuggestionsPanel, WorkflowBar } from '../components/syllabus/syllabus-panels';
import { SyllabusView } from '../components/syllabus/syllabus-view';
import { download } from '../lib/sheet-io';
import { writeSyllabusWorkbook } from '../lib/syllabus-sheets';
import { Button } from '../components/ui/button';
import { errorText } from '../components/evidence-item-form';
import { useSyllabusApi, type SyllabusApi } from '../lib/syllabus-api';

export function SyllabusPage({ courseId, api: override, apis }: { courseId: string; api?: SyllabusApi; apis?: CycleApis }) {
  const api = useSyllabusApi(override);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['syllabus', courseId], queryFn: () => api.overview(courseId) });
  const [draft, setDraft] = useState<SyllabusContent | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const ov = q.data;
  const open = ov?.open ?? null;
  // The draft in progress seeds the editor whenever the server's copy changes and nothing unsaved is held here.
  useEffect(() => { if (ov && !dirty) setDraft(open && open.status === 'draft' ? open.content : null); }, [ov, open, dirty]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['syllabus', courseId] });
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => { setError(''); await fn(); },
    onSuccess: async () => { setDirty(false); await refresh(); },
    onError: (e) => setError(errorText(e)),
  });
  const ctx = useMemo(() => (ov ? {
    settings: ov.settings, levels: ov.levels, allowedPloIds: new Set(ov.plos.map((p) => p.id)), programCount: ov.course.programIds.length, optional: new Set(ov.template.optional), knownCourseIds: new Set(ov.courses.map((c) => c.id)),
  } : null), [ov]);
  const live = useMemo(() => (draft && ctx ? checkSyllabus(draft, ctx) : []), [draft, ctx]);

  if (q.isError) return <p role="alert" className="text-sm text-red-700">Could not load the syllabus.</p>;
  if (!ov) return <p className="text-sm">Loading…</p>;
  const editing = ov.can.edit && draft !== null;
  const shown = open ?? ov.current;
  const flaggedVersion = open ?? ov.current;
  const errors = editing ? errorsOf(live).length : flaggedVersion?.errorCount ?? 0;
  const save = async () => api.save(courseId, { content: draft! });
  const startFromCourse = async () => { setDraft(await api.starting(courseId)); setDirty(true); };
  const busy = act.isPending;

  return (
    <section className="space-y-4">
      <Link to="/quality-management" search={{ tab: 'syllabi' }} className="inline-block text-sm text-muted-foreground underline-offset-2 hover:underline">← Syllabi</Link>
      <PageHeader title={`${ov.course.code} · ${ov.course.titleEn}`} intro={`Course syllabus${ov.course.unitName ? ` · ${ov.course.unitName}` : ''}${ov.course.credits !== null ? ` · ${ov.course.credits} credits` : ''}. Coordinator: ${ov.course.coordinatorName ?? 'not named'}.`}
        action={shown ? (
          <span className="flex flex-wrap gap-2 print:hidden">
            <Button type="button" variant="outline" onClick={() => void writeSyllabusWorkbook(syllabusToWorkbook((editing ? draft : shown.content)!, { code: ov.course.code, levels: ov.levels, plos: ov.plos, courses: ov.courses, customSections: ov.template.sections.filter((x) => x.key.startsWith('custom:')) })).then((b) => download(b, `${ov.course.code} syllabus.xlsx`))}>Export to Excel</Button>
            {!editing && <Button type="button" variant="outline" onClick={() => window.print()}>Print or save as PDF</Button>}
          </span>
        ) : undefined} />
      <FlagBanner version={flaggedVersion} errors={errors} />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <WorkflowBar overview={ov} version={open ?? ov.current} editing={editing} dirty={dirty} errors={errors} busy={busy}
        onSave={() => act.mutate(async () => { await save(); })}
        onSubmit={() => act.mutate(async () => { const v = dirty ? await save() : open!; await api.submit(v.id); setDraft(null); })}
        onDiscard={() => void confirmDialog({ title: 'Discard this draft?', confirmLabel: 'Discard', tone: 'danger', message: 'The draft is deleted. The approved version, if there is one, stays.' }).then((ok) => { if (ok) act.mutate(async () => { await api.discard(courseId); setDraft(null); }); })}
        onEndorse={() => act.mutate(async () => { await api.endorse(open!.id); })}
        onReturn={(note) => act.mutate(async () => { await api.return(open!.id, note); })}
        onApprove={(term) => act.mutate(async () => { await api.approve(open!.id, term); })}
        onNewVersion={() => act.mutate(async () => { await api.save(courseId, { content: ov.current!.content, source: 'new version' }); })} />

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          {editing
            ? <SyllabusEditor content={draft!} onChange={(c) => { setDraft(c); setDirty(true); }} plos={ov.plos} levels={ov.levels} courses={ov.courses} courseId={courseId} code={ov.course.code} issues={live} settings={ov.settings} template={ov.template} />
            : shown
              ? <SyllabusView content={shown.content} code={ov.course.code} plos={ov.plos} levels={ov.levels} courses={ov.courses} template={ov.template} />
              : (
                <div className="space-y-2 rounded-lg border border-dashed border-border p-6 text-center">
                  <p className="text-sm text-muted-foreground">This course has no syllabus yet.</p>
                  {ov.can.edit && <Button type="button" onClick={() => void startFromCourse()}>Start the syllabus from the course</Button>}
                </div>
              )}
        </div>
        <aside className="space-y-3 print:hidden">
          <SuggestionsPanel overview={ov} version={open} busy={busy}
            onSuggest={(section, suggestion) => act.mutate(async () => { await api.suggest(open!.id, { section, suggestion }); })}
            onResolve={(s, decision) => act.mutate(async () => { await api.resolve(s.id, { decision }); })} />
          <StaffPanel key={`${ov.course.coordinatorUserId}-${ov.course.instructors.length}`} overview={ov} busy={busy} apis={apis} onSave={(coordinatorUserId, instructorIds) => act.mutate(async () => { await api.setStaff(courseId, { coordinatorUserId, instructorIds }); })} />
          <HistoryList overview={ov} />
        </aside>
      </div>
    </section>
  );
}
